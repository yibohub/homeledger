# Windows 测试基建三坑（docs/solutions/windows-test-infra.md）

> 现象 → 根因 → 方案。CI（Linux）上从不复现，Windows 本地开发必踩；修法已落在 `test/run-all.js` 与两个进程内套件。

## 坑一：跑批失败在套件间随机漂移（端口释放竞态）

**现象**：`run-all.js` 全量跑批时，同一套件忽绿忽红，且失败的套件每次不同（曾出现 attachments 2→4 失败、subscriptions 突然挂 1 个——该套件代码根本没动过）。

**根因**：`server.js` 收到 SIGTERM 后走优雅关闭（`server.close()` 最多等 3 秒），而 run-all 杀完旧实例只 `setTimeout 500ms` 就起下一个。新实例 `EADDRINUSE` 直接崩掉，但 `healthz` 探测会命中**还活着的旧实例**——套件于是对着上一个套件的数据跑：HTTP 打旧库、直连 `db` 的种子写新库，两边都对不上，失败自然漂移。

**方案**（`test/run-all.js`）：
- `waitPortFree()`：以「healthz 连接失败」判定端口空闲，代替固定 sleep；探测请求必须带 2 秒超时——半死实例（accept 后不响应）没有默认超时，promise 永不 settle 会卡死整个跑批
- 起跑前（第一个套件 spawn 之前）也调用一次：上次跑批崩溃残留的实例同样会让第一个套件串数据

**教训**：.healthz 探到 200 ≠ 探到的是**这次**起的实例。

## 坑二：套件断言全过却报 RED（退出断言崩溃）

**现象**：`verify-model-list.js` / `verify-ai-image.js` 打印「N 通过 / 0 失败」后进程仍以非零码退出，stderr 有 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c`。

**根因**：Node on Windows 的已知问题——`fetch`（undici）的 keep-alive 连接还在连接池里时调用 `process.exit()`，会触发 libuv 断言崩溃。是否复现取决于最后一个响应结束后连接恰处于什么状态，因此**偶发**（实测同一份代码 5 跑 4 崩，基线与改动版无差别）。

**方案**：两个进程内套件不用 `process.exit()`，改为 `process.exitCode = fail ? 1 : 0` 让进程自然退出——服务器 keep-alive 超时（约 5 秒）后排空连接、事件循环清空、带着 exitCode 干净退出。代价是每个套件多等几秒，换来确定性。8 连跑验证 16/16 干净。

**教训**：偶发 ≠ 玄学；先在同一环境跑基线对比确认是否既有问题，再定性。

## 坑三：数据目录 rm 掉不掉（文件锁）

**现象**：`rm -rf data-verify-*` 报 `Device or resource busy`。

**根因**：有进程仍持有该目录下的 SQLite 文件（多半是没退干净的调试实例）。

**方案与纪律**：先 `netstat -ano | grep :8099` 找 PID、`taskkill //PID <pid> //F`，再删目录。**严禁 `taskkill //F //IM node.exe` 一网打尽**——用户的 5111 开发实例会一起被杀（真实发生过，需重启并向用户说明）。

## 防回归

- `run-all.js` 的 `waitPortFree` 已覆盖「套件间」与「起跑前」两端；半死实例场景由探测超时兜底
- 任何新套件一律走 run-all 跑批验证，不允许绕过端口纪律手工只跑单个套件就宣称全绿
- 相关规则短句见 `AGENTS.md` §操作纪律；姊妹篇见 [ai-invented-account.md](ai-invented-account.md)
