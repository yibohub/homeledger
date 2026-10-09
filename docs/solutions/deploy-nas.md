# NAS 部署运维（docs/solutions/deploy-nas.md）

> 现象 → 根因 → 方案。起步篇：先沉淀实际踩到的坑（语音 not-allowed），容器管理器/镜像源切换/
> ZeroTier 组网等内容后续按需补齐（对应看板待办「deploy-nas 知识沉淀」逐步落盘）。

## 坑一：部署后点麦克风提示「语音识别失败（not-allowed）」（2026-10-09，v1.10.0 实测）

**现象**：群晖部署后，悬浮球 / 极简捕获区点话筒，提示「语音识别失败（not-allowed），可以直接输入」。

**根因**：Web Speech API（`SpeechRecognition`）只在**安全上下文**（HTTPS 或 localhost）可用。
NAS 通过 `http://<NAS-IP>:5111`（局域网 / ZeroTier IP）访问是普通 HTTP，浏览器直接拒绝
麦克风类 API——报错名就叫 `not-allowed`。**不是识别坏了，是 API 起不来**。同理受影响的还有
`getUserMedia` 等一切需要权限的浏览器能力。

**方案（三选一）**：

1. **DSM 反向代理 + 自签证书（推荐，纯本地）**
   - 控制面板 → 证书 → 新增 →「创建自签名证书」（域名可留空或填 NAS 主机名）
   - 控制面板 → 登录门户 → 高级 → 反向代理：来源 `https`、端口自选（如 `5443`）、
     启用刚才的自签证书；目标 `http`、`localhost:5111`
   - 之后用 `https://<NAS-IP>:5443` 访问：首次会有证书警告，点「继续前往」即安全上下文
   （过掉插页后 origin 是 https，浏览器按安全上下文对待，麦克风可用）
2. **有公网域名的话**：DSM 证书用 Let's Encrypt（需 DDNS/公网解析），同样走反代，无证书警告
3. **不配 HTTPS 的替代**：系统键盘听写（iOS/Android 输入法麦克风），体验接近，
   输入的就是文本，走既有文字识别管线——HTTP 下最省事的方案

**代码侧配套（v1.10.1）**：麦克风按钮增加 `window.isSecureContext` 门控——HTTP 访问时
按钮不再出现（此前是点了才报错）；`not-allowed` 错误文案改为对症提示（需 HTTPS + 授权）。

## 发版到 NAS 的标准路径

```
维护者推 tag（vX.Y.Z）→ CI 双架构镜像发布 GHCR（镜像 tag 无 v 前缀：X.Y.Z / latest）
→ NAS：cd /volume1/docker/homeledger && docker compose pull && docker compose up -d
→ 验证：http(s)://<NAS-IP>[:端口]/healthz 200 + 关于页版本号
```

- 拉取走中转 `ghcr.milu.moe/yibohub/homeledger`；中转不可用时备选 DaoCloud / 南大镜像源，
  或本地 `docker pull` + `docker save/load`（细节待沉淀）
- 升级前备份数据库：停容器后 `cp data/homeledger.db data/homeledger.db.bak-$(date +%F)`
- 每日自动备份：控制面板 → 任务计划 → 每日 rsync/cp `/volume1/docker/homeledger/data`
  到另一共享文件夹（**待配置**，见看板发版节）

## 防回归

- verify-ai-chat / verify-minimal 各有一条 `isSecureContext` 断言：门控被删会红
- 相关规则：AGENTS.md §操作纪律（NAS 侧动作逐项确认）；姊妹篇见
  [route-shadowing.md](route-shadowing.md)、[windows-test-infra.md](windows-test-infra.md)
