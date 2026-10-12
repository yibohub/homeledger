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
 * @param {object} o {ledgerId, userId, source('scan'|'text'|'chat'|'api'), engine, model,
 *                    inputText, imageCount, itemCount, attachmentId, firstTxnId}
 * @returns {number} 行 id
 */
function record(o) {
  const {
    ledgerId, userId, source, engine = null, model = null,
    inputText = '', imageCount = 0, itemCount = 0, attachmentId = null, firstTxnId = null,
  } = o;
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
}

module.exports = { record };
