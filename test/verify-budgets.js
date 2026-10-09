'use strict';
/**
 * 回归：预算管理（按分类支持大分类）
 *
 * 分两段：
 *   A. 进程内逻辑（独立库 data-verify-budget）：
 *      大分类预算聚合（自身+全部子分类）、子分类预算不越界、统计对象（支出/收入）口径、账户范围、周期区间
 *   B. HTTP 端到端（需先在 8099 起隔离实例，run-all 会自动拉起）：
 *      页面渲染含大分类选项（支出+收入两套）、创建大分类预算、列表标注（整个大分类）、
 *      非法分类 id 被置空、收入预算端到端 + 编辑保留统计对象
 *
 * 运行：node test/verify-budgets.js
 */
const fs = require('node:fs');
const path = require('node:path');

const BUDGET_DATA_DIR = path.join(__dirname, '..', 'data-verify-budget');
process.env.DATA_DIR = BUDGET_DATA_DIR;
fs.rmSync(BUDGET_DATA_DIR, { recursive: true, force: true });

const db = require('../src/db');
const sch = require('../src/lib/scheduler');
const auth = require('../src/lib/auth');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}

/* ============================ A. 进程内逻辑 ============================ */

console.log('\n=== A. 预算统计逻辑（进程内）===\n');

db.init();

const uid = Number(db.run(
  'INSERT INTO users (username, password_hash, display_name, avatar_color, is_admin, created_at) VALUES (?,?,?,?,1,?)',
  'budgetadmin', auth.hashPassword('budget-pass-123'), '预算测试', '#4f7cff', db.nowStr()
).lastInsertRowid);
const ledgerId = Number(db.createDefaultLedger(uid, '预算测试'));
const accountId = Number(db.get('SELECT id FROM accounts WHERE ledger_id = ? LIMIT 1', ledgerId).id);

/* 系统分类里找一个有子分类的支出大分类 + 它的两个子分类 */
const root = db.get(
  `SELECT * FROM categories WHERE is_system = 1 AND parent_id IS NULL AND kind = 'expense'
   AND id IN (SELECT parent_id FROM categories WHERE parent_id IS NOT NULL) LIMIT 1`
);
const kids = db.all('SELECT * FROM categories WHERE parent_id = ? ORDER BY id LIMIT 2', root.id);
check('找到有子分类的支出大分类', !!root && kids.length === 2, root ? `${root.name}（${kids.length} 子分类取 2）` : '未找到');

const incomeRoot = db.get(
  `SELECT * FROM categories WHERE is_system = 1 AND parent_id IS NULL AND kind = 'income' LIMIT 1`
);
const incomeKid = db.get('SELECT * FROM categories WHERE parent_id = ? LIMIT 1', incomeRoot.id) || incomeRoot;

function addTxn(categoryId, cents, type, date) {
  db.run(
    `INSERT INTO transactions
     (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, to_account_id, category_id,
      user_id, txn_date, note, status, source, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?)`,
    ledgerId, type, cents, 'CNY', 1, cents, accountId, categoryId, uid, date, '预算回归', 'cleared', 'manual', db.nowStr(), db.nowStr()
  );
}
const today = db.todayStr();
addTxn(kids[0].id, 3000, 'expense', today);   // 子分类 A：30
addTxn(kids[1].id, 2000, 'expense', today);   // 子分类 B：20
addTxn(root.id, 1000, 'expense', today);      // 直接记在大分类上：10
addTxn(incomeKid.id, 5000, 'income', today);  // 收入子分类：50

function mkBudget(fields) {
  const base = {
    ledger_id: ledgerId, name: '测试预算', scope: 'category', category_id: null, account_id: null,
    period: 'monthly', amount_cents: 100000, currency: 'CNY', trigger_type: 'expense',
    rollover: 0, alert_pct: 80, start_date: null, end_date: null, is_active: 1, created_at: db.nowStr(),
  };
  const info = db.run(
    `INSERT INTO budgets (ledger_id, name, scope, category_id, account_id, period, amount_cents, currency,
      trigger_type, rollover, alert_pct, start_date, end_date, is_active, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ...Object.entries(base).map(([k, v]) => (fields[k] !== undefined ? fields[k] : v))
  );
  return db.get('SELECT * FROM budgets WHERE id = ?', Number(info.lastInsertRowid));
}
const monthRange = sch.budgetPeriodRange({ period: 'monthly' });
const usedOf = (b) => sch.budgetUsedInRange(b, monthRange.start, monthRange.end);

/* --- 大分类聚合 --- */
const rootBudget = mkBudget({ name: '大分类预算', category_id: root.id });
check('大分类预算：聚合自身 + 全部子分类（30+20+10=60 元）', usedOf(rootBudget) === 6000, `used=${usedOf(rootBudget)}`);

const kidBudget = mkBudget({ name: '子分类预算', category_id: kids[0].id });
check('子分类预算：只统计本子分类（30 元，不含兄弟/父）', usedOf(kidBudget) === 3000, `used=${usedOf(kidBudget)}`);

/* --- 统计对象口径 --- */
const incomeBudget = mkBudget({ name: '收入预算', category_id: incomeRoot.id, trigger_type: 'income' });
check('收入预算：统计该分类下收入（50 元）', usedOf(incomeBudget) === 5000, `used=${usedOf(incomeBudget)}`);
check('支出口径下同分类不计收入', usedOf(mkBudget({ name: '支出口径', category_id: incomeRoot.id })) === 0);

/* --- 账户范围 --- */
const accBudget = mkBudget({ name: '账户预算', scope: 'account', account_id: accountId });
check('账户预算：统计该账户全部支出（30+20+10=60 元，不含收入）', usedOf(accBudget) === 6000, `used=${usedOf(accBudget)}`);

/* --- 周期区间 --- */
const prCustom = sch.budgetPeriodRange({ period: 'custom', start_date: '2026-10-31', end_date: '2026-10-01' });
check('自定义周期起止填反自动交换', prCustom.start === '2026-10-01' && prCustom.end === '2026-10-31', `${prCustom.start}~${prCustom.end}`);
check('月度区间为本月 1 日~月末', monthRange.start.endsWith('-01') && monthRange.end >= monthRange.start, `${monthRange.start}~${monthRange.end}`);

/* --- 预算智能建议（P6）：近 6 个完整自然月（不含本月）月均 + 建议区间 --- */
// 近 4 个完整月每月 30 元餐饮（子分类 A），跨年也正确（Date 数学回退月份）
const monthBack = (n) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
for (let back = 1; back <= 4; back++) addTxn(kids[0].id, 3000, 'expense', `${monthBack(back)}-15`);
// 收入口径只铺 2 个月（触发「历史不足」）
for (let back = 1; back <= 2; back++) addTxn(incomeKid.id, 5000, 'income', `${monthBack(back)}-15`);

const sg = sch.budgetSuggestion({ ledger_id: ledgerId, scope: 'category', category_id: root.id, trigger_type: 'expense' });
check('分类建议：近 4 个月有记录（covered=4，本月与更早不计）', sg.enough === true && sg.months_covered === 4, JSON.stringify(sg));
check('分类建议：avg6=120/6=20 元、avg3=30 元（只看最近 3 个完整月）', sg.avg6_cents === 2000 && sg.avg3_cents === 3000, `avg6=${sg.avg6_cents} avg3=${sg.avg3_cents}`);
check('分类建议：区间 = 月均×1.05~1.1 取整到元（21~22 元）', sg.suggest_low_cents === 2100 && sg.suggest_high_cents === 2200, `low=${sg.suggest_low_cents} high=${sg.suggest_high_cents}`);
const sgAll = sch.budgetSuggestion({ ledger_id: ledgerId, scope: 'overall', trigger_type: 'expense' });
check('总预算口径也有建议（窗口内 4 个月 ≥3）', sgAll.enough === true && sgAll.months_covered >= 3, JSON.stringify(sgAll));
const sgInc = sch.budgetSuggestion({ ledger_id: ledgerId, scope: 'category', category_id: incomeRoot.id, trigger_type: 'income' });
check('历史不足 3 个月不给建议（收入口径仅 2 个月）', sgInc.enough === false && sgInc.months_covered === 2, JSON.stringify(sgInc));
const sgThin = sch.budgetSuggestion({ ledger_id: ledgerId, scope: 'account', account_id: accountId, trigger_type: 'expense' });
check('账户口径可用（同窗口）', sgThin.enough === true && sgThin.months_covered === 4, JSON.stringify(sgThin));
// 跨年窗口：固定日期 + 固定参照日，不依赖真实运行日期
const crossCat = Number(db.run(
  'INSERT INTO categories (ledger_id, name, kind, parent_id, is_system, sort_order) VALUES (?,?,?,?,0,0)',
  ledgerId, '跨年测试分类', 'expense', null
).lastInsertRowid);
for (const d of ['2025-11-15', '2025-12-15', '2026-01-15']) addTxn(crossCat, 1000, 'expense', d);
const sgCross = sch.budgetSuggestion({ ledger_id: ledgerId, scope: 'category', category_id: crossCat, trigger_type: 'expense' }, new Date('2026-03-10T00:00:00'));
check('窗口跨年正确（参照 2026-03 → 2025-09~2026-02，命中 3 个月，avg6=5 元）',
  sgCross.enough === true && sgCross.months_covered === 3 && sgCross.avg6_cents === 500
  && sgCross.suggest_low_cents === 500 && sgCross.suggest_high_cents === 600, JSON.stringify(sgCross));

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
  console.log('\n=== B. 预算表单与接口（HTTP 端到端 8099）===\n');
  let up = true;
  try { await fetch(BASE + '/login'); } catch { up = false; }
  if (!up) {
    console.log('  SKIP  8099 未启动，跳过 HTTP 段。请先：PORT=8099 HOST=127.0.0.1 DATA_DIR=<repo>/data-verify node server.js');
    console.log(`\n结果：${pass} 通过 / ${fail} 失败（未含 HTTP 段）\n`);
    process.exit(fail ? 1 : 0);
  }

  let r = await req('GET', '/login');
  const login = await req('POST', '/login', { form: { _csrf: csrfOf(r.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', login.status === 302, `HTTP ${login.status}`);

  r = await req('GET', '/budgets');
  check('预算页渲染成功', r.status === 200, `HTTP ${r.status}`);
  check('新建表单含支出/收入两套分类下拉', r.text.includes('id="b-cat-exp"') && r.text.includes('id="b-cat-inc"'), '');

  const optExp = r.text.match(/<option value="(\d+)"[^>]*>([^<]*?)（整个大分类）/);
  check('支出分类下拉可选大分类', !!optExp, optExp ? optExp[2].trim() : '未找到大分类选项');

  const incPart = r.text.slice(r.text.indexOf('id="b-cat-inc"'));
  const optInc = incPart.match(/<option value="(\d+)"[^>]*>([^<]*?)（整个大分类）/);
  check('收入分类下拉可选大分类', !!optInc, optInc ? optInc[2].trim() : '未找到大分类选项');

  const csrf = csrfOf(r.text);
  let created = await req('POST', '/budgets', {
    form: { _csrf: csrf, name: '大分类E2E', amount: '500', scope: 'category', category_id: optExp[1], period: 'monthly', alert_pct: '80', trigger_type: 'expense' },
  });
  check('创建大分类预算返回跳转', created.status === 302, `HTTP ${created.status}`);

  r = await req('GET', '/budgets');
  check('列表标注（整个大分类）', /分类 · [^<]*（整个大分类）/.test(r.text), (r.text.match(/分类 · [^<]{0,24}（整个大分类）/) || [''])[0]);
  const bid = (r.text.match(/\/budgets\/(\d+)"/) || [])[1];
  check('可解析到预算 id', !!bid, `id=${bid}`);

  /* 非法分类 id 被置空 */
  created = await req('POST', '/budgets', {
    form: { _csrf: csrf, name: '非法id', amount: '100', scope: 'category', category_id: '999999999', period: 'monthly', alert_pct: '80', trigger_type: 'expense' },
  });
  r = await req('GET', '/budgets');
  check('非法分类 id 不落库（显示未指定）', r.text.includes('分类 · 未指定'), '');

  /* 收入预算端到端 + 编辑保留统计对象 */
  created = await req('POST', '/budgets', {
    form: { _csrf: csrf, name: '收入E2E', amount: '8000', scope: 'category', category_id: optInc[1], period: 'monthly', alert_pct: '80', trigger_type: 'income' },
  });
  r = await req('GET', '/budgets');
  check('收入预算列表标注统计收入', r.text.includes('统计收入'), '');

  const incBid = (r.text.match(/\/budgets\/(\d+)"/g) || []).map((s) => s.match(/(\d+)/)[1]).pop();
  const edited = await req('POST', `/budgets/${incBid}`, {
    form: { _csrf: csrf, name: '收入E2E改', amount: '9000', scope: 'category', category_id: optInc[1], period: 'monthly', alert_pct: '90', trigger_type: 'income', is_active: '1' },
  });
  r = await req('GET', '/budgets');
  check('编辑后保留收入统计口径', r.text.includes('收入E2E改') && r.text.includes('统计收入'), '');

  /* --- 预算智能建议（P6）：页面挂载 + 接口出数 --- */
  check('表单挂载建议容器与拉取逻辑', r.text.includes('id="b-suggest"') && r.text.includes('/api/budgets/suggest'), '');
  r = await req('GET', '/api/budgets/suggest?scope=overall&trigger_type=expense');
  check('空历史不给建议（covered=0）', r.status === 200 && r.json.ok === true && r.json.suggestion.enough === false && r.json.suggestion.months_covered === 0, r.text.slice(0, 120));
  // 造 3 个完整月的历史（本月不计），走记账接口保证口径一致
  const nf = await req('GET', '/transactions/new');
  const accId = (nf.text.match(/name="account_id"[\s\S]*?<option value="(\d+)"/) || [])[1];
  const backMonth = (n) => {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
  for (let back = 1; back <= 3; back++) {
    await req('POST', '/transactions', {
      form: { _csrf: csrf, type: 'expense', amount: '50.00', account_id: accId, category_id: optExp[1], txn_date: `${backMonth(back)}-15`, note: '预算建议造数' },
    });
  }
  r = await req('GET', `/api/budgets/suggest?scope=category&category_id=${optExp[1]}&trigger_type=expense`);
  const sg = r.json && r.json.suggestion;
  check('接口建议：3 个月各 50 元 → avg6=25、区间 26~28 元',
    sg && sg.enough === true && sg.months_covered === 3 && sg.avg6_cents === 2500 && sg.avg3_cents === 5000
    && sg.suggest_low_cents === 2600 && sg.suggest_high_cents === 2800, r.text.slice(0, 160));
  r = await req('GET', '/api/budgets/suggest?scope=category&category_id=999999999&trigger_type=expense');
  check('非法分类 id 返回 400（不冒充总口径）', r.status === 400 && r.json && r.json.ok === false, `HTTP ${r.status}`);
  r = await req('GET', '/api/budgets/suggest?scope=category&trigger_type=expense');
  check('分类口径未选 id 不给建议（enough=false 而非总口径数字）', r.status === 200 && r.json.suggestion.enough === false && r.json.suggestion.months_covered === 0, r.text.slice(0, 100));
  const noAuth = await fetch(BASE + '/api/budgets/suggest?scope=overall', { headers: { Accept: 'application/json' }, redirect: 'manual' });
  check('未登录拒绝', noAuth.status !== 200, `HTTP ${noAuth.status}`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
