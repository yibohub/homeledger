'use strict';
/**
 * 订阅模式挖掘（P5，见 docs/ai-roadmap.md）
 *
 * 从流水里自动发现「像订阅」的固定周期扣费：同商户、金额相近（±10%）、
 * 间隔固定（每周/月/季/半年/年，±3 天容差）、连续 ≥3 期 → 给出候选，
 * 在订阅页展示「登记为订阅」卡片。纯统计零 token，无 AI Key 完全可用。
 *
 * 与 subscriptions.js 的分工：那边管订阅生命周期（推进/扣费/提醒），
 * 这边只负责「发现」。只建议、绝不自动创建——误报（一家人常买同样的东西）
 * 由用户一票否决（「不是订阅」按钮持久忽略）。
 *
 * 标称天数取自然历法间隔的中心：每月同日间隔 28–31 落在 30±3，
 * 每季 89–93 落在 91±3，半年 181–184 落在 182±3，每年 365/366 落在 365±3。
 * 各周期容差区间互不重叠，一个间隔只会归入一个周期，无需消歧。
 */
const { all, getSetting, setSetting, todayStr } = require('../db');
const subs = require('./subscriptions');

const CYCLE_DEFS = [
  { cycle: 'weekly', nominal: 7 },
  { cycle: 'monthly', nominal: 30 },
  { cycle: 'quarterly', nominal: 91 },
  { cycle: 'half_yearly', nominal: 182 },
  { cycle: 'yearly', nominal: 365 },
];
const DAY_TOL = 3; // 间隔容差（天）
const AMOUNT_TOL = 0.1; // 金额容差：相对段内中位数 ±10%
const MIN_RUN = 3; // 连续 ≥3 期成候选
const MAX_CANDIDATES = 6; // 候选上限：满屏误报比没有建议更糟
const MAX_IGNORED = 200; // 忽略名单上限（防 settings 无限膨胀）

const dayDiff = (a, b) =>
  Math.round((new Date(`${String(a).slice(0, 10)}T00:00:00`) - new Date(`${String(b).slice(0, 10)}T00:00:00`)) / 86400000);

const median = (arr) => {
  const s = [...arr].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** 段内众数（分类/账户预填用）；全空返回 null */
function modeOf(arr) {
  const cnt = new Map();
  for (const v of arr) {
    if (v == null || v === '') continue;
    cnt.set(v, (cnt.get(v) || 0) + 1);
  }
  let best = null;
  for (const [v, c] of cnt) if (!best || c > best[1]) best = [v, c];
  return best ? best[0] : null;
}

/* ------------------------------ 忽略名单（持久） ------------------------------ */

const ignoredKey = (ledgerId) => `submining.ignored.${Number(ledgerId)}`;

function ignoredMerchants(ledgerId) {
  try {
    const v = JSON.parse(String(getSetting(ignoredKey(ledgerId), '[]') || '[]'));
    return Array.isArray(v) ? v.map((s) => String(s).slice(0, 40)) : [];
  } catch {
    return [];
  }
}

/** 加入忽略名单（幂等；有上限，满了挤掉最早的） */
function ignoreMerchant(ledgerId, name) {
  const list = ignoredMerchants(ledgerId).filter((s) => s !== name);
  list.push(name);
  setSetting(ignoredKey(ledgerId), JSON.stringify(list.slice(-MAX_IGNORED)));
}

/* --------------------------------- 挖掘 ---------------------------------- */

/**
 * 找一组按日期升序流水中，间隔最接近某标称周期的最长连续段
 * @returns {object[]|null} 段内流水（≥MIN_RUN 条），不满足返回 null
 */
function longestChain(txns, nominal) {
  let best = null; // { start, len }
  let start = 0;
  for (let i = 1; i <= txns.length; i++) {
    const gapOk =
      i < txns.length && Math.abs(dayDiff(txns[i].txn_date, txns[i - 1].txn_date) - nominal) <= DAY_TOL;
    if (gapOk) continue;
    const len = i - start;
    if (!best || len > best.len) best = { start, len };
    start = i;
  }
  return best && best.len >= MIN_RUN ? txns.slice(best.start, best.start + best.len) : null;
}

/**
 * 挖掘订阅候选
 * @param {number} ledgerId
 * @returns {object[]} 候选列表（按期数降序，截 MAX_CANDIDATES 条），字段与订阅表单一一对应
 */
function mineCandidates(ledgerId, { today = todayStr() } = {}) {
  // 1) 全部带商户的支出流水（未删、金额>0），按归一化商户名分组（v1 精确匹配；
  //    商户别名归并是 roadmap 里的可选项，留给模型批次）
  const rows = all(
    `SELECT merchant, amount_base_cents AS amount, txn_date, category_id, account_id
     FROM transactions
     WHERE ledger_id = ? AND deleted_at IS NULL AND type = 'expense'
       AND amount_base_cents > 0 AND merchant IS NOT NULL AND TRIM(merchant) != ''
     ORDER BY TRIM(merchant), txn_date, id`,
    Number(ledgerId)
  );
  const byMerchant = new Map();
  for (const r of rows) {
    const key = String(r.merchant).trim();
    if (!byMerchant.has(key)) byMerchant.set(key, []);
    byMerchant.get(key).push(r);
  }

  // 2) 已登记（未取消）或被用户忽略的商户不再建议；已取消的不排除——
  //    取消了但流水仍在续，恰恰说明该重新登记。周期账单（recurring_rules）已接管的
  //    固定收支同理不重复建议（那边能自动记账，功能是超集）
  const known = new Set(
    all(
      "SELECT name FROM subscriptions WHERE ledger_id = ? AND status != 'canceled'",
      Number(ledgerId)
    ).map((r) => String(r.name).trim())
  );
  for (const r of all(
    'SELECT name FROM recurring_rules WHERE ledger_id = ? AND is_active = 1',
    Number(ledgerId)
  )) {
    known.add(String(r.name).trim());
  }
  for (const n of ignoredMerchants(ledgerId)) known.add(n);

  const out = [];
  for (const [merchant, txns] of byMerchant) {
    if (known.has(merchant) || txns.length < MIN_RUN) continue;
    out.push(...candidatesOf(merchant, txns, today));
  }
  out.sort((a, b) => b.count - a.count || a.merchant.localeCompare(b.merchant, 'zh'));
  return out.slice(0, MAX_CANDIDATES);
}

/** 单商户 → 0 或 1 个候选（各周期取期数最多的一段；一段金额超容差即整段放弃，宁缺毋滥） */
function candidatesOf(merchant, txns, today) {
  let best = null;
  for (const { cycle, nominal } of CYCLE_DEFS) {
    const chain = longestChain(txns, nominal);
    if (!chain) continue;
    // 停扣的旧模式不挖：最后一次扣费距今超过「2 个周期且 ≥60 天」视为已终止
    const freshDays = Math.max(nominal * 2, 60);
    if (dayDiff(today, chain[chain.length - 1].txn_date) > freshDays) continue;
    if (!best || chain.length > best.chain.length) best = { cycle, nominal, chain };
  }
  if (!best) return [];

  const { cycle, chain } = best;
  const amounts = chain.map((t) => Number(t.amount));
  const med = median(amounts);
  if (!med) return [];
  if (!amounts.every((a) => Math.abs(a - med) <= med * AMOUNT_TOL)) return [];

  const gaps = chain.slice(1).map((t, i) => dayDiff(t.txn_date, chain[i].txn_date));
  const last = chain[chain.length - 1];
  const anchorDay = Math.max(1, Math.min(31, Number(last.txn_date.slice(8, 10)) || 1));
  return [
    {
      merchant,
      cycle,
      cycle_n: 1,
      cycleLabel: subs.cycleLabel(cycle, 1),
      amount_cents: med,
      count: chain.length,
      first_date: chain[0].txn_date,
      last_date: last.txn_date,
      avg_gap_days: Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length),
      // 预测下次扣费：复用订阅周期推进（月末锚点/闰年收敛同一套规则）
      next_charge_at: subs.advance(last.txn_date, { cycle, cycle_n: 1, anchor_day: anchorDay }),
      anchor_day: anchorDay,
      anchor_month: cycle === 'yearly' ? Math.max(1, Math.min(12, Number(last.txn_date.slice(5, 7)) || 1)) : null,
      account_id: modeOf(chain.map((t) => t.account_id)),
      category_id: modeOf(chain.map((t) => t.category_id)),
    },
  ];
}

module.exports = { mineCandidates, ignoredMerchants, ignoreMerchant, DAY_TOL, AMOUNT_TOL, MIN_RUN };
