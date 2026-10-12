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
 *     日常节奏外推 = （已发生 − 已入账固定扣费 − 临时大额）÷ 已过天数 × 剩余天数
 *
 * 已入账固定扣费按 source IN ('subscription','recurring') 识别（自动记账写入的标记）；
 * 手动记的固定支出识别不出也不必识别——留在日常节奏里被外推恰好符合直觉。
 * 临时大额（P7 修订）单独剔除：手动/AI 记的一次性大额（社保、家电、份子）不是「节奏」，
 * 线性外推会系统性放大预测（生产账实测 2.5×），见 lumpyOfMonth。
 * 设计与决策记录：docs/ai-roadmap.md §P7 及其修订小节。
 */
const { all, get } = require('../db');
const auth = require('./auth');
const txn = require('./txn');
const sch = require('./scheduler');
const { pad } = require('./util');

/** 月初样本太少不出预测：已过天数不足此数时预测没有意义 */
const MIN_ELAPSED_DAYS = 3;

/* P7 修订（2026-10-12）：临时大额不进节奏外推。
 * 大额判定 = 单笔 ≥ max(本月单笔金额中位数 × K, 绝对下限)——中位数对大额自身免疫，
 * 冷启动可用。生产账标定（老易 2026-10，22 笔、单笔中位数 ¥9.2）：K=8 时阈值 ¥74，
 * 社保 5000/液化气 990/加油 390/门诊 260/药品 77.5 全剔、¥30 车辆维修留在节奏。
 * 下限兜底中位数退化（账本全是几块钱小额时阈值不能跟着缩到没意义）。 */
const LUMPY_K = 8;
const LUMPY_FLOOR_CENTS = 5000; // ¥50：再省的家庭也谈不上「一次性大额」的下限
const LUMPY_REPEAT_TOL = 0.1; // 防误伤：同分类金额相近（±10%）的大额 ≥2 笔是本月节奏（每周加油），不剔

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

function medianOf(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * 本月「临时大额」集合（P7 修订）：这些单笔计入已发生总额，但不进日常节奏外推的分子。
 *
 * 判定（数字靠统计，全部 SQL+算术可溯源）：
 *   · 人工标记 no_rhythm=1（草稿卡/手动表单「一次性大额」勾选）→ 事实级信号，必剔；
 *   · 统计判定：单笔 ≥ max(本月单笔中位数 × LUMPY_K, LUMPY_FLOOR_CENTS)；
 *   · 防误伤：同分类内金额成链（排序后相邻两笔差 ≤ 较大者×10%）的大额 ≥2 笔视为
 *     本月节奏，不剔——相邻配对而非「与组中位数比」，多峰簇（保养 200×2 + 保险 400×2）
 *     各自成链互不干扰，簇间的孤立大额仍是事件。
 * 系统固定扣费（subscription/recurring）不参与统计：它们已由固定拆分/日历精算接管，
 * 混进中位数反而把阈值抬高。中位数对大额自身免疫（5000 不动摇 9 块钱的中位数）。
 * 无分类（category_id NULL）的大额各自成组：NULL 不等于「同分类」，互不豁免。
 * @returns {{cents:number, count:number, ids:number[], threshold_cents:number}}
 */
function lumpyOfMonth(ledgerId, month) {
  const rows = all(
    `SELECT id, category_id, amount_base_cents AS amt, no_rhythm FROM transactions
     WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date BETWEEN ? AND ?
       AND type IN (${EXPENSE_TYPES.map(() => '?').join(',')})
       AND (source IS NULL OR source NOT IN ('subscription','recurring'))`,
    ledgerId, `${month}-01`, `${month}-31`, ...EXPENSE_TYPES
  );
  const marked = rows.filter((r) => Number(r.no_rhythm) === 1);
  const lumpy = [...marked];
  let threshold = LUMPY_FLOOR_CENTS;
  const stats = rows.filter((r) => Number(r.no_rhythm) !== 1);
  if (stats.length) {
    threshold = Math.max(LUMPY_FLOOR_CENTS, medianOf(stats.map((r) => Number(r.amt))) * LUMPY_K);
    const big = stats.filter((r) => Number(r.amt) >= threshold);
    const byCat = new Map();
    for (const r of big) {
      // NULL 分类各自成组（键含 id）：两笔不相关的未分类大额不能互相豁免
      const key = r.category_id == null ? `n${r.id}` : Number(r.category_id);
      if (!byCat.has(key)) byCat.set(key, []);
      byCat.get(key).push(r);
    }
    for (const group of byCat.values()) {
      if (group.length >= 2) {
        const sorted = [...group].sort((a, b) => Number(a.amt) - Number(b.amt));
        const clusters = [[sorted[0]]];
        for (let i = 1; i < sorted.length; i++) {
          const prev = Number(sorted[i - 1].amt);
          const cur = Number(sorted[i].amt);
          if (cur - prev <= Math.max(prev, cur) * LUMPY_REPEAT_TOL) clusters[clusters.length - 1].push(sorted[i]);
          else clusters.push([sorted[i]]);
        }
        const rhythmic = clusters.filter((c) => c.length >= 2);
        if (rhythmic.length) {
          const rhythmicSet = new Set(rhythmic.flat());
          for (const g of group) if (!rhythmicSet.has(g)) lumpy.push(g); // 簇外的孤立大额仍是事件
          continue;
        }
      }
      lumpy.push(...group);
    }
  }
  return {
    cents: lumpy.reduce((s, r) => s + Number(r.amt), 0),
    count: lumpy.length,
    ids: lumpy.map((r) => Number(r.id)),
    threshold_cents: Math.round(threshold),
  };
}

/**
 * 预算口径内的大额合计与笔数：lumpyOfMonth 给出的 id 集与预算 scope/type 条件求交
 * （口径条件与 budgetUsedInRange 完全一致，剔除与已用才可比）；计数必须是
 * scope 交集后的笔数，账本级 lump.count 会把口径外的大额也数进来
 * @returns {{cents:number, count:number}}
 */
function lumpyInScope(b, ids, range) {
  if (!ids.length) return { cents: 0, count: 0 };
  const params = [b.ledger_id, range.start, range.end, ...ids];
  let sql = `SELECT COALESCE(SUM(amount_base_cents),0) AS s, COUNT(*) AS c FROM transactions
             WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date BETWEEN ? AND ?
               AND id IN (${ids.map(() => '?').join(',')})
               AND type IN (${EXPENSE_TYPES.map(() => '?').join(',')})`;
  params.push(...EXPENSE_TYPES);
  if (b.scope === 'category' && b.category_id) {
    sql += ' AND (category_id = ? OR category_id IN (SELECT id FROM categories WHERE parent_id = ?))';
    params.push(b.category_id, b.category_id);
  } else if (b.scope === 'account' && b.account_id) {
    sql += ' AND account_id = ?';
    params.push(b.account_id);
  }
  const r = get(sql, ...params);
  return { cents: Number(r?.s || 0), count: Number(r?.c || 0) };
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
  const lump = lumpyOfMonth(ledgerId, month);
  const known = knownFutureCents({ ledger_id: ledgerId, fromDate: today, toDate: `${month}-31` });
  const dailySpent = spent - fixed - lump.cents;
  if (dailySpent <= 0 && known === 0) {
    return { enough: false, reason: 'no-activity', ...base, spent_cents: spent, lumpy_cents: lump.cents, lumpy_count: lump.count };
  }

  const forecast = spent + known + Math.round((dailySpent * remaining) / elapsed);
  return {
    enough: true, ...base,
    spent_cents: spent, fixed_cents: fixed, known_future_cents: known,
    lumpy_cents: lump.cents, lumpy_count: lump.count,
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
  const lump = lumpyOfMonth(b.ledger_id, month);
  const lumpIn = lumpyInScope(b, lump.ids, range);
  const lumpyUsed = lumpIn.cents;
  const known = knownFutureCents({
    ledger_id: b.ledger_id, fromDate: today, toDate: range.end,
    scope: b.scope, category_id: b.category_id, account_id: b.account_id,
  });
  const dailySpent = used - fixedUsed - lumpyUsed;
  if (dailySpent <= 0 && known === 0) {
    return { enough: false, reason: 'no-activity', ...base, used_cents: used, lumpy_used_cents: lumpyUsed, lumpy_count: lumpIn.count };
  }

  const forecast = used + known + Math.round((dailySpent * remaining) / elapsed);
  return {
    enough: true, ...base,
    used_cents: used, fixed_used_cents: fixedUsed, known_future_cents: known,
    lumpy_used_cents: lumpyUsed, lumpy_count: lumpIn.count,
    forecast_cents: forecast,
    ratio_forecast: (forecast / amount) * 100,
    will_over: forecast > amount,
    over_cents: Math.max(0, forecast - amount),
    remain_cents: Math.max(0, amount - forecast),
  };
}

/**
 * 月末预测通知（scheduler.runDaily 每天跑）：仅当「预测月末使用率 > 100%（将超出）」才通知——
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

module.exports = {
  monthForecast, budgetForecast, checkForecasts, knownFutureCents, spentOfMonth,
  lumpyOfMonth, lumpyInScope, MIN_ELAPSED_DAYS, LUMPY_K, LUMPY_FLOOR_CENTS,
};
