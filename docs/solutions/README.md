# 踩坑与方案索引（docs/solutions/README.md）

> 每篇 = 现象 → 根因 → 方案 → 防回归。规则层（AGENTS.md）只留「别重犯」短句，完整根因在这里。

| 主题 | 一句话 | 文档 | 首次踩坑 |
|------|--------|------|----------|
| Windows 测试基建 | 跑批端口竞态会让套件串数据；强退进程在 Windows 上偶发断言崩溃 | [windows-test-infra.md](windows-test-infra.md) | 2026-10-09（v1.8.0 批次） |
| AI 臆造账户 | 模型在原文没提付款方式时自行填 acct，顶掉习惯推荐；三层防线（提示词/原文核验/统计兜底） | [ai-invented-account.md](ai-invented-account.md) | 2026-10-09（v1.8.0 批次） |
