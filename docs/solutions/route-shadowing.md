# 批量操作路由被参数路由遮蔽（docs/solutions/route-shadowing.md）

> 现象 → 根因 → 方案 → 防回归。网页批量操作自 v1.0.0 起全部失效却无人发现，直到
> verify-transactions 套件的 HTTP 段首跑抓到（PR #2，2026-10-09）。

## 现象

账单页勾选记录做批量操作（删除 / 恢复 / 报销 / 改分类 / 打标签），点任意按钮都返回
「记录不存在」400 页面。`#bulk-form` 明明 POST 到 `/transactions/bulk`，服务端也有
对应的 `router.post('/bulk')` 处理器。

## 根因

Express 按**注册顺序**匹配路由。`src/routes/transactions.js` 中
`router.post('/:id', ...)`（编辑）注册在 `router.post('/bulk', ...)` 之前，于是
`POST /transactions/bulk` 先被 `/:id` 捕获（`id = "bulk"`），`Number("bulk")` 为 NaN
查不到记录，落进编辑分支的 400 错误页。五个批量入口从未到达过真正的处理器。

openapi 侧不受影响：它的批量路径是 `/transactions/bulk-delete` 等独立字面量，且注册
在 `/transactions/:id` 之前。

## 方案

`/bulk` 移到 `/:id` 之前注册，并在路由处留注释说明原因（v1.0.0 起即存在，
PR #2 / 提交 2a8434d 修复）。

## 防回归

- **参数路由（`/:id`）一律注册在同级静态字面量路由（`/bulk`、`/new`）之后**；新增静态
  路由时检查是否被已有 `/:id` 遮蔽。2026-10-09 全量扫描 `src/routes/*.js`：dashboard、
  openapi、admin 均静态在前，无同类隐患
- **核心写路径必须有 HTTP 层测试**——服务层单测抓不住路由表问题，这正是
  `test/verify-transactions.js` HTTP 段存在的理由
- 相关：`AGENTS.md` §质量「每个功能配 test/verify-*.js 套件」；姊妹篇见
  [windows-test-infra.md](windows-test-infra.md)
