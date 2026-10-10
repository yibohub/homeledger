'use strict';
/**
 * P7 月末支出预测与超支预警（纯统计零 token，无 AI Key 全功能可用）
 *
 * 预测三分量，避免「月初大额固定扣费污染日常节奏」：
 *   本月预测支出 = 已发生支出 + 未来已知扣费 + 日常节奏外推
 *     已发生支出   = 本月至今 type IN ('expense','fee') 的 amount_base_cents 合计
 *                   （与预算预警、首页「本月支出」大数字同口径）
 *     未来已知扣费 = 订阅（active/trial 且非 none/fixed 周期，今天 < next_charge_at ≤ 月末）
 *                  + 周期账单（auto_post=1，从 next_run_at 逐期 walk 到月末，只计今天之后）
 *     日常节奏外推 = （已发生 − 已入账固定扣费）÷ 已过天数 × 剩余天数
 *
 * 已入账固定扣费按 source IN ('subscription','recurring') 识别（自动记账写入的标记）；
 * 手动记的固定支出识别不出也不必识别——留在日常节奏里被外推恰好符合直觉。
 * 设计与决策记录：docs/ai-roadmap.md §P7。
 */
const { all, get } = require('../db');
const auth = require('./auth');
const txn = require('./txn');
const sch = require('./scheduler');
const { pad } = require('./util');

/** 月初样本太少不出预测：已过天数不足此数时预测没有意义 */
const MIN_ELAPSED_DAYS = 3;

/** 计入「支出」统计的类型（与预算预警、报表口径一致） */
const EXPENSE_TYPES = txn.EXPENSE_TYPES;

const dateStrOf = (ref) => `${ref.getFullYear()}-${pad(ref.getMonth() + 1)}-${pad(ref.getDate())}`;
const monthKeyOf = (ref) => `${ref.getFullYear()}-${pad(ref.getMonth() + 1)}`;
const daysInMonthOf = (ref) => new Date(ref.getFullYear(), ref.getMonth() + 1, 0).getDate();

/**
 * 本月已发生支出（含固定扣费拆分）
 * @returns {{spent:number, fixed:number}} 分；fixed = 系统自动入账的订阅扣费与周期账单
 */
function spentOfMonth(ledgerId, month) {
  const r = get(
    `SELECT COALESCE(SUM(amount_base_cents),0) AS spent,
            COALESCE(SUM(CASE WHEN source IN ('subscription','recurring') THEN amount_base_cents ELSE 0 END),0) AS fixed
     FROM transactions
     WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date BETWEEN ? AND ?
       AND type IN (${EXPENSE_TYPES.map(() => '?').join(',')})`,
    ledgerId, `${month}-01`, `${month}-31`, ...EXPENSE_TYPES
  );
  return { spent: Number(r?.spent || 0), fixed: Number(r?.fixed || 0) };
}

/**
 * 未来已知扣费（日历精算，今天 < 扣费日 ≤ toDate）
 *
 * 只统计真正会自动入账的部分：
 *   · 订阅：active/trial、auto_renew=1、非 none/fixed 周期（这三类之外的都只提醒不扣费）；
 *     金额取 amount_cents——与 charge() 入账口径一致（rate=1）
 *   · 周期账单：auto_post=1（auto_post=0 只提醒手动记，可能不记也可能与手动入账双计，
 *     保守不计）；从 next_run_at 逐期 walk 到 toDate，只计今天之后的期次
 *     （今天的期次由当日定时任务入账，已计入「已发生」，再算就双计）
 * @param {object} o {ledger_id, fromDate, toDate, scope?, category_id?, account_id?}
 *                    带口径时只统计该分类（含直接子分类，与 budgetUsedInRange 同语义）/账户
 * @returns {number} 分（支出口径；income 规则不计）
 */
function knownFutureCents(o) {
  const { ledger_id: ledgerId, fromDate, toDate, scope, category_id: categoryId, account_id: accountId } = o;
  let cents = 0;

  // 只统计真正会自动入账的部分：
  //   · 订阅：active/trial 且 auto_renew=1 且非 none/fixed 周期——auto_renew=0（仅提醒，
  //     P5 一键登记的默认模式）与 none/fixed 一样只提醒不扣费（runDue 同一分支）；
  //     金额取 amount_cents——与 charge() 入账口径一致（rate=1）
  let sql = `SELECT COALESCE(SUM(amount_cents),0) AS s FROM subscriptions
             WHERE ledger_id = ? AND status IN ('active','trial') AND auto_renew = 1
               AND cycle NOT IN ('none','fixed') AND next_charge_at > ? AND next_charge_at <= ?`;
  const params = [ledgerId, fromDate, toDate];
  if (scope === 'category' && categoryId) {
    sql += ' AND (category_id = ? OR category_id IN (SELECT id FROM categories WHERE parent_id = ?))';
    params.push(categoryId, categoryId);
  } else if (scope === 'account' && accountId) {
    sql += ' AND account_id = ?';
    params.push(accountId);
  }
  cents += Number(get(sql, ...params)?.s || 0);

  const rules = all(
    'SELECT * FROM recurring_rules WHERE ledger_id = ? AND is_active = 1 AND auto_post = 1 AND next_run_at <= ?',
    ledgerId, toDate
  );
  let childCatIds = null;
  if (scope === 'category' && categoryId) {
    childCatIds = new Set(all('SELECT id FROM categories WHERE parent_id = ?', categoryId).map((r) => Number(r.id)));
  }
  for (const rule of rules) {
    let d = String(rule.next_run_at).slice(0, 10);
    // guard 防御退化数据（advanceDate 原地踏步时死循环）；一个月内日频规则最多 31 期，62 足够
    for (let guard = 0; d <= toDate && guard < 62; guard++) {
      if (d > fromDate) {
        for (const p of sch.ruleItems(rule.payload)) {
          if (!EXPENSE_TYPES.includes(p.type || 'expense')) continue;
          if (scope === 'category' && categoryId) {
            const pc = Number(p.category_id) || 0;
            if (pc !== Number(categoryId) && !childCatIds.has(pc)) continue;
          } else if (scope === 'account' && accountId && Number(p.account_id) !== Number(accountId)) {
            continue;
          }
          cents += Math.abs(Number(p.amount_cents) || 0);
        }
      }
      d = sch.advanceDate(d, rule);
    }
  }
  return cents;
}

/**
 * 账本级总口径月预测（报表页/问账等总览场景）
 * @returns {object} enough=false 时带 reason（too-early / no-activity）
 */
function monthForecast(ledgerId, ref = new Date()) {
  const today = dateStrOf(ref);
  const month = monthKeyOf(ref);
  const elapsed = ref.getDate();
  const remaining = daysInMonthOf(ref) - elapsed;
  const base = { month, elapsed, remaining };
  if (elapsed < MIN_ELAPSED_DAYS) return { enough: false, reason: 'too-early', ...base };

  const { spent, fixed } = spentOfMonth(ledgerId, month);
  const known = knownFutureCents({ ledger_id: ledgerId, fromDate: today, toDate: `${month}-31` });
  const dailySpent = spent - fixed;
  if (dailySpent <= 0 && known === 0) return { enough: false, reason: 'no-activity', ...base, spent_cents: spent };

  const forecast = spent + known + Math.round((dailySpent * remaining) / elapsed);
  return {
    enough: true, ...base,
    spent_cents: spent, fixed_cents: fixed, known_future_cents: known,
    forecast_cents: forecast,
  };
}

/**
 * 单个预算的月末预测。仅 monthly + 支出口径预算（P7 名为「月末」预测，
 * weekly/yearly/custom 周期与收入预算不做）；已超支的预算不再预测（既有 checkBudgets
 * 超支通知已接管）。口径条件与 budgetUsedInRange 完全一致，预测与已用才可比。
 * @returns {object} enough=false 时带 reason（not-supported / no-amount / too-early / already-over / no-activity）
 */
function budgetForecast(b, ref = new Date()) {
  const today = dateStrOf(ref);
  const month = monthKeyOf(ref);
  const elapsed = ref.getDate();
  const remaining = daysInMonthOf(ref) - elapsed;
  const base = { month, elapsed, remaining };
  if (b.period !== 'monthly' || b.trigger_type === 'income') return { enough: false, reason: 'not-supported', ...base };

  const amount = Number(b.amount_cents) || 0;
  if (amount <= 0) return { enough: false, reason: 'no-amount', ...base };

  const range = sch.budgetPeriodRange(b, ref);
  const used = sch.budgetUsedInRange(b, range.start, range.end);
  if (used >= amount) return { enough: false, reason: 'already-over', ...base, used_cents: used };
  if (elapsed < MIN_ELAPSED_DAYS) return { enough: false, reason: 'too-early', ...base, used_cents: used };

  const fixedUsed = sch.budgetUsedInRange(b, range.start, range.end, { fixedOnly: true });
  const known = knownFutureCents({
    ledger_id: b.ledger_id, fromDate: today, toDate: range.end,
    scope: b.scope, category_id: b.category_id, account_id: b.account_id,
  });
  const dailySpent = used - fixedUsed;
  if (dailySpent <= 0 && known === 0) return { enough: false, reason: 'no-activity', ...base, used_cents: used };

  const forecast = used + known + Math.round((dailySpent * remaining) / elapsed);
  return {
    enough: true, ...base,
    used_cents: used, fixed_used_cents: fixedUsed, known_future_cents: known,
    forecast_cents: forecast,
    ratio_forecast: (forecast / amount) * 100,
    will_over: forecast > amount,
    over_cents: Math.max(0, forecast - amount),
    remain_cents: Math.max(0, amount - forecast),
  };
}

/**
 * 月末预测通知（scheduler.runDaily 每天跑）：仅当「预测月末使用率 ≥ 100%」才通知——
 * 预测值在预算页人人可见，通知只报坏消息。与 checkBudgets 互补：它管「已经超了」，
 * 这里管「按节奏会超」。dedupe 按预算 × 月份，月内一条。
 * @returns {number} 本次发出的通知预算数
 */
function checkForecasts(ref = new Date()) {
  const budgets = all(
    "SELECT * FROM budgets WHERE is_active = 1 AND period = 'monthly' AND trigger_type != 'income'"
  );
  const month = monthKeyOf(ref);
  let alerted = 0;
  for (const b of budgets) {
    const f = budgetForecast(b, ref);
    if (!f.enough || !f.will_over) continue;
    const dedupeKey = `forecast:${b.id}:${month}:over`;
    if (auth.alreadyNotified(dedupeKey)) continue;
    const body = `预计月末 ${(f.forecast_cents / 100).toFixed(2)} / 预算 ${(Number(b.amount_cents) / 100).toFixed(2)}`
      + `（${f.ratio_forecast.toFixed(0)}%），将超出 ${(f.over_cents / 100).toFixed(2)}`
      + `；按本月日常节奏+已知扣费估算 |${dedupeKey}`;
    for (const uid of auth.ledgerWriterIds(b.ledger_id)) {
      auth.notify(uid, {
        kind: 'warn', ledgerId: b.ledger_id,
        title: `月末预测：${b.name} 将超支`, body, link: '/budgets',
      });
    }
    alerted++;
  }
  return alerted;
}

module.exports = { monthForecast, budgetForecast, checkForecasts, knownFutureCents, spentOfMonth, MIN_ELAPSED_DAYS };
