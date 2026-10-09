'use strict';
/**
 * 回归：核心记账路径（txn.js 写入/报销/台账 + db.js 余额重算引擎）
 *
 * 这是历史修复重灾区（v1.3.x 借贷口径、v1.6.x 报销/投资双账户等）的首个自动化覆盖。
 * 分两段：
 *   A. 进程内逻辑（独立库 data-verify-txn）：
 *      txnEffects 14 类型余额方向语义、createTransaction 端到端账户余额 Δ、外币换算落本位币、
 *      统计口径（summary 收/支计入与「不计收支」类型 + decorate UI 配色口径）、
 *      写入校验红线（双账户/同账户/零金额/缺账户）、编辑改类型翻向重算 + 编辑投资双账户校验、
 *      报销只收支出/手续费、借贷台账方向/累加/还款抵扣/结清钳制/软删不计、
 *      软删除/恢复/批量删除后的余额重算一致性（不变式对照）
 *   B. HTTP 端到端（需先在 8099 起隔离实例，run-all 会自动拉起）：
 *      记一笔 → 列表可见 → 软删 → 批量恢复 → 报销入账，及缺账户被 400 拒绝
 *
 * 运行：node test/verify-transactions.js
 */
const fs = require('node:fs');
const path = require('node:path');

const TXN_DATA_DIR = path.join(__dirname, '..', 'data-verify-txn');
process.env.DATA_DIR = TXN_DATA_DIR;
fs.rmSync(TXN_DATA_DIR, { recursive: true, force: true });

const db = require('../src/db');
const txn = require('../src/lib/txn');
const auth = require('../src/lib/auth');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}
function expectThrow(name, fn, msgPart) {
  try {
    fn();
    check(name, false, '未抛出异常');
  } catch (e) {
    check(name, !msgPart || String(e.message).includes(msgPart), e.message);
  }
}

db.init();

/* --------------------------------- 测试脚手架 -------------------------------- */

let uid = Number(db.run(
  'INSERT INTO users (username, password_hash, display_name, avatar_color, is_admin, created_at) VALUES (?,?,?,?,1,?)',
  'txnadmin', auth.hashPassword('txn-pass-123'), '记账回归', '#4f7cff', db.nowStr()
).lastInsertRowid);

let ledgerSeq = 1;
/** 建独立账本（互不污染），可选初始化账户 {名称: [类型, 初始分]}，返回 {ledgerId, acc} */
function mkLedger(accounts) {
  const ledgerId = Number(db.run(
    'INSERT INTO ledgers (name, kind, currency, icon, color, owner_id, note, created_at) VALUES (?,?,?,?,?,?,?,?)',
    `记账回归${ledgerSeq++}`, 'personal', 'CNY', '📒', '#4f7cff', uid, '回归', db.nowStr()
  ).lastInsertRowid);
  db.addLedgerMember(ledgerId, uid, 'owner');
  const acc = {};
  for (const [name, [type, initial]] of Object.entries(accounts || {})) {
    acc[name] = Number(db.run(
      `INSERT INTO accounts (ledger_id, name, type, icon, currency, initial_cents, balance_cents, sort_order, created_at)
       VALUES (?,?,?,?,?,?,0,0,?)`,
      ledgerId, name, type, '💵', 'CNY', initial, db.nowStr()
    ).lastInsertRowid);
    accNames.set(acc[name], name);
  }
  // 让 balance_cents 反映 initial_cents（后续断言全部基于「Δ = 操作前后差值」）
  db.recalcBalances(ledgerId);
  return { ledgerId, acc };
}
const accNames = new Map();

const balOf = (id) => Number(db.get('SELECT balance_cents FROM accounts WHERE id = ?', id).balance_cents);

/** 断言一次记账后各账户的余额变化量（分）；返回交易 id */
function expectDelta(tag, params, deltas) {
  const before = new Map(Object.keys(deltas).map((k) => [Number(k), balOf(k)]));
  const id = txn.createTransaction(tag.ledgerId, uid, params);
  for (const [k, d] of Object.entries(deltas)) {
    const after = balOf(k);
    const actual = after - before.get(Number(k));
    const accLabel = accNames.get(Number(k)) || `账户#${k}`;
    check(`${tag.label}：${accLabel} Δ${d >= 0 ? '+' : ''}${(d / 100).toFixed(2)} 元`, actual === d, `实际 Δ${(actual / 100).toFixed(2)}`);
  }
  return id;
}

/** 余额不变式：每个账户余额 === initial_cents + Σ txnEffects(未删除交易)。任何写路径跑完后调用。 */
function invariant(label, ledgerId) {
  const accs = db.all('SELECT id, initial_cents, balance_cents FROM accounts WHERE ledger_id = ?', ledgerId);
  const txns = db.all('SELECT * FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL', ledgerId);
  const expect = new Map(accs.map((a) => [Number(a.id), Number(a.initial_cents)]));
  for (const t of txns) {
    for (const e of db.txnEffects(t)) expect.set(e.accountId, (expect.get(e.accountId) || 0) + e.delta);
  }
  const bad = [];
  for (const a of accs) {
    const exp = expect.get(Number(a.id)) || 0;
    if (exp !== Number(a.balance_cents)) bad.push(`#${a.id} 期望${exp} 实际${a.balance_cents}`);
  }
  check(`余额不变式（${label}）`, !bad.length, bad.join('; '));
}

/* ============================ A1. txnEffects 单元语义 ============================ */

console.log('\n=== A1. txnEffects：14 类型余额方向（余额重算引擎的总开关）===\n');

const eff = (t) => db.txnEffects({ account_id: 7, to_account_id: 9, amount_base_cents: 100, ...t });
// 按 accountId→delta 比较语义，不锁定双条目类型的返回顺序（那是实现细节）
const effEq = (t, want) => {
  const got = eff(t);
  if (got.length !== want.length) return false;
  const byAcc = new Map(got.map((e) => [e.accountId, e.delta]));
  return want.every((e) => byAcc.get(e.accountId) === e.delta);
};

check('expense：账户 -金额', effEq({ type: 'expense' }, [{ accountId: 7, delta: -100 }]), JSON.stringify(eff({ type: 'expense' })));
check('lend：账户 -金额（钱出去了，但不算支出）', effEq({ type: 'lend' }, [{ accountId: 7, delta: -100 }]));
check('repay_pay：账户 -金额', effEq({ type: 'repay_pay' }, [{ accountId: 7, delta: -100 }]));
check('fee：账户 -金额', effEq({ type: 'fee' }, [{ accountId: 7, delta: -100 }]));
check('income：账户 +金额', effEq({ type: 'income' }, [{ accountId: 7, delta: 100 }]));
check('borrow：账户 +金额（钱进来了，但不算收入）', effEq({ type: 'borrow' }, [{ accountId: 7, delta: 100 }]));
check('repay_receive：账户 +金额', effEq({ type: 'repay_receive' }, [{ accountId: 7, delta: 100 }]));
check('reimburse：账户 +金额', effEq({ type: 'reimburse' }, [{ accountId: 7, delta: 100 }]));
check('refund：账户 +金额', effEq({ type: 'refund' }, [{ accountId: 7, delta: 100 }]));
check('interest：账户 +金额', effEq({ type: 'interest' }, [{ accountId: 7, delta: 100 }]));
check('transfer：转出 -、转入 +', effEq({ type: 'transfer' }, [{ accountId: 7, delta: -100 }, { accountId: 9, delta: 100 }]), JSON.stringify(eff({ type: 'transfer' })));
check('invest_buy：出资账户 -、投资账户 +', effEq({ type: 'invest_buy' }, [{ accountId: 7, delta: -100 }, { accountId: 9, delta: 100 }]));
check('invest_sell：投资账户 -、出资账户 +（方向与买入相反）', effEq({ type: 'invest_sell' }, [{ accountId: 9, delta: -100 }, { accountId: 7, delta: 100 }]));
check('adjust 正数：账户 +差额', effEq({ type: 'adjust', amount_base_cents: 250 }, [{ accountId: 7, delta: 250 }]));
check('adjust 负数：账户 -差额（调减为带符号负数）', effEq({ type: 'adjust', amount_base_cents: -250 }, [{ accountId: 7, delta: -250 }]));
check('未知类型兜底：按支出方向扣款', effEq({ type: 'mystery' }, [{ accountId: 7, delta: -100 }]));

/* ====================== A2. createTransaction 端到端余额方向 ====================== */

console.log('\n=== A2. 记账后账户余额端到端（Δ 断言，含双账户类型与余额调整）===\n');

const L1 = mkLedger({ 现金: ['cash', 10000], 银行: ['debit', 0], 投资: ['investment', 0] });
const { ledgerId, acc } = L1;
invariant('建账本后', ledgerId);

let tid;
tid = expectDelta({ ledgerId, label: '收入' }, { type: 'income', amount_cents: 5000, account_id: acc.现金 }, { [acc.现金]: 5000 });
tid = expectDelta({ ledgerId, label: '支出' }, { type: 'expense', amount_cents: 3000, account_id: acc.现金 }, { [acc.现金]: -3000 });
tid = expectDelta({ ledgerId, label: '转账' }, { type: 'transfer', amount_cents: 2345, account_id: acc.现金, to_account_id: acc.银行 }, { [acc.现金]: -2345, [acc.银行]: 2345 });
tid = expectDelta({ ledgerId, label: '借出' }, { type: 'lend', amount_cents: 1111, account_id: acc.现金, merchant: '张三' }, { [acc.现金]: -1111 });
tid = expectDelta({ ledgerId, label: '借入' }, { type: 'borrow', amount_cents: 2222, account_id: acc.银行, merchant: '李四' }, { [acc.银行]: 2222 });
tid = expectDelta({ ledgerId, label: '收回借款' }, { type: 'repay_receive', amount_cents: 400, account_id: acc.现金, merchant: '张三' }, { [acc.现金]: 400 });
tid = expectDelta({ ledgerId, label: '偿还借款' }, { type: 'repay_pay', amount_cents: 300, account_id: acc.现金, merchant: '李四' }, { [acc.现金]: -300 });
tid = expectDelta({ ledgerId, label: '退款' }, { type: 'refund', amount_cents: 500, account_id: acc.现金 }, { [acc.现金]: 500 });
tid = expectDelta({ ledgerId, label: '手续费' }, { type: 'fee', amount_cents: 250, account_id: acc.现金 }, { [acc.现金]: -250 });
tid = expectDelta({ ledgerId, label: '利息收入' }, { type: 'interest', amount_cents: 150, account_id: acc.现金 }, { [acc.现金]: 150 });
tid = expectDelta({ ledgerId, label: '投资买入' }, { type: 'invest_buy', amount_cents: 2000, account_id: acc.银行, to_account_id: acc.投资 }, { [acc.银行]: -2000, [acc.投资]: 2000 });
tid = expectDelta({ ledgerId, label: '投资卖出' }, { type: 'invest_sell', amount_cents: 600, account_id: acc.银行, to_account_id: acc.投资 }, { [acc.投资]: -600, [acc.银行]: 600 });
tid = expectDelta({ ledgerId, label: '余额调增' }, { type: 'adjust', amount_cents: 2500, account_id: acc.银行 }, { [acc.银行]: 2500 });
tid = expectDelta({ ledgerId, label: '余额调减' }, { type: 'adjust', amount_cents: -800, account_id: acc.银行 }, { [acc.银行]: -800 });
tid = expectDelta({ ledgerId, label: '支出金额为负数输入' }, { type: 'expense', amount_cents: -500, account_id: acc.现金 }, { [acc.现金]: -500 });
check('负数输入按绝对值落库（amount_cents=500）', db.get('SELECT amount_cents FROM transactions WHERE id = ?', tid).amount_cents === 500);
invariant('A2 全类型记账后', ledgerId);

/* ----------------------------- A3. 外币汇率换算 ----------------------------- */

console.log('\n=== A3. 外币金额换算落本位币 ===\n');

const fxBefore = balOf(acc.现金);
const fxId = txn.createTransaction(ledgerId, uid, { type: 'expense', amount_cents: 10000, currency: 'USD', rate: 7.15, account_id: acc.现金 });
const fxRow = db.get('SELECT amount_cents, currency, rate, amount_base_cents FROM transactions WHERE id = ?', fxId);
check('原币金额与汇率照存（10000 分 × 7.15）', fxRow.amount_cents === 10000 && fxRow.currency === 'USD' && fxRow.rate === 7.15, JSON.stringify(fxRow));
check('本位币金额 = round(原币 × 汇率) = 71500 分', fxRow.amount_base_cents === 71500, String(fxRow.amount_base_cents));
check('账户余额按本位币扣减 715 元', balOf(acc.现金) === fxBefore - 71500, `实际 Δ${((balOf(acc.现金) - fxBefore) / 100).toFixed(2)} 元`);
invariant('外币记账后', ledgerId);

/* ================================ A4. 统计口径 ================================ */

console.log('\n=== A4. 统计口径：summary 收支计入 + decorate UI 配色口径 ===\n');

const L2 = mkLedger({ 甲: ['cash', 0], 乙: ['debit', 0] });
const m = db.todayStr().slice(0, 7);
const add = (t) => txn.createTransaction(L2.ledgerId, uid, { account_id: L2.acc.甲, to_account_id: L2.acc.乙, ...t });
add({ type: 'income', amount_cents: 1000 });
add({ type: 'interest', amount_cents: 200 });
add({ type: 'refund', amount_cents: 300 });
add({ type: 'reimburse', amount_cents: 400 });
add({ type: 'expense', amount_cents: 500 });
add({ type: 'fee', amount_cents: 100 });
let s = txn.summary(L2.ledgerId, `${m}-01`, `${m}-31`);
check('收入口径 = income+interest+refund+reimburse（1900）', s.income === 1900, `income=${s.income}`);
check('支出口径 = expense+fee（600）', s.expense === 600, `expense=${s.expense}`);
// 「不计收支」类型：钱在账户间移动或资产负债互换，进统计只会虚增
add({ type: 'borrow', amount_cents: 900 });
add({ type: 'lend', amount_cents: 700 });
add({ type: 'transfer', amount_cents: 100 });
add({ type: 'invest_buy', amount_cents: 200 });
add({ type: 'invest_sell', amount_cents: 50 });
add({ type: 'adjust', amount_cents: 300 });
add({ type: 'repay_receive', amount_cents: 10 });
add({ type: 'repay_pay', amount_cents: 20 });
s = txn.summary(L2.ledgerId, `${m}-01`, `${m}-31`);
check('借贷/转账/投资/调整/还款全部不计收支（仍是 1900/600）', s.income === 1900 && s.expense === 600, `income=${s.income} expense=${s.expense}`);
check('summary 笔数含全部类型（14 笔）', s.count === 14, String(s.count));

const colorCase = [
  ['expense', false, true], ['fee', false, true], ['lend', false, true], ['repay_pay', false, true],
  ['income', true, false], ['interest', true, false], ['refund', true, false], ['reimburse', true, false],
  ['borrow', true, false], ['repay_receive', true, false],
  ['transfer', false, false], ['invest_buy', false, false], ['invest_sell', false, false], ['adjust', false, false],
];
let colorOk = true;
const colorBad = [];
for (const [type, inc, exp] of colorCase) {
  const d = txn.decorate({ type });
  if (d.is_income !== inc || d.is_expense !== exp) { colorOk = false; colorBad.push(`${type}(in=${d.is_income},exp=${d.is_expense})`); }
}
check('UI 配色口径：借入显收入色/借出显支出色/转账投资调整中性', colorOk, colorBad.join(' '));

/* =============================== A5. 写入校验红线 =============================== */

console.log('\n=== A5. 写入校验：双账户 / 同账户 / 零金额 / 缺账户 ===\n');

expectThrow('转账缺转入账户被拒', () => txn.createTransaction(L2.ledgerId, uid, { type: 'transfer', amount_cents: 100, account_id: L2.acc.甲 }), '转账需要');
expectThrow('转账双方相同被拒', () => txn.createTransaction(L2.ledgerId, uid, { type: 'transfer', amount_cents: 100, account_id: L2.acc.甲, to_account_id: L2.acc.甲 }), '不能相同');
expectThrow('投资买入缺入账账户被拒', () => txn.createTransaction(L2.ledgerId, uid, { type: 'invest_buy', amount_cents: 100, account_id: L2.acc.甲 }), '投资买入/卖出需要');
expectThrow('投资卖出双方相同被拒', () => txn.createTransaction(L2.ledgerId, uid, { type: 'invest_sell', amount_cents: 100, account_id: L2.acc.甲, to_account_id: L2.acc.甲 }), '不能相同');
expectThrow('不存在的账户 id 视同缺账户被拒', () => txn.createTransaction(L2.ledgerId, uid, { type: 'invest_buy', amount_cents: 100, account_id: L2.acc.甲, to_account_id: 999999999 }), '投资买入/卖出需要');
expectThrow('零金额被拒', () => txn.createTransaction(L2.ledgerId, uid, { type: 'expense', amount_cents: 0, account_id: L2.acc.甲 }), '金额必须大于 0');
expectThrow('借出缺账户被拒', () => txn.createTransaction(L2.ledgerId, uid, { type: 'lend', amount_cents: 100 }), '请选择账户');
expectThrow('余额调整缺账户被拒', () => txn.createTransaction(L2.ledgerId, uid, { type: 'adjust', amount_cents: 100 }), '余额调整需要指定账户');
check('被拒的写入均未落库', db.get('SELECT COUNT(*) AS c FROM transactions WHERE ledger_id = ?', L2.ledgerId).c === 14, String(db.get('SELECT COUNT(*) AS c FROM transactions WHERE ledger_id = ?', L2.ledgerId).c));

/* ========================= A6. 编辑改类型翻向 + 编辑校验 ========================= */

console.log('\n=== A6. 编辑：类型改向重算余额 + 投资双账户校验（与创建同规则）===\n');

const L3 = mkLedger({ 现金: ['cash', 0], 银行: ['debit', 0] });
const e6 = txn.createTransaction(L3.ledgerId, uid, { type: 'expense', amount_cents: 1000, account_id: L3.acc.现金 });
check('支出入账后现金 -10 元', balOf(L3.acc.现金) === -1000, String(balOf(L3.acc.现金)));
txn.updateTransaction(e6, L3.ledgerId, uid, { type: 'income', amount_cents: 1000, account_id: L3.acc.现金 });
check('编辑为收入后现金翻向 +10 元（全量重算）', balOf(L3.acc.现金) === 1000, String(balOf(L3.acc.现金)));
txn.updateTransaction(e6, L3.ledgerId, uid, { type: 'transfer', amount_cents: 800, account_id: L3.acc.现金, to_account_id: L3.acc.银行 });
check('编辑为转账后现金 -8 元', balOf(L3.acc.现金) === -800, String(balOf(L3.acc.现金)));
check('编辑为转账后银行 +8 元', balOf(L3.acc.银行) === 800, String(balOf(L3.acc.银行)));

const e6b = txn.createTransaction(L3.ledgerId, uid, { type: 'invest_buy', amount_cents: 500, account_id: L3.acc.现金, to_account_id: L3.acc.银行 });
const beforeEdit = balOf(L3.acc.现金);
expectThrow('编辑投资交易丢转入账户被拒（与创建同规则）', () => txn.updateTransaction(e6b, L3.ledgerId, uid, { type: 'invest_buy', amount_cents: 500, account_id: L3.acc.现金 }), '投资买入/卖出需要');
expectThrow('编辑投资交易双方相同被拒', () => txn.updateTransaction(e6b, L3.ledgerId, uid, { type: 'invest_buy', amount_cents: 500, account_id: L3.acc.现金, to_account_id: L3.acc.现金 }), '不能相同');
check('被拒的编辑不改动余额', balOf(L3.acc.现金) === beforeEdit, `现金=${balOf(L3.acc.现金)}`);
expectThrow('编辑清空必填账户被拒（与创建同规则）', () => txn.updateTransaction(e6, L3.ledgerId, uid, { type: 'expense', amount_cents: 1000, account_id: null }), '请选择账户');
expectThrow('编辑余额调整清空账户被拒', () => txn.updateTransaction(e6, L3.ledgerId, uid, { type: 'adjust', amount_cents: 100, account_id: null }), '余额调整需要指定账户');
invariant('A6 编辑后', L3.ledgerId);

/* ================================= A7. 报销 ================================= */

console.log('\n=== A7. 报销：只收支出/手续费、生成入账、标记原笔、不可重复 ===\n');

const L4 = mkLedger({ 现金: ['cash', 0] });
const r1 = txn.createTransaction(L4.ledgerId, uid, { type: 'expense', amount_cents: 3000, account_id: L4.acc.现金, is_reimbursable: 1 });
const r2 = txn.createTransaction(L4.ledgerId, uid, { type: 'fee', amount_cents: 1200, account_id: L4.acc.现金, is_reimbursable: 1 });
const r3 = txn.createTransaction(L4.ledgerId, uid, { type: 'expense', amount_cents: 500, account_id: L4.acc.现金 });
const r4 = txn.createTransaction(L4.ledgerId, uid, { type: 'income', amount_cents: 800, account_id: L4.acc.现金, is_reimbursable: 1 });
const r5 = txn.createTransaction(L4.ledgerId, uid, { type: 'expense', amount_cents: 700, account_id: L4.acc.现金, is_reimbursable: 1 });
txn.softDelete(r5, L4.ledgerId);

const reimb = txn.markReimbursed([r1, r2, r3, r4, r5], L4.ledgerId, uid, L4.acc.现金);
check('只收未删且待报销的支出/手续费（2 笔 42 元），收入/非报销/已删排除', reimb.count === 2 && reimb.total === 4200, `count=${reimb.count} total=${reimb.total}`);
// 现金期末 = -30(r1) -12(r2) -5(r3) +8(r4) +42(报销入账) = +3 元（r5 已删不计）
check('报销入账后现金余额 3 元', balOf(L4.acc.现金) === 300, String(balOf(L4.acc.现金)));
const reimbTxn = db.get("SELECT * FROM transactions WHERE ledger_id = ? AND type = 'reimburse'", L4.ledgerId);
check('生成 reimburse 类型入账且金额=合计', !!reimbTxn && reimbTxn.amount_base_cents === 4200, JSON.stringify(reimbTxn && { amount: reimbTxn.amount_base_cents }));
const r1row = db.get('SELECT reimbursed_at, related_id FROM transactions WHERE id = ?', r1);
const r3row = db.get('SELECT reimbursed_at FROM transactions WHERE id = ?', r3);
check('原笔标记报销时间并关联报销单', !!r1row.reimbursed_at && Number(r1row.related_id) === Number(reimbTxn.id), JSON.stringify(r1row));
check('非报销笔不受影响', r3row.reimbursed_at === null);
expectThrow('已报销笔不能再次报销', () => txn.markReimbursed([r1, r2], L4.ledgerId, uid, L4.acc.现金), '没有可报销的记录');
expectThrow('收入类型不能走报销', () => txn.markReimbursed([r4], L4.ledgerId, uid, L4.acc.现金), '没有可报销的记录');
expectThrow('空列表被拒', () => txn.markReimbursed([], L4.ledgerId, uid, L4.acc.现金), '没有可报销');
invariant('报销后', L4.ledgerId);

/* =============================== A8. 借贷台账联动 =============================== */

console.log('\n=== A8. 借贷台账：方向/累加/还款抵扣/结清钳制/软删不计/手工行保留 ===\n');

const L5 = mkLedger({ 现金: ['cash', 50000] });
txn.createTransaction(L5.ledgerId, uid, { type: 'lend', amount_cents: 1000, account_id: L5.acc.现金, merchant: '张三' });
txn.createTransaction(L5.ledgerId, uid, { type: 'lend', amount_cents: 500, account_id: L5.acc.现金, merchant: '张三' });
txn.createTransaction(L5.ledgerId, uid, { type: 'borrow', amount_cents: 2000, account_id: L5.acc.现金, merchant: '李四' });
let dZ = db.get("SELECT * FROM debts WHERE ledger_id = ? AND counterparty = '张三'", L5.ledgerId);
let dL = db.get("SELECT * FROM debts WHERE ledger_id = ? AND counterparty = '李四'", L5.ledgerId);
check('借出生成应收台账（同人两笔自动累加 15 元）', dZ && dZ.direction === 'receivable' && dZ.principal_cents === 1500 && dZ.balance_cents === 1500 && dZ.status === 'open', JSON.stringify(dZ));
check('借入生成应付台账（20 元）', dL && dL.direction === 'payable' && dL.principal_cents === 2000 && dL.status === 'open', JSON.stringify(dL));

txn.createTransaction(L5.ledgerId, uid, { type: 'repay_receive', amount_cents: 400, account_id: L5.acc.现金, merchant: '张三' });
txn.createTransaction(L5.ledgerId, uid, { type: 'repay_pay', amount_cents: 2500, account_id: L5.acc.现金, merchant: '李四' });
dZ = db.get("SELECT * FROM debts WHERE ledger_id = ? AND counterparty = '张三'", L5.ledgerId);
dL = db.get("SELECT * FROM debts WHERE ledger_id = ? AND counterparty = '李四'", L5.ledgerId);
check('收还款抵扣应收（15-4=11 元）', dZ.balance_cents === 1100, String(dZ.balance_cents));
check('超额偿还钳制为 0 并结清（20-25 → 0，不出负数）', dL.balance_cents === 0 && dL.status === 'closed', `balance=${dL.balance_cents} status=${dL.status}`);

db.run("INSERT INTO debts (ledger_id, direction, counterparty, principal_cents, balance_cents, status, note, created_at) VALUES (?,?,?,?,?,?,?,?)",
  L5.ledgerId, 'receivable', '王五', 999, 999, 'open', '手工登记', db.nowStr());
const lendDel = db.get("SELECT id FROM transactions WHERE ledger_id = ? AND type = 'lend' AND amount_base_cents = 1000", L5.ledgerId);
txn.softDelete(Number(lendDel.id), L5.ledgerId);
dZ = db.get("SELECT * FROM debts WHERE ledger_id = ? AND counterparty = '张三'", L5.ledgerId);
check('软删借出后台账按存活流水重建（5-4=1 元）', dZ.principal_cents === 500 && dZ.balance_cents === 100, `principal=${dZ.principal_cents} balance=${dZ.balance_cents}`);
check('手工登记的台账行不被自动汇总清除', !!db.get("SELECT id FROM debts WHERE ledger_id = ? AND counterparty = '王五' AND note = '手工登记'", L5.ledgerId));
invariant('台账联动后', L5.ledgerId);

/* ===================== A9. 软删除 / 恢复 / 批量删除一致性 ===================== */

console.log('\n=== A9. 软删除/恢复/批量删除后的余额重算一致性 ===\n');

const L6 = mkLedger({ 现金: ['cash', 10000], 银行: ['debit', 0] });
const t1 = txn.createTransaction(L6.ledgerId, uid, { type: 'transfer', amount_cents: 3000, account_id: L6.acc.现金, to_account_id: L6.acc.银行 });
const t2 = txn.createTransaction(L6.ledgerId, uid, { type: 'expense', amount_cents: 500, account_id: L6.acc.现金 });
const t3 = txn.createTransaction(L6.ledgerId, uid, { type: 'income', amount_cents: 1200, account_id: L6.acc.银行 });
check('软删除返回 false（不存在的记录）', txn.softDelete(999999, L6.ledgerId) === false);

txn.softDelete(t1, L6.ledgerId);
check('软删转账后现金回补（10000-500=9500）', balOf(L6.acc.现金) === 9500, String(balOf(L6.acc.现金)));
check('软删转账后银行回吐（1200）', balOf(L6.acc.银行) === 1200, String(balOf(L6.acc.银行)));
invariant('软删后', L6.ledgerId);

// 恢复路径与 transactions.js /:id/bulk action=restore、openapi /transactions/:id/restore 相同三步
db.run('UPDATE transactions SET deleted_at = NULL WHERE id = ?', t1);
db.recalcBalances(L6.ledgerId);
txn.syncDebts(L6.ledgerId);
check('恢复后现金回到 6500', balOf(L6.acc.现金) === 6500, String(balOf(L6.acc.现金)));
check('恢复后银行回到 4200', balOf(L6.acc.银行) === 4200, String(balOf(L6.acc.银行)));
invariant('恢复后', L6.ledgerId);

const n = txn.bulkDelete([t2, t3], L6.ledgerId);
check('批量软删笔数正确', n === 2, String(n));
check('批量删除后现金 7000（转账生效、支出回补）', balOf(L6.acc.现金) === 7000, String(balOf(L6.acc.现金)));
check('批量删除后银行 3000（仅转账生效）', balOf(L6.acc.银行) === 3000, String(balOf(L6.acc.银行)));
invariant('批量删除后', L6.ledgerId);

// 注意：run-all 按输出中第一个「N 通过 / M 失败」行取数，这里只在最终/提前退出时打一次结果行
if (fail) { console.log(`\n结果：${pass} 通过 / ${fail} 失败（进程内段未全过，跳过 HTTP 段）\n`); process.exit(1); }

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
  return { status: res.status, text: buf.toString('utf8') };
}
const csrfOf = (html) => (html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];

(async () => {
  console.log('\n=== B. 记一笔 → 软删 → 恢复 → 报销（HTTP 端到端 8099）===\n');
  let up = true;
  try { await fetch(BASE + '/login'); } catch { up = false; }
  if (!up) {
    console.log('  SKIP  8099 未启动，跳过 HTTP 段（8099 实例的库与进程内段 data-verify-txn 互不相干）。手工验证：PORT=8099 HOST=127.0.0.1 DATA_DIR=<repo>/data-verify node server.js');
    console.log(`\n结果：${pass} 通过 / ${fail} 失败（未含 HTTP 段）\n`);
    process.exit(fail ? 1 : 0);
  }

  let r = await req('GET', '/login');
  const login = await req('POST', '/login', { form: { _csrf: csrfOf(r.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', login.status === 302, `HTTP ${login.status}`);

  r = await req('GET', '/transactions/new');
  const accId = (r.text.match(/name="account_id"[\s\S]*?<option value="(\d+)"/) || [])[1];
  const csrf = csrfOf(r.text);
  check('记一笔表单可解析到账户 id 与 CSRF 令牌', !!accId && !!csrf, `id=${accId}`);

  // 缺账户的转账被 400 拒绝（readForm → createTransaction 校验链路）
  r = await req('POST', '/transactions', { form: { _csrf: csrf, _json: '1', type: 'transfer', amount: '1.00', account_id: accId } });
  check('缺转入账户 HTTP 400 + 中文错误', r.status === 400 && r.text.includes('转账需要'), `HTTP ${r.status}`);

  r = await req('POST', '/transactions', { form: { _csrf: csrf, _json: '1', type: 'expense', amount: '12.50', account_id: accId, note: '回归E2E支出' } });
  const j = JSON.parse(r.text);
  check('记一笔返回 ok + id', r.status === 200 && j.ok && Number(j.id) > 0, r.text.slice(0, 120));
  const txId = j.id;

  r = await req('GET', '/transactions');
  check('列表可见新记录', r.text.includes('回归E2E支出'), '');

  r = await req('POST', `/transactions/${txId}/delete`, { form: { _csrf: csrf, _json: '1' } });
  check('软删除返回 ok', r.status === 200 && r.text.includes('"ok":true'), r.text.slice(0, 80));
  r = await req('GET', '/transactions');
  check('软删后列表不可见', !r.text.includes('回归E2E支出'), '');

  r = await req('POST', '/transactions/bulk', { form: { _csrf: csrf, action: 'restore', ids: String(txId), back: '/transactions' } });
  check('批量恢复返回跳转', r.status === 302, `HTTP ${r.status}`);
  r = await req('GET', '/transactions');
  check('恢复后列表重新可见', r.text.includes('回归E2E支出'), '');

  r = await req('POST', '/transactions', { form: { _csrf: csrf, _json: '1', type: 'expense', amount: '88.00', account_id: accId, is_reimbursable: '1', note: '回归E2E报销' } });
  const txId2 = JSON.parse(r.text).id;
  r = await req('POST', '/transactions/bulk', { form: { _csrf: csrf, action: 'reimburse', ids: String(txId2), back: '/transactions' } });
  check('报销返回跳转', r.status === 302, `HTTP ${r.status}`);
  r = await req('GET', '/transactions');
  check('报销提示与报销入账可见', r.text.includes('已标记 1 笔为已报销') && r.text.includes('报销 1 笔，合计 88.00'), '');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
