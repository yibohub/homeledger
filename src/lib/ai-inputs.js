'use strict';
/**
 * P15 识别原文落库：AI 识别事件表（docs/ai-roadmap.md §P15）
 *
 * 用户输入的识别原文（文字输入 / 截图附言）此前只活在请求生命周期内——ai_json 存的是
 * 模型输出不是用户输入，识别失败（0 笔）或后悔药撤销后「当时说了什么」无从回溯。
 * 本表一次识别留一行，供识别质量统计、习惯挖掘语料、审计溯源、失败样本重放。
 *
 * 边界：与敏感分流（v1.13.1）不冲突——其语义是「不出网」，本表是本地存储；
 * 但 input_text 含原文属敏感数据，备份/清理沿用数据目录既有边界。
 */
const { run, nowStr } = require('../db');

/**
 * 记一行识别事件（幂等由调用方保证：每个入口在其识别调用后恰好记一次）
 * best-effort：遥测写入永不影响主流程——部分调用点位于响应之后（chat/openapi 入账完成后），
 * 抛错会让 Express 4 的 async 路由未处理拒绝进而崩进程（独立审查 P1-1 实证），
 * 且数据已落账后再报错会诱发重复入账（P2-1）。失败只告警。
 * @param {object} o {ledgerId, userId, source('scan'|'text'|'chat'|'api'), engine, model,
 *                    inputText, imageCount, itemCount, attachmentId, firstTxnId}
 * @returns {number|null} 行 id（失败返回 null）
 */
function record(o) {
  const {
    ledgerId, userId, source, engine = null, model = null,
    inputText = '', imageCount = 0, itemCount = 0, attachmentId = null, firstTxnId = null,
  } = o;
  try {
    return Number(run(
      `INSERT INTO ai_inputs (ledger_id, user_id, source, engine, model, input_text, image_count, item_count, attachment_id, first_txn_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      Number(ledgerId), userId == null ? null : Number(userId), String(source),
      engine, model,
      inputText ? String(inputText).slice(0, 4000) : null,
      Math.max(0, Number(imageCount) || 0),
      Math.max(0, Number(itemCount) || 0),
      attachmentId == null ? null : Number(attachmentId),
      firstTxnId == null ? null : Number(firstTxnId),
      nowStr()
    ).lastInsertRowid);
  } catch (e) {
    console.error('[ai-inputs] 识别事件落库失败（不影响主流程）:', e.message);
    return null;
  }
}

module.exports = { record };
