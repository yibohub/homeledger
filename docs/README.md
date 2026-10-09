# 项目文档导航（docs/README.md）

> 家账簿 HomeLedger 三层知识库总导航（借鉴 vivitage「三层分工 + 引用链」方法论，适配单模块小项目）。
> **规则层每次会话加载短句 + 指针（根 `AGENTS.md`）→ 导航层按场景索引（本文件）→ 文档层按需 Read 装完整知识。**
> 细节下沉文档层、规则上浮规则层；改 rules/solutions 前先 grep 引用。

## 三层入口

| 层 | 入口 | 说明 |
|----|------|------|
| 规则层 | [`/AGENTS.md`](../AGENTS.md) | 每次会话自动加载：概述 / 常用命令 / 架构要点 / 必须禁止短句 |
| 执行视图 | [BOARD.md](BOARD.md) | **回答「下一步」先看这里**：进行中 / 待办 / 押后（必须带触发条件）/ 已完成 |
| 导航层 | 本文件 | 按任务场景索引规则与展开文档 |
| 文档层 | [solutions/](solutions/README.md) · [ai-roadmap.md](ai-roadmap.md) · [collaboration.md](collaboration.md) | 完整知识、踩坑根因与方案、路线图、协作规则 |

## 场景索引

| 任务场景 | 规则短句（AGENTS.md） | 展开层（完整根因与方案） |
|----------|----------------------|--------------------------|
| AI 记账 / 习惯记忆 / 识别链路 | 数字靠统计语言靠模型；产出可溯源、标注如实 | [solutions/ai-invented-account.md](solutions/ai-invented-account.md)（模型臆造账户三层防线）· [ai-roadmap.md](ai-roadmap.md) |
| 测试 / 跑批 / 回归 | 隔离 DATA_DIR；8099 残留即清；9 套件全绿才算完成 | [solutions/windows-test-infra.md](solutions/windows-test-infra.md)（端口竞态 / 退出断言 / 文件锁三坑） |
| 协作 / 发版 / PR | 标签只在明确要求时打；分支→PR→审查→合并 | [collaboration.md](collaboration.md) |
| 部署（NAS / GHCR） | 出网动作逐项确认 | 根 README 快速开始；NAS 实操（群晖 + ZeroTier）与 GHCR 发版见会话记录，待沉淀为 `solutions/deploy-nas.md` |

## 维护提示

- **事项状态变化 → 更新 [BOARD.md](BOARD.md)**（规则见其「怎么维护」节：押后必须带触发条件；AI 项只放一行链接）
- 新踩坑 → `docs/solutions/<主题>.md` + 更新 [solutions/README.md](solutions/README.md) 索引；规则层只加「别重犯」短句（AGENTS.md §必须禁止）
- 新路线/计划 → `docs/` 日期前缀命名；现状与进度回填 `ai-roadmap.md`
- 改 AGENTS.md 的短句前，先确认 `solutions/` 里的根因描述仍然成立（两层不能漂移）
