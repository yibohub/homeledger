# 踩坑与方案索引（docs/solutions/README.md）

> 每篇 = 现象 → 根因 → 方案 → 防回归。规则层（AGENTS.md）只留「别重犯」短句，完整根因在这里。

| 主题 | 一句话 | 文档 | 首次踩坑 |
|------|--------|------|----------|
| Windows 测试基建 | 跑批端口竞态会让套件串数据；强退进程在 Windows 上偶发断言崩溃 | [windows-test-infra.md](windows-test-infra.md) | 2026-10-09（v1.8.0 批次） |
| AI 臆造账户 | 模型在原文没提付款方式时自行填 acct，顶掉习惯推荐；三层防线（提示词/原文核验/统计兜底） | [ai-invented-account.md](ai-invented-account.md) | 2026-10-09（v1.8.0 批次） |
| 路由遮蔽 | 参数路由 `/:id` 注册在前，`/transactions/bulk` 被吞进编辑分支，网页批量操作自 v1.0.0 全失效；核心写路径必须有 HTTP 层测试 | [route-shadowing.md](route-shadowing.md) | 2026-10-09（verify-transactions 套件首跑） |
| NAS 部署运维 | 语音 not-allowed 的根因是 HTTP 非安全上下文（DSM 反代 + 自签证书方案）；发版到 NAS 标准路径 | [deploy-nas.md](deploy-nas.md) | 2026-10-09（v1.10.0 部署实测） |
| 云服务器部署运维 | 目标机连 GitHub 被 GnuTLS 掐断 → git bundle 分发；容器只绑 127.0.0.1、公网走 Caddy 子域反代；升级 = 部署机 `update.sh` | [deploy-caddy-docker.md](deploy-caddy-docker.md) | 2026-10-09（首次部署实测） |
