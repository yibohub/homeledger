'use strict';
/**
 * 回归：P7 月末支出预测与超支预警
 *
 * 分两段：
 *   A. 进程内逻辑（独立库 data-verify-forecast，固定参照日 2026-03-10 全程确定性）：
 *      三分量口径（已发生 + 日历精算 + 日常节奏外推）、固定扣费拆分不污染日常日均、
 *      订阅/周期账单的已知扣费筛选（none/fixed 不扣、canceled 不算、auto_post=0 不算、
 *      income 不算、今天与下月期次不算）、分类/账户口径过滤、边界（月初/无活动/已超支/
 *      非月度预算）、通知发出与去重
 *   B. HTTP 端到端（需先在 8099 起隔离实例，run-all 会自动拉起）：
 *      预算页预测行、报表页预测条、手机 Tab1 预测小字（月初 1–2 号全局不出预测，按日跳过）
 *
 * 运行：node test/verify-forecast.js
 */
const fs = require('node:fs');
const path = require('node:path');

const FC_DATA_DIR = path.join(__dirname, '..', 'data-verify-forecast');
process.env.DATA_DIR = FC_DATA_DIR;
fs.rmSync(FC_DATA_DIR, { recursive: true, force: true });

const db = require('../src/db');
const auth = require('../src/lib/auth');
const fc = require('../src/lib/forecast');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}

/* ============================ A. 进程内逻辑 ============================ */

console.log('\n=== A. 月末预测逻辑（进程内，固定参照日 2026-03-10）===\n');

db.init();

const uid = Number(db.run(
  'INSERT INTO users (username, password_hash, display_name, avatar_color, is_admin, created_at) VALUES (?,?,?,?,1,?)',
  'fcadmin', auth.hashPassword('fc-pass-123'), '预测测试', '#4f7cff', db.nowStr()
).lastInsertRowid);
const ledgerId = Number(db.createDefaultLedger(uid, '预测测试'));
const accountId = Number(db.get('SELECT id FROM accounts WHERE ledger_id = ? LIMIT 1', ledgerId).id);

/* 分类：C1（预算口径）与 C2（干扰项） */
const c1 = Number(db.run(
  'INSERT INTO categories (ledger_id, name, kind, parent_id, is_system, sort_order) VALUES (?,?,?,?,0,0)',
  ledgerId, '预测分类一', 'expense', null
).lastInsertRowid);
const c2 = Number(db.run(
  'INSERT INTO categories (ledger_id, name, kind, parent_id, is_system, sort_order) VALUES (?,?,?,?,0,0)',
  ledgerId, '预测分类二', 'expense', null
).lastInsertRowid);

const REF = new Date('2026-03-10T12:00:00'); // elapsed=10，3 月 31 天 remaining=21

function addTxn(cents, date, { source = 'manual', categoryId = null } = {}) {
  db.run(
    `INSERT INTO transactions
     (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, to_account_id, category_id,
      user_id, txn_date, note, status, source, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?)`,
    ledgerId, 'expense', cents, 'CNY', 1, cents, accountId, categoryId, uid, date, '预测回归', 'cleared', source, db.nowStr(), db.nowStr()
  );
}
function addSub(fields) {
  const base = {
    ledger_id: ledgerId, name: '订阅', amount_cents: 1000, currency: 'CNY', cycle: 'monthly', cycle_n: 1,
    anchor_day: null, account_id: null, category_id: null, next_charge_at: '2026-03-15', status: 'active',
    reminder_days: 3, charge_count: 0, auto_renew: 1, created_at: db.nowStr(),
  };
  const v = { ...base, ...fields };
  return Number(db.run(
    `INSERT INTO subscriptions (ledger_id, name, amount_cents, currency, cycle, cycle_n, anchor_day, account_id,
      category_id, next_charge_at, status, reminder_days, charge_count, auto_renew, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    v.ledger_id, v.name, v.amount_cents, v.currency, v.cycle, v.cycle_n, v.anchor_day, v.account_id,
    v.category_id, v.next_charge_at, v.status, v.reminder_days, v.charge_count, v.auto_renew, v.created_at
  ).lastInsertRowid);
}
function addRule(fields, payload) {
  const v = {
    ledger_id: ledgerId, name: '周期', payload: JSON.stringify(payload || []),
    frequency: 'monthly', interval_n: 1, day_of_month: null, weekday: null,
    next_run_at: '2026-03-12', last_run_at: null, auto_post: 1, is_active: 1, created_at: db.nowStr(),
    ...fields,
  };
  return Number(db.run(
    `INSERT INTO recurring_rules (ledger_id, name, payload, frequency, interval_n, day_of_month, weekday,
      next_run_at, last_run_at, auto_post, is_active, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    v.ledger_id, v.name, v.payload, v.frequency, v.interval_n, v.day_of_month, v.weekday,
    v.next_run_at, v.last_run_at, v.auto_post, v.is_active, v.created_at
  ).lastInsertRowid);
}
function mkBudget(fields) {
  const base = {
    ledger_id: ledgerId, name: '预测预算', scope: 'overall', category_id: null, account_id: null,
    period: 'monthly', amount_cents: 100000, currency: 'CNY', trigger_type: 'expense',
    rollover: 0, alert_pct: 80, start_date: null, end_date: null, is_active: 1, created_at: db.nowStr(),
  };
  const v = { ...base, ...fields };
  const info = db.run(
    `INSERT INTO budgets (ledger_id, name, scope, category_id, account_id, period, amount_cents, currency,
      trigger_type, rollover, alert_pct, start_date, end_date, is_active, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    v.ledger_id, v.name, v.scope, v.category_id, v.account_id, v.period, v.amount_cents, v.currency,
    v.trigger_type, v.rollover, v.alert_pct, v.start_date, v.end_date, v.is_active, v.created_at
  );
  return db.get('SELECT * FROM budgets WHERE id = ?', Number(info.lastInsertRowid));
}

/* --- 边界：月初与无活动 --- */
const emptyLedger = Number(db.createDefaultLedger(uid, '空账本'));
const early = fc.monthForecast(emptyLedger, new Date('2026-03-02T12:00:00'));
check('月初 2 号不出预测（样本太少）', early.enough === false && early.reason === 'too-early', JSON.stringify(early));
const quiet = fc.monthForecast(emptyLedger, REF);
check('无任何支出且无已知扣费不出预测', quiet.enough === false && quiet.reason === 'no-activity', JSON.stringify(quiet));

/* --- 造数：日常 3 笔（共 3000）+ 固定扣费 1 笔（5000，source=subscription）--- */
addTxn(1000, '2026-03-05', { categoryId: c1 });
addTxn(1000, '2026-03-06', { categoryId: c1 });
addTxn(1000, '2026-03-09', { categoryId: c2 });
addTxn(5000, '2026-03-02', { source: 'subscription' });

/* --- 已知扣费：会扣的与不扣的 --- */
addSub({ name: '订阅A·会扣', amount_cents: 2000, category_id: c2, next_charge_at: '2026-03-15' });
addSub({ name: '固定到期·只提醒', cycle: 'fixed', amount_cents: 5000, next_charge_at: '2026-03-20' });
addSub({ name: '不周期·仅记录', cycle: 'none', amount_cents: 7000, next_charge_at: '2026-03-18' });
addSub({ name: '已取消', status: 'canceled', amount_cents: 9999, next_charge_at: '2026-03-18' });
addSub({ name: '已暂停', status: 'paused', amount_cents: 8888, next_charge_at: '2026-03-18' });
addSub({ name: '下月才扣', amount_cents: 6666, next_charge_at: '2026-04-05' });
addSub({ name: '仅提醒·不自动扣', auto_renew: 0, amount_cents: 4444, next_charge_at: '2026-03-22' });
addRule({ name: '周期R1·会扣', auto_post: 1, next_run_at: '2026-03-12' }, [{ type: 'expense', amount_cents: 3000, category_id: c1 }]);
addRule({ name: '周期R2·手动记', auto_post: 0, next_run_at: '2026-03-14' }, [{ type: 'expense', amount_cents: 9999 }]);
addRule({ name: '周期R3·收入规则', auto_post: 1, next_run_at: '2026-03-25' }, [{ type: 'income', amount_cents: 7777 }]);
addRule({ name: '周期R4·今天期次', auto_post: 1, next_run_at: '2026-03-10' }, [{ type: 'expense', amount_cents: 8888 }]);
addRule({ name: '周期R5·下月', auto_post: 1, next_run_at: '2026-04-05' }, [{ type: 'expense', amount_cents: 5555 }]);

/* --- 总口径月预测：spent=8000（日常3000+固定5000），known=2000+3000，外推=3000/10*21 --- */
const mf = fc.monthForecast(ledgerId, REF);
check('总口径：已发生 8000 / 固定拆分 5000 / 已知 5000',
  mf.enough === true && mf.spent_cents === 8000 && mf.fixed_cents === 5000 && mf.known_future_cents === 5000,
  JSON.stringify(mf));
check('总口径：预测 = 8000 + 5000 + 3000/10×21 = 19300', mf.forecast_cents === 19300, `forecast=${mf.forecast_cents}`);
check('总口径：elapsed=10、remaining=21', mf.elapsed === 10 && mf.remaining === 21, `e=${mf.elapsed} r=${mf.remaining}`);

/* 固定扣费已入账的 5000 不得进入日常日均（否则外推 5000/10×21=10500，预测虚高到 23800） */
check('固定扣费不污染日常日均（若污染预测会成 23800）', mf.forecast_cents !== 23800 && mf.forecast_cents === 19300, `forecast=${mf.forecast_cents}`);

/* --- 只订阅会扣、无日常：enough 但日均 0 --- */
const subOnlyLedger = Number(db.createDefaultLedger(uid, '只有订阅'));
addSub({ ledger_id: subOnlyLedger, name: '孤订阅', amount_cents: 3000, next_charge_at: '2026-03-20' });
const so = fc.monthForecast(subOnlyLedger, REF);
check('无日常但有已知扣费：出预测（外推 0）', so.enough === true && so.forecast_cents === 3000 && so.spent_cents === 0, JSON.stringify(so));

/* --- 预算级预测：总口径 ---（断言用预算一律 is_active:0，防 checkForecasts 扫到产生串扰通知） */
const bo = fc.budgetForecast(mkBudget({ amount_cents: 10000, is_active: 0 }), REF);
check('预算总口径：used=8000 / fixedUsed=5000 / known=5000 / 预测 19300',
  bo.enough === true && bo.used_cents === 8000 && bo.fixed_used_cents === 5000 && bo.known_future_cents === 5000 && bo.forecast_cents === 19300,
  JSON.stringify(bo));
check('预算总口径：将超支，超出 9300', bo.will_over === true && bo.over_cents === 9300 && bo.remain_cents === 0, JSON.stringify(bo));

/* --- 预算级预测：分类口径（C1：日常 2000 + 周期账单 3000；订阅A 在 C2 不得混入）--- */
const bc = fc.budgetForecast(mkBudget({ name: '分类预算', scope: 'category', category_id: c1, amount_cents: 20000, is_active: 0 }), REF);
check('分类口径：used=2000，订阅A（C2）不混入，known 只含 C1 周期账单 3000',
  bc.enough === true && bc.used_cents === 2000 && bc.known_future_cents === 3000, JSON.stringify(bc));
check('分类口径：预测 = 2000 + 3000 + 2000/10×21 = 9200，不超支',
  bc.forecast_cents === 9200 && bc.will_over === false && bc.remain_cents === 10800, JSON.stringify(bc));

/* --- 账户口径过滤：R1 明细无 account_id → 已知扣费 0，仅日常外推 --- */
const ba = fc.budgetForecast(mkBudget({ name: '账户预算', scope: 'account', account_id: accountId, amount_cents: 100000, is_active: 0 }), REF);
check('账户口径：周期账单明细无账户不混入（known=0），预测只用日常节奏',
  ba.enough === true && ba.known_future_cents === 0 && ba.forecast_cents === 8000 + Math.round((8000 - 5000) * 21 / 10), JSON.stringify(ba));

/* --- 边界：已超支 / 非 monthly / 收入口径 --- */
const bOver = fc.budgetForecast(mkBudget({ name: '已超支', amount_cents: 5000, is_active: 0 }), REF);
check('已超支预算不再预测（checkBudgets 已接管）', bOver.enough === false && bOver.reason === 'already-over', JSON.stringify(bOver));
const bYear = fc.budgetForecast(mkBudget({ name: '年度', period: 'yearly', is_active: 0 }), REF);
check('年度预算不出月末预测', bYear.enough === false && bYear.reason === 'not-supported', JSON.stringify(bYear));
const bInc = fc.budgetForecast(mkBudget({ name: '收入', trigger_type: 'income', is_active: 0 }), REF);
check('收入预算不出预测', bInc.enough === false && bInc.reason === 'not-supported', JSON.stringify(bInc));
const bEarly = fc.budgetForecast(mkBudget({ name: '月初', is_active: 0 }), new Date('2026-03-01T12:00:00'));
check('预算级月初 1 号同样不出预测', bEarly.enough === false && bEarly.reason === 'too-early', JSON.stringify(bEarly));

/* --- 通知：仅预测将超支才发，月内去重 --- */
const willOverId = mkBudget({ name: '将超支预算', amount_cents: 10000 }).id;
const calmId = mkBudget({ name: '淡定预算', amount_cents: 99999999 }).id;
const notified = fc.checkForecasts(REF);
check('checkForecasts：只有将超支预算触发（1 条）', notified === 1, `notified=${notified}`);
const notifRows = db.all("SELECT * FROM notifications WHERE body LIKE '%|forecast:%'");
check('通知落库：kind=warn、标题含「将超支」、链接 /budgets、dedupe 键带月份',
  notifRows.length === 1 && notifRows[0].kind === 'warn' && notifRows[0].title.includes('将超支')
  && notifRows[0].link === '/budgets' && notifRows[0].body.includes(`|forecast:${willOverId}:2026-03:over`),
  JSON.stringify(notifRows.map((r) => ({ k: r.kind, t: r.title, b: r.body }))));
check('再次运行去重（同月同预算不重复）', fc.checkForecasts(REF) === 0);
check('淡定预算不触发通知', db.all("SELECT * FROM notifications WHERE body LIKE ?", `%|forecast:${calmId}:%`).length === 0);

/* --- P7 修订：临时大额不进节奏外推（独立账本，不扰动上文数值断言）---
 * 造数（2026-03，参照日 03-10：elapsed=10 / remaining=21）：
 *   日常 6×500（c1）            → 中位数 500，阈值 = max(下限5000, 500×8=4000) = 5000（下限生效）
 *   周期对 10000 + 10500（c3）  → 同分类相近（组中位 10250 ±10%）≥2 笔 → 是节奏，不剔
 *   孤立大额 20000（c2）        → ≥ 阈值且组内仅 1 笔 → 剔
 *   人工标记 1500（c1，no_rhythm=1）→ 事实级信号，低于阈值也必剔
 *   固定扣费 4000（source=subscription）→ 不参与大额统计，走固定拆分
 * 期望：lumpy = 20000 + 1500 = 21500（2 笔）
 *   spent = 3000 + 20500 + 1500 + 4000 = 49000
 *   dailySpent = 49000 − 4000（固定）− 21500（大额）= 23500
 *   forecast = 49000 + 0 + round(23500×21/10) = 98350
 *   （若大额被当节奏外推：49000 + 45000×2.1 = 143500） */
const lumpyLedger = Number(db.createDefaultLedger(uid, '大额账本'));
const lumpyAcc = Number(db.get('SELECT id FROM accounts WHERE ledger_id = ? LIMIT 1', lumpyLedger).id);
const lc1 = Number(db.run('INSERT INTO categories (ledger_id, name, kind, parent_id, is_system, sort_order) VALUES (?,?,?,?,0,0)', lumpyLedger, '大额C1', 'expense', null).lastInsertRowid);
const lc2 = Number(db.run('INSERT INTO categories (ledger_id, name, kind, parent_id, is_system, sort_order) VALUES (?,?,?,?,0,0)', lumpyLedger, '大额C2', 'expense', null).lastInsertRowid);
const lc3 = Number(db.run('INSERT INTO categories (ledger_id, name, kind, parent_id, is_system, sort_order) VALUES (?,?,?,?,0,0)', lumpyLedger, '大额C3', 'expense', null).lastInsertRowid);
function addLumpyTxn(cents, date, { categoryId = null, source = 'manual', noRhythm = 0, ledger = lumpyLedger, account = lumpyAcc } = {}) {
  return Number(db.run(
    `INSERT INTO transactions
     (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, category_id,
      user_id, txn_date, note, status, source, no_rhythm, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ledger, 'expense', cents, 'CNY', 1, cents, account, categoryId, uid, date, '大额回归', 'cleared', source, noRhythm, db.nowStr(), db.nowStr()
  ).lastInsertRowid);
}
for (const d of ['01', '02', '03', '04', '05', '06']) addLumpyTxn(500, `2026-03-${d}`, { categoryId: lc1 });
addLumpyTxn(10000, '2026-03-02', { categoryId: lc3 });
addLumpyTxn(10500, '2026-03-07', { categoryId: lc3 });
addLumpyTxn(20000, '2026-03-05', { categoryId: lc2 });
const markedId = addLumpyTxn(1500, '2026-03-06', { categoryId: lc1, noRhythm: 1 });
addLumpyTxn(4000, '2026-03-03', { source: 'subscription' });

const lump = fc.lumpyOfMonth(lumpyLedger, '2026-03');
check('大额线 = max(中位数×8, 下限)，本例下限 5000 生效', lump.threshold_cents === 5000, `threshold=${lump.threshold_cents}`);
check('临时大额剔 2 笔 21500：孤立大额 20000 + 人工标记 1500', lump.cents === 21500 && lump.count === 2, JSON.stringify(lump));
check('周期对（同分类相近 10000/10500）不剔', !lump.ids.some((id) => id === Number(db.get("SELECT id FROM transactions WHERE ledger_id=? AND amount_base_cents=10000 AND category_id=?", lumpyLedger, lc3).id)), JSON.stringify(lump.ids));
check('人工标记 id 在剔除集合内', lump.ids.includes(markedId), JSON.stringify(lump.ids));
check('固定扣费不参与大额统计（4000 未剔）', !lump.ids.includes(Number(db.get("SELECT id FROM transactions WHERE ledger_id=? AND amount_base_cents=4000 AND source='subscription'", lumpyLedger).id)), '');

const lm = fc.monthForecast(lumpyLedger, REF);
check('大额账本月预测：spent=49000 / lumpy=21500 / 预测 98350（失真版 143500 被纠正）',
  lm.enough === true && lm.spent_cents === 49000 && lm.lumpy_cents === 21500 && lm.lumpy_count === 2 && lm.forecast_cents === 98350,
  JSON.stringify(lm));

/* 只有孤立大额、无日常节奏：dailySpent=0 且无已知扣费 → 不出预测（无从外推） */
const onlyLumpy = Number(db.createDefaultLedger(uid, '仅大额账本'));
addLumpyTxn(100000, '2026-03-05', { noRhythm: 1, ledger: onlyLumpy, account: Number(db.get('SELECT id FROM accounts WHERE ledger_id = ? LIMIT 1', onlyLumpy).id) });
const ol = fc.monthForecast(onlyLumpy, REF);
check('仅一笔大额无日常：不出预测（no-activity）', ol.enough === false && ol.reason === 'no-activity' && ol.lumpy_cents === 100000, JSON.stringify(ol));

/* 预算口径：c1 预算的大额剔除只算 c1 内的（人工标记 1500），c2 的 20000 不混入 */
const lb = fc.budgetForecast(mkBudget({ ledger_id: lumpyLedger, name: '大额分类预算', scope: 'category', category_id: lc1, amount_cents: 999999, is_active: 0 }), REF);
check('分类口径：c1 内 lumpy_used=1500 / lumpy_count=1（20000 在 c2 不混入）',
  lb.enough === true && lb.lumpy_used_cents === 1500 && lb.lumpy_count === 1, JSON.stringify(lb));
check('分类口径：used=4500 / dailySpent=3000 / 预测=4500+6300=10800',
  lb.used_cents === 4500 && lb.forecast_cents === 10800, `used=${lb.used_cents} fc=${lb.forecast_cents}`);

/* --- P2 修复回归：防误伤按「相邻配对成链」判定，多峰簇各自成链互不干扰 ---
 * 造数：8×500 日常 + 同分类两簇 6000×2 与 12000×2 + 另一分类孤立 30000
 * 阈值：中位数 500 → max(5000, 4000) = 5000；两簇都 ≥ 阈值。
 * 旧实现（与组中位数比：组中位 9000 ±10% 内 0 笔）会把 4 笔全剔（lumpy=78000）；
 * 新实现两簇各自成链 → 都不剔，只有孤立 30000 是事件。 */
const peakLedger = Number(db.createDefaultLedger(uid, '多峰账本'));
const peakAcc = Number(db.get('SELECT id FROM accounts WHERE ledger_id = ? LIMIT 1', peakLedger).id);
const pc1 = Number(db.run('INSERT INTO categories (ledger_id, name, kind, parent_id, is_system, sort_order) VALUES (?,?,?,?,0,0)', peakLedger, '多峰用车', 'expense', null).lastInsertRowid);
const pc2 = Number(db.run('INSERT INTO categories (ledger_id, name, kind, parent_id, is_system, sort_order) VALUES (?,?,?,?,0,0)', peakLedger, '多峰其他', 'expense', null).lastInsertRowid);
for (const d of ['01', '02', '03', '04', '05', '06', '07', '08']) addLumpyTxn(500, `2026-03-${d}`, { categoryId: pc1, ledger: peakLedger, account: peakAcc });
addLumpyTxn(6000, '2026-03-02', { categoryId: pc1, ledger: peakLedger, account: peakAcc });
addLumpyTxn(6000, '2026-03-09', { categoryId: pc1, ledger: peakLedger, account: peakAcc });
addLumpyTxn(12000, '2026-03-03', { categoryId: pc1, ledger: peakLedger, account: peakAcc });
addLumpyTxn(12000, '2026-03-08', { categoryId: pc1, ledger: peakLedger, account: peakAcc });
addLumpyTxn(30000, '2026-03-05', { categoryId: pc2, ledger: peakLedger, account: peakAcc });
const pk = fc.lumpyOfMonth(peakLedger, '2026-03');
check('多峰簇：6000×2 与 12000×2 各自成链均不剔，只剔孤立 30000',
  pk.cents === 30000 && pk.count === 1 && pk.threshold_cents === 5000, JSON.stringify(pk));

/* ============================ B. HTTP 端到端 ============================ */

const BASE = 'http://127.0.0.1:8099';
let cookie = '';
async function req(method, p, { form, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (form) h['content-type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(BASE + p, {
    method, headers: h,
    body: form ? new URLSearchParams(form).toString() : undefined,
    redirect: 'manual',
  });
  const sc = res.headers.getSetCookie?.() || [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
const csrfOf = (html) => (html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];

(async () => {
  console.log('\n=== B. 预测展示面（HTTP 端到端 8099）===\n');
  let up = true;
  try { await fetch(BASE + '/login'); } catch { up = false; }
  if (!up) {
    console.log('  SKIP  8099 未启动，跳过 HTTP 段。请先：PORT=8099 HOST=127.0.0.1 DATA_DIR=<repo>/data-verify node server.js');
    console.log(`\n结果：${pass} 通过 / ${fail} 失败（未含 HTTP 段）\n`);
    process.exit(fail ? 1 : 0);
  }

  // HTTP 段用真实「今天」：已过天数 <3 时全局不出预测（月初跑批的合法状态），断言按日分档
  const now = new Date();
  const elapsed = now.getDate();
  const daysTotal = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const remaining = daysTotal - elapsed;
  const forecastable = elapsed >= fc.MIN_ELAPSED_DAYS;
  // 「将超出」只在数学上必然成立的日子断言：外推部分 > 0 需 remaining/elapsed > 0.5（造数见下）
  const overCertain = forecastable && remaining > elapsed * 0.5;

  let r = await req('GET', '/login');
  const login = await req('POST', '/login', { form: { _csrf: csrfOf(r.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', login.status === 302, `HTTP ${login.status}`);

  /* 造数：今天一笔 10 元支出 + 月底前 5 元订阅 + 预算 15 元（外推为正时必然预测超支） */
  r = await req('GET', '/transactions/new');
  const accId = (r.text.match(/name="account_id"[\s\S]*?<option value="(\d+)"/) || [])[1];
  const catId = (r.text.match(/name="category_id"[\s\S]*?<option value="(\d+)"/) || [])[1];
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const post = await req('POST', '/transactions', {
    form: { _csrf: csrfOf(r.text), type: 'expense', amount: '10.00', account_id: accId, category_id: catId, txn_date: today, note: '预测E2E' },
  });
  check('记账接口造数成功', post.status === 302, `HTTP ${post.status}`);

  r = await req('GET', '/subscriptions');
  const scsrf = csrfOf(r.text);
  const month = today.slice(0, 7);
  // 月末最后一天 +1 会造出非法日期，此时订阅对预测必然不可见（明天已跨月），直接跳过造数
  if (now.getDate() + 1 <= daysTotal) {
    const day2 = String(now.getDate() + 1).padStart(2, '0');
    // auto_renew 必须显式带上：readForm 缺省按「仅提醒」处理，不带则订阅对已知扣费恒为 0（死数据）
    const subForm = { _csrf: scsrf, name: '预测E2E订阅', amount: '5', cycle: 'monthly', cycle_n: '1', anchor_day: String(now.getDate() + 1), next_charge_at: `${month}-${day2}`, reminder_days: '3', auto_renew: '1' };
    await req('POST', '/subscriptions', { form: subForm });
  }

  r = await req('GET', '/budgets');
  const csrf = csrfOf(r.text);
  const created = await req('POST', '/budgets', {
    form: { _csrf: csrf, name: '预测E2E预算', amount: '15', scope: 'overall', period: 'monthly', alert_pct: '80', trigger_type: 'expense' },
  });
  check('创建预算返回跳转', created.status === 302, `HTTP ${created.status}`);

  r = await req('GET', '/budgets');
  check('预算页渲染成功', r.status === 200, `HTTP ${r.status}`);
  // 断言按日档位取期望值（而非条件跳过）：任何日期跑断言总数恒定，文档口径不随日期漂移
  check('预算页预测行按日档位出现/不出现（月初 1–2 号全局不出预测）',
    forecastable ? r.text.includes('预计月末') : !r.text.includes('预计月末'), `elapsed=${elapsed}`);
  check('预测口径标注随预测行出现', !forecastable || r.text.includes('按本月日常节奏'), '');
  check('必然超支日挂「将超出」（外推为正的日期档）', !overCertain || r.text.includes('将超出'), '');

  /* 报表页：总口径预测条 */
  r = await req('GET', '/reports');
  check('报表页渲染成功', r.status === 200, `HTTP ${r.status}`);
  check('报表页预测条按日档位出现/不出现', forecastable ? r.text.includes('月末预测') : !r.text.includes('月末预测'), '');

  /* 手机 Tab1：hl_simple=1 强制极简模式 */
  cookie += '; hl_simple=1';
  r = await req('GET', '/');
  check('极简首页渲染成功（layout-m）', r.status === 200 && r.text.includes('mHome'), `HTTP ${r.status}`);
  check('Tab1 预测小字按日档位出现/不出现', forecastable ? r.text.includes('预计月末') : !r.text.includes('预计月末'), '');
  check('Tab1 超支场景带「将超出」（外推为正的日期档）', !overCertain || r.text.includes('将超出'), '');

  /* P7 修订：人工标记层 E2E——手动表单勾「一次性大额」，报表预测条出现剔除标注
   *（放在既有预算页/Tab1 断言之后：500 元入账会让 15 元预算 already-over，不再出预测行）*/
  r = await req('GET', '/transactions/new');
  check('手动表单含「一次性大额」勾选', r.status === 200 && r.text.includes('一次性大额'), `HTTP ${r.status}`);
  const postLumpy = await req('POST', '/transactions', {
    form: { _csrf: csrfOf(r.text), type: 'expense', amount: '500.00', account_id: accId, category_id: catId, txn_date: today, note: '大额E2E', no_rhythm: '1' },
  });
  check('带 no_rhythm 记账成功', postLumpy.status === 302, `HTTP ${postLumpy.status}`);
  if (forecastable) {
    r = await req('GET', '/reports');
    check('报表页预测条带剔除标注（已剔一次性大额）', r.text.includes('已剔一次性大额'), '');
    /* 预算页标注（P1 修复回归）：再建一个大额预算避免 already-over 吞掉预测行，
     lumpy_count=1（500 元人工标记那笔）应渲染「已剔一次性大额 1 笔」 */
    r = await req('GET', '/budgets');
    const csrf2 = csrfOf(r.text);
    await req('POST', '/budgets', { form: { _csrf: csrf2, name: '大额E2E预算', amount: '1000', scope: 'overall', period: 'monthly', alert_pct: '80', trigger_type: 'expense' } });
    r = await req('GET', '/budgets');
    check('预算页预测行带剔除标注（已剔一次性大额 1 笔）', r.text.includes('已剔一次性大额 1 笔'), '');
  } else {
    check('月初档跳过剔除标注断言（全局不出预测）', true, `elapsed=${elapsed}`);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
