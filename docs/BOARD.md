# 项目看板（docs/BOARD.md）

> **单一入口**：家账簿做到哪、下一步做啥、什么押后了。回答「下一步」先看这里，不要翻 ai-roadmap/solutions 找进度——那里只放设计与根因，不重复状态。
> **最近更新**：2026-10-09（P2 对话查账随 PR #3 合并，v1.9.0；发版收尾等维护者操作）

## 怎么维护（规则）

| 时机 | 动作 |
|---|---|
| 立项 / 讨论定案 | 进「📋 待办」；有设计细节的**只放一行 + 链接**到 ai-roadmap.md 或 solutions/，不复制 |
| 事情做完 | 从「进行中/待办」挪到「✅ 已完成」（保留最近 10 条，更早的删） |
| 决定押后 | 进「⏸️ 押后」并**必须填触发条件**（何时重新评估）——这是防遗忘的核心 |
| 发现新 follow-up | 随手加进「待办」或「押后」 |

> 分工：看板 = 执行视图（做什么、到哪步）；`ai-roadmap.md` = AI 设计文档（为什么、怎么做）；`solutions/` = 踩坑根因。两边不重复。

---

## 🎯 进行中

### v1.9.0 发版收尾（等维护者操作，P2 合并后）
> 逐版登记台账（含 v1.8.0 同样待打 tag）：[versions.md](versions.md)；发版后把 ⏳ 改 ✅
- [ ] 推 `v1.9.0` 标签（手动：`git tag v1.9.0 && git push origin v1.9.0`）→ CI 构建双架构镜像并发布 GHCR
- [ ] GHCR 包设为 Public（网页一次性：头像 → Packages → homeledger → Change visibility）
- [ ] NAS compose 切镜像 `ghcr.milu.moe/yibohub/homeledger:latest` → `docker compose pull && up -d`
- [ ] NAS 计划任务：每日自动备份 `/volume1/docker/homeledger/data` 到另一共享文件夹

---

## 📋 待办（下一步，按优先级）

### ★ verify-importers：导入/导出回归套件
- [ ] 微信 CSV 归类断言（收/支/不计收支，v1.3.0 修复区）
- [ ] 导出 → 回导循环保真（类型列不漂移，v1.4.1 E2E 区）

### ★ solutions/deploy-nas.md：NAS 部署运维知识沉淀
群晖 Container Manager 步骤（`user: "0:0"` 缘由）/ 镜像源切换顺序（中转 → DaoCloud → 南大 → 手动 load）/ ZeroTier 组网与 DSM 防火墙 / 备份恢复路径 / 邀请注册流程。内容全在会话记录里，未落盘。

### selfcheck-static 版本三件套一致性断言
`package.json` / `about.js` CHANGELOG 最新条目 / `README.md` 更新记录首条，三处版本号必须一致——防手工漂移。约半小时。

### 生产配置 fail-fast
`NODE_ENV=production` 时 `SESSION_SECRET` 缺省回退值、`ADMIN_PASSWORD=admin888` 直接拒绝启动（现只打提示）。开源项目公网部署常见翻车点。

---

## 🤖 AI 路线（执行视图；设计细节与开放问题 → [ai-roadmap.md](ai-roadmap.md)，不在此复制）

- [ ] **P2 对话查账** ⭐ ~~下一批~~ ✅ v1.9.0（悬浮球学会「答」：意图解析 → SQL 出数 → 模型叙述）
- [ ] **P3 语音记账** 下一批候选（Web Speech API → 现有 text 管线，与 P10 捕获区同批做）
- [ ] P5 订阅模式挖掘 / P6 预算智能建议 / P7 月末预测预警
- [ ] P10 极简手机端·阶段 1（三 Tab 重排，依赖 P1 ✅）
- [x] ~~P1 习惯记忆 + P4 后悔药~~ ✅ v1.8.0（PR #1 已审查合并）
- P8 导入兜底分类 / P9 年度账单叙事：押后，见 roadmap 第三梯队

---

## ⏸️ 押后（每项必须有触发条件）

| 押后项 | 押后原因 | 触发条件 | 来源 |
|---|---|---|---|
| 账户编辑表单暴露「排序值」输入框 | 后端 `POST /accounts/:id` 已收 `sort_order`，纯前端字段；当时讨论完默认账户问题即转向 AI 话题 | 下次做账户页相关功能时顺手；或维护者再提「改默认账户」时 | 2026-10-09 默认账户讨论 |
| CI 增加 windows-latest 一条腿 | CI 时长成本；两个 Windows-only 坑已修复且有 [防回归文档](solutions/windows-test-infra.md) | 下次再出现 Windows-only 测试问题时 | 2026-10-09 v1.8.0 批次 |

---

## ✅ 已完成（最近，倒序）

| 时间 | 提交 / PR | 内容 |
|---|---|---|
| 2026-10-09 | PR #3（合并 d5756b0） | **v1.9.0：P2 对话查账**（五类问法 + 隐式分流 + 无 Key 规则降级 + 只读可问；数字全 SQL 出数、模型只做意图与叙述）；独立审查 1×P1（归档账本可写）+ 4×P2 全修复；verify-ai-ask 72 断言，全量 11 套件 475 断言全绿 |
| 2026-10-09 | PR #2（合并 332994e） | **verify-transactions 核心记账回归套件**（103 断言：14 类型余额方向、统计口径、报销边界、借贷台账、软删/恢复/批量的余额不变式 + HTTP 段）；首跑即抓到 **/bulk 路由遮蔽 P1**（网页批量操作自 v1.0.0 全失效，[根因](solutions/route-shadowing.md)）并修复；updateTransaction 补齐账户必填与投资双账户校验；独立审查无 P1，10 套件 403 断言全绿 |
| 2026-10-09 | 6980d97 / 30b564a | 三层知识库（AGENTS.md 规则层 + docs 导航层 + solutions 文档层）+ 协作规则落盘 |
| 2026-10-09 | PR #1（合并 985d82c） | **v1.8.0 第一批**：P1 习惯记忆（统计兜底链 + 习惯摘要进提示词 + 原文核验防臆造）+ P4 入账后悔药（30 分钟/本人/本账本/AI 来源）；独立审查 3×P1 + 5×P2 全修复；9 套件 300 断言全绿 |
| 2026-10-09 | b9084ef | AI 能力路线图 P1–P10 讨论稿（含设计原则与实施顺序） |
| 2026-10-09 | 仓库初始化 | yibohub/homeledger 公开仓库建立（SSH 推送），upstream = Panda-995/homeledger |
