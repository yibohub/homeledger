# AGENTS.md

ZCode 及其他编码代理在本仓库的工作指引（自动加载）。本文件是**规则层入口**：只放"必须/禁止"短句与指针，
完整知识按需 Read，不在此复制——细节下沉文档层、规则上浮规则层，两层靠引用链串联。

## 必读地图（按此顺序）

1. 本文件 —— 项目概述 / 常用命令 / 架构要点 / 必须禁止短句
2. `docs/BOARD.md` —— **看板（执行视图）**：做到哪、下一步、什么押后了——回答「下一步」先看这里
3. `docs/README.md` —— 导航层：按任务场景找规则与方案
4. `docs/collaboration.md` —— 协作规则全文（环境基线 / 发版 / 批次流程 / 操作纪律）
5. `docs/ai-roadmap.md` —— AI 能力路线图 P1–P10（含当前进度与开放问题）
6. `docs/solutions/` —— 踩坑根因与方案（新踩坑先查这里）

## 项目概述

**家账簿 HomeLedger** —— 自托管家庭记账系统（sucraft-hub/homeledger 的 fork，yibohub 维护）。
纯后端 SSR：Express + EJS + SQLite（**Node ≥ 22.5 内置 `node:sqlite`**），运行时依赖仅 3 个，
零前端框架（原生 JS 渐进增强）。核心能力：全类型记账、预算/订阅/借贷、AI 截图/文本自动记账
（双引擎：OpenAI 兼容模型 + 规则兜底，含习惯记忆）、开放 API（Bearer 令牌，对接 Hermes/OpenClaw）。

## 常用命令

```bash
npm start                            # 起服务 :5111（数据 ./data；plain node 无 --watch，改码需重启）
npm run dev                          # --watch 模式
node test/run-all.js                 # 全量回归：10 套件，各自起独立实例 :8099（跑前确保 8099 无残留）
node test/selfcheck-static.js        # 静态自检
DATA_DIR=./data-demo node scripts/seed-demo.js   # 演示数据（独立目录，不碰真实数据）
```

## 架构要点（改码前 30 秒版）

- `server.js` 入口：会话（SQLite store）/ CSRF / 零依赖布局机制（res.render 两段渲染）/ 路由挂载；
  **openapi 挂在 CSRF 之前**（Bearer 不走会话），改中间件顺序勿动这条
- `src/db.js` 数据层：23 表、预编译语句缓存、可重入事务 `tx()`、余额重算引擎、`reopenDatabase`（备份热切换）
- `src/lib/`：auth（scrypt/限流双键/RBAC/审计/通知）、ai（双引擎识别 + 习惯记忆 + 臆造核验，见 solutions）、
  txn（记账核心，软删除）、subscriptions（月末锚点/2-29 钳制，改前读注释）、scheduler（每日 + 30 分钟兜底）
- `src/routes/openapi.js`：Bearer 令牌只存摘要、权限分层、分令牌频控、全量审计——安全语义勿放松
- `public/js/`：原生 JS 渐进增强，服务端数据进 DOM 一律过 `esc()`；静态资源缓存戳 = 版本+mtime
- **版本三件套**：发版必须同步 `package.json` + `src/lib/about.js` CHANGELOG + `README.md` 更新记录

## 必须 / 禁止（短句）

**Git 与发版**
- 标签 = 发版：**只在维护者明确要求时**打/推 tag（触发 CI 构建发布 GHCR 镜像）；发镜像、改包可见性、NAS 切镜像逐项确认
- git 网络操作一律走 SSH（HTTPS 直连常被重置）；已推送的 main 历史不重写
- 功能提交走 分支 → PR → 独立审查 → 修复 P1 → 合并；纯文档小改可直推 main
- 提交信息中文：发版 `vX.Y.Z: 要点`，过程提交 `docs:` / `fix:` / `feat:` / `test:` 前缀

**质量**
- 每个功能配 `test/verify-*.js` 套件并登记 `run-all.js`；**全量 9 套件全绿才算完成**（Windows 本地也要绿）
- 数字靠统计（SQL）、语言靠模型：模型不做任何算术；AI 产出必须可溯源（原文依据或习惯统计），标注如实
- 出网内容仅限账单原文 + 分类/账户名称清单 + 聚合值，不发完整流水；无 AI Key 时功能必须有降级路径

**操作纪律**
- **严禁 taskkill 全部 node.exe**（会杀用户的 5111 实例）；按端口/PID 精确清理
- 不直接修改用户真实账目数据（`data/homeledger.db`）；只建议或经确认后代做
- 改完服务端代码重启 5111（无 watch）并告知；测试调试只用隔离 `DATA_DIR` 实例，临时 8099 实例用完即清
- Windows 下删除数据目录前先停持有它的进程（文件锁）

---
指针：协作细则见 `docs/collaboration.md`；路线图与开放问题见 `docs/ai-roadmap.md`；踩坑见 `docs/solutions/`
