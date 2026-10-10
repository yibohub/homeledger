'use strict';
/**
 * 回归：账单导入 / 导出
 *
 * 分两段：
 *   A. 进程内逻辑（独立库 data-verify-import）：
 *      A0 编码与 CSV 基础（UTF-8/GBK/BOM、引号转义、日期归一、公式注入防护）
 *      A1 微信 CSV 归类（收/支/不计收支/“/”列，v1.3.0 修复区）
 *      A2 支付宝 CSV 归类（不计收支 + 状态跳过）
 *      A3 导出 → 回导循环保真（14 种类型经 type_key 机读列 1:1 还原、转账双边账户、
 *         负数余额调整、去重；v1.4.1 修复区——此前 type_key 列在导入侧未接线，
 *         12/14 类型回导时坍缩成支出/收入）
 *   B. HTTP 端到端（需先在 8099 起隔离实例）：
 *        PORT=8099 HOST=127.0.0.1 DATA_DIR=<repo>/data-verify node server.js
 *      覆盖 /export/csv 导出、建账本切换后 preview + commit 全链路回导、
 *      重复导入去重、微信账单中性记录（includeNeutral）与坏请求分支
 *      注意：手工重跑前先删 DATA_DIR（与 verify-transactions 共用 data-verify 目录名，
 *      残留种子会让导出行数翻倍而报红——响亮失败，不是假绿）
 *
 * 运行：node test/verify-importers.js
 */
const fs = require('node:fs');
const path = require('node:path');

const IMP_DATA_DIR = path.join(__dirname, '..', 'data-verify-import');
// 8099 实例的数据目录：run-all 会把服务端 DATA_DIR 传进环境，必须在下面覆盖前捕获
// （HTTP 段要直连服务端的库核对回导结果；手工跑时默认 data-verify）
const SERVER_DATA_DIR = process.env.DATA_DIR && process.env.DATA_DIR !== IMP_DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data-verify');
process.env.DATA_DIR = IMP_DATA_DIR;
fs.rmSync(IMP_DATA_DIR, { recursive: true, force: true });

const db = require('../src/db');
const importer = require('../src/lib/importers');
const auth = require('../src/lib/auth');
const txn = require('../src/lib/txn');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}

/* ============================ A0. 编码与 CSV 基础 ============================ */

console.log('\n=== A0. 编码与 CSV 基础（进程内）===\n');

db.init();

check('UTF-8 账单直接识别为 utf-8', importer.decodeBuffer(Buffer.from('交易时间,金额(元)\n2026-09-01,1.00', 'utf8')).encoding === 'utf-8');
check('UTF-8 BOM 被剥掉', !importer.decodeBuffer(Buffer.from('\uFEFF交易时间,金额', 'utf8')).text.startsWith('\uFEFF'));
// GBK 字节由 PowerShell Encoding(936) 预生成（Node 无 GBK 编码器）：
// 「支付宝交易记录明细,交易时间,交易分类,收/支,金额(元),支出,收入,不计收支」
const GBK_SAMPLE = Buffer.from(
  'd6a7b8b6b1a6bdbbd2d7bcc7c2bcc3f7cfb82cbdbbd2d7cab1bce42cbdbbd2d7b7d6c0e02ccad52fd6a72cbdf0b6ee28d4aa292cd6a7b3f62ccad5c8eb2cb2bbbcc6cad5d6a7',
  'hex'
);
const gbkDecoded = importer.decodeBuffer(GBK_SAMPLE);
check('GBK 账单（支付宝默认编码）不乱码且识别为 gbk', gbkDecoded.encoding === 'gbk' && gbkDecoded.text.includes('支付宝'),
  gbkDecoded.encoding + ' / ' + gbkDecoded.text.slice(0, 12));

const line = importer.parseCsvLine('a,"b,c","d""e",f');
check('CSV 引号包裹与转义解析', line.length === 4 && line[1] === 'b,c' && line[2] === 'd"e', JSON.stringify(line));
check('日期归一：斜杠/中文/日月年', importer.normalizeDate('2026/9/5') === '2026-09-05'
  && importer.normalizeDate('2026年9月5日 12:00:00') === '2026-09-05'
  && importer.normalizeDate('9/5/2026') === '2026-09-05');
check('公式注入防护：= 开头单元格加前缀', importer.csvEscape('=SUM(A1)').startsWith("'"));
check('含逗号/引号的值整体加引号', importer.csvEscape('a,"b"') === '"a,""b"""');

/* ==================== A1. 微信 CSV 归类（v1.3.0 修复区） ==================== */

console.log('\n=== A1. 微信 CSV 归类（进程内）===\n');

// 仿微信导出：前导说明行（单列，不满足表头判定）+ 表头 + 数据行。
// 「收/支」列的 "/" 是零钱充值/提现/亲属卡等资金搬移行，不属于收支（v1.3.0 修复点）
const WECHAT_CSV = [
  '微信支付账单明细[20260901~20260930]',
  '导出类型[全部]',
  '共 8 笔记录',
  '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
  '2026-09-01 12:30:00,商户消费,肯德基,外卖订单,支出,¥45.00,零钱,支付成功,1000001,2000001,"/"',
  '2026-09-02 09:00:00,微信红包,张三,微信红包,收入,¥8.88,零钱,已存入零钱,1000002,2000002,"/"',
  '2026-09-03 10:00:00,零钱充值,/,零钱充值,/,¥200.00,招商银行卡(0000),已存入零钱,1000003,2000003,"/"',
  '2026-09-04 11:00:00,零钱提现,/,提现到银行卡,/,¥500.00,零钱,提现已到账,1000004,2000004,"/"',
  '2026-09-05 12:00:00,亲属卡,/,给儿子的亲属卡,/,¥300.00,零钱,对方已领取,1000005,2000005,"/"',
  '2026-09-06 13:00:00,商户消费,某商店,退货订单,支出,¥66.00,零钱,已全额退款,1000006,2000006,"/"',
  '2026-09-07 14:00:00,商户消费,某商城,已关闭订单,支出,¥77.00,零钱,已关闭,1000007,2000007,"/"',
  '2026-09-08 15:00:00,商户消费,某网店,待付款订单,支出,¥88.00,零钱,待付款,1000008,2000008,"/"',
].join('\n');

const w = importer.parseBill(Buffer.from(WECHAT_CSV, 'utf8'));
check('识别为微信账单', w.source === 'wechat', w.source);
check('收支记录 2 笔（支出+收入）', w.records.length === 2, String(w.records.length));
check('不计收支记录 3 笔（充值/提现/亲属卡）', w.neutralRecords.length === 3, String(w.neutralRecords.length));
check('关闭/退款/待付款状态行跳过 3 笔', w.skipped === 3, String(w.skipped));
const wExp = w.records.find((r) => r.merchant === '肯德基');
const wInc = w.records.find((r) => r.merchant === '张三');
check('「支出」归类为 expense 且金额剥 ¥ 入分', wExp && wExp.type === 'expense' && wExp.amount_cents === 4500,
  wExp && `${wExp.type}/${wExp.amount_cents}`);
check('「收入」归类为 income', wInc && wInc.type === 'income' && wInc.amount_cents === 888,
  wInc && `${wInc.type}/${wInc.amount_cents}`);
check('交易时间取日期部分、单号保留', wExp && wExp.txn_date === '2026-09-01' && wExp.order_no === '1000001',
  wExp && `${wExp.txn_date}/${wExp.order_no}`);
check('支付方式作为账户提示', wExp && wExp.account_hint === '零钱' && w.neutralRecords[0].account_hint === '招商银行卡(0000)',
  wExp && String(wExp.account_hint));
check('不计收支行统一归入 transfer 类型', w.neutralRecords.every((r) => r.type === 'transfer' && r.neutral === true));

/* ==================== A2. 支付宝 CSV 归类 ==================== */

console.log('\n=== A2. 支付宝 CSV 归类（进程内）===\n');

const ALIPAY_CSV = [
  // 前导行须保持单列（真实支付宝导出即如此）：若带逗号凑满 4 列且含「日期」，
  // 会被 isHeaderRow 误判为表头（健壮性缺口已登记 BOARD）
  '支付宝交易记录明细查询',
  '账号: example@sina.com',
  '起始日期:[2026-09-01]',
  '终止日期:[2026-09-30]',
  '---------------------------------[交易记录明细列表]---------------------------------',
  '交易号,商家订单号,交易创建时间,付款时间,最近修改时间,交易来源地,类型,交易对方,商品名称,金额（元）,收/支,交易状态',
  '20260901001,20260901001B,2026-09-01 12:00:00,2026-09-01 12:00:01,2026-09-01 12:00:01,上海市,消费,滴滴出行,快车订单,23.50,支出,交易成功',
  '20260902001,20260902001B,2026-09-02 09:00:00,2026-09-02 09:00:01,2026-09-02 09:00:01,上海市,转账,张三,AA聚餐,120.00,不计收支,交易成功',
  '20260903001,20260903001B,2026-09-03 10:00:00,2026-09-03 10:00:01,2026-09-03 10:00:01,上海市,退款,某网店,退货退款,45.00,收入,交易成功',
  '20260904001,20260904001B,2026-09-04 11:00:00,2026-09-04 11:00:01,2026-09-04 11:00:01,上海市,消费,某店,已退款订单,66.00,支出,退款成功',
].join('\n');

const a = importer.parseBill(Buffer.from(ALIPAY_CSV, 'utf8'));
check('识别为支付宝账单', a.source === 'alipay', a.source);
check('收支记录 2 笔', a.records.length === 2, String(a.records.length));
check('「不计收支」（AA 转账）进中性区不直接入库', a.neutralRecords.length === 1 && a.neutralRecords[0].type === 'transfer');
check('退款成功状态行跳过', a.skipped === 1, String(a.skipped));
const aExp = a.records.find((r) => r.merchant === '滴滴出行');
check('全角括号「金额（元）」列能取到金额', aExp && aExp.amount_cents === 2350, aExp && String(aExp.amount_cents));
check('「收入」行归类为 income', a.records.some((r) => r.merchant === '某网店' && r.type === 'income' && r.amount_cents === 4500));

/* ================= A3. 导出 → 回导循环保真（v1.4.1 修复区） ================= */

console.log('\n=== A3. 导出 → 回导循环保真（进程内）===\n');

// 源账本：14 种类型各一笔（循环回导后逐笔核对），双边类型带转入账户，调整含负数
const uid = Number(db.run(
  'INSERT INTO users (username, password_hash, display_name, avatar_color, is_admin, created_at) VALUES (?,?,?,?,1,?)',
  'impadmin', auth.hashPassword('imp-pass-123'), '导入测试', '#4f7cff', db.nowStr()
).lastInsertRowid);
const srcLedger = Number(db.createDefaultLedger(uid, '导入测试'));
const mkAcc = (name, type) => Number(db.run(
  'INSERT INTO accounts (ledger_id, name, type, icon, currency, initial_cents, balance_cents, sort_order, note, created_at) VALUES (?,?,?,?,?,0,0,0,NULL,?)',
  srcLedger, name, type, '📦', 'CNY', db.nowStr()
).lastInsertRowid);
const ACC_DEFS = [
  ['wechat', '微信零钱', 'virtual'], ['bank', '招商银行卡', 'debit'], ['alipay', '支付宝', 'virtual'],
  ['invest', '证券账户', 'investment'], ['recv', '应收款-老王', 'receivable'], ['pay', '应付款-老李', 'payable'],
];
const acc = Object.fromEntries(ACC_DEFS.map(([k, name, type]) => [k, mkAcc(name, type)]));
const catFood = db.get("SELECT c.id FROM categories c JOIN categories p ON p.id = c.parent_id WHERE c.name = '外卖' AND p.name = '餐饮'");
const catGift = db.get("SELECT c.id FROM categories c JOIN categories p ON p.id = c.parent_id WHERE c.name = '红包' AND p.name = '其他收入'");

const CASES = [
  { m: '循源-支出', type: 'expense', cents: 4500, date: '2026-09-01', acc: acc.wechat, accName: '微信零钱', to: null, toName: null, cat: catFood?.id ?? null },
  { m: '循源-收入', type: 'income', cents: 8800, date: '2026-09-02', acc: acc.wechat, accName: '微信零钱', to: null, toName: null, cat: catGift?.id ?? null },
  { m: '循源-转账', type: 'transfer', cents: 10000, date: '2026-09-03', acc: acc.wechat, accName: '微信零钱', to: acc.bank, toName: '招商银行卡', cat: null },
  { m: '循源-借出', type: 'lend', cents: 20000, date: '2026-09-04', acc: acc.wechat, accName: '微信零钱', to: acc.recv, toName: '应收款-老王', cat: null },
  { m: '循源-借入', type: 'borrow', cents: 50000, date: '2026-09-05', acc: acc.bank, accName: '招商银行卡', to: acc.pay, toName: '应付款-老李', cat: null },
  { m: '循源-收回借款', type: 'repay_receive', cents: 20000, date: '2026-09-06', acc: acc.wechat, accName: '微信零钱', to: null, toName: null, cat: null },
  { m: '循源-偿还借款', type: 'repay_pay', cents: 30000, date: '2026-09-07', acc: acc.bank, accName: '招商银行卡', to: null, toName: null, cat: null },
  { m: '循源-报销', type: 'reimburse', cents: 9900, date: '2026-09-08', acc: acc.alipay, accName: '支付宝', to: null, toName: null, cat: null },
  { m: '循源-退款', type: 'refund', cents: 4500, date: '2026-09-09', acc: acc.wechat, accName: '微信零钱', to: null, toName: null, cat: null },
  { m: '循源-手续费', type: 'fee', cents: 200, date: '2026-09-10', acc: acc.bank, accName: '招商银行卡', to: null, toName: null, cat: null },
  { m: '循源-利息', type: 'interest', cents: 1234, date: '2026-09-11', acc: acc.bank, accName: '招商银行卡', to: null, toName: null, cat: null },
  { m: '循源-买入', type: 'invest_buy', cents: 60000, date: '2026-09-12', acc: acc.bank, accName: '招商银行卡', to: acc.invest, toName: '证券账户', cat: null },
  { m: '循源-卖出', type: 'invest_sell', cents: 70000, date: '2026-09-13', acc: acc.invest, accName: '证券账户', to: acc.bank, toName: '招商银行卡', cat: null },
  { m: '循源-调减', type: 'adjust', cents: -5000, date: '2026-09-14', acc: acc.wechat, accName: '微信零钱', to: null, toName: null, cat: null },
];
for (const c of CASES) {
  db.run(
    `INSERT INTO transactions (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, to_account_id,
      category_id, user_id, txn_date, note, merchant, status, source, created_at, updated_at)
     VALUES (?,?,?,'CNY',1,?,?,?,?,?,?,NULL,?,'cleared','manual',?,?)`,
    srcLedger, c.type, c.cents, c.cents, c.acc, c.to, c.cat, uid, c.date, c.m, db.nowStr(), db.nowStr()
  );
}

const listed = txn.listTransactions(srcLedger, { sort: 'date_asc', page: 1, pageSize: 200 });
const csv = importer.toCsv(importer.EXPORT_HEADER, importer.exportRows(srcLedger, listed.rows));
check('导出 14 行且表头含 type_key 机读列', listed.rows.length === 14 && csv.includes('type_key'), `${listed.rows.length} 行`);

const round = importer.parseBill(Buffer.from(csv, 'utf8'));
check('导出的 CSV 能被解析器识别（表头/全部行）', round.records.length === 14 && round.neutralRecords.length === 0,
  `records=${round.records.length} neutral=${round.neutralRecords.length}`);
const byMerchant = (m) => round.records.find((r) => r.merchant === m);
check('type_key 机读列让 14 种类型回导全部 1:1 还原（不再是正则猜标签）',
  CASES.every((c) => byMerchant(c.m)?.type === c.type),
  CASES.filter((c) => byMerchant(c.m)?.type !== c.type).map((c) => `${c.m}→${byMerchant(c.m)?.type}`).join('，'));
check('双边类型的「转入账户」列回导为对方账户提示',
  ['循源-转账', '循源-借出', '循源-借入', '循源-买入', '循源-卖出'].every((m) => byMerchant(m)?.to_account_hint),
  byMerchant('循源-转账')?.to_account_hint);
check('余额调整的负数金额保留（方向不翻转）', byMerchant('循源-调减')?.amount_cents === -5000,
  String(byMerchant('循源-调减')?.amount_cents));

// 回导入一个全新账本，核对落库后的逐笔保真。
// 用裸账本（不带默认账户预设）：默认账户会经 resolveAccountId 宽松匹配复用
// （微信零钱→微信钱包、招商银行卡→银行卡），那是导入器的账户复用语义，不是回导缺陷
const dstLedger = Number(db.run(
  "INSERT INTO ledgers (name, kind, currency, icon, color, owner_id, note, created_at) VALUES ('回导目标','personal','CNY','📒','#4f7cff',?,NULL,?)",
  uid, db.nowStr()
).lastInsertRowid);
const first = importer.importRecords({
  ledgerId: dstLedger, userId: uid, records: round.records, neutralRecords: round.neutralRecords,
  source: round.source, fileName: 'roundtrip.csv',
});
check('首次回导 14 笔全部入库', first.imported === 14 && first.failed === 0,
  `imported=${first.imported} failed=${first.failed}`);
check('自动创建缺失账户', ['微信零钱', '招商银行卡', '支付宝', '证券账户', '应收款-老王', '应付款-老李'].every((n) => first.createdAccounts.includes(n)),
  first.createdAccounts.join('、'));

const dstOf = (m) => db.get('SELECT * FROM transactions WHERE ledger_id = ? AND merchant = ? AND deleted_at IS NULL', dstLedger, m);
const accNameOf = (id) => (id ? db.get('SELECT name FROM accounts WHERE id = ?', id)?.name : null);
check('落库后类型 1:1（14/14）', CASES.every((c) => dstOf(c.m)?.type === c.type),
  CASES.filter((c) => dstOf(c.m)?.type !== c.type).map((c) => c.m).join('，'));
check('落库后金额/日期 1:1（含负数调整）',
  CASES.every((c) => Number(dstOf(c.m)?.amount_cents) === c.cents && dstOf(c.m)?.txn_date === c.date));
check('落库后账户与对方账户 1:1',
  CASES.every((c) => accNameOf(dstOf(c.m)?.account_id) === c.accName && accNameOf(dstOf(c.m)?.to_account_id) === c.toName));
const dstRows = db.all(
  `SELECT t.type, c.name AS cat, p.name AS cat_parent FROM transactions t
   LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN categories p ON p.id = c.parent_id
   WHERE t.ledger_id = ? AND t.deleted_at IS NULL`, dstLedger
);
check('支出/收入分类按路径还原（餐饮/外卖、其他收入/红包）',
  dstRows.some((r) => r.cat === '外卖' && r.cat_parent === '餐饮') && dstRows.some((r) => r.cat === '红包' && r.cat_parent === '其他收入'));

const again = importer.importRecords({
  ledgerId: dstLedger, userId: uid, records: round.records, neutralRecords: round.neutralRecords,
  source: round.source, fileName: 'roundtrip-2.csv',
});
check('重复回导全部去重（不再重复入账）', again.imported === 0 && again.skipped === 14,
  `imported=${again.imported} skipped=${again.skipped}`);

check('无表头的文件给出可读错误', (() => { const p = importer.parseBill(Buffer.from('随便一行\n另一行', 'utf8')); return !!p.error; })());

/* ============================ B. HTTP 端到端 ============================ */

const BASE = 'http://127.0.0.1:8099';
let cookie = '';
let csrf = '';
async function req(method, p, { form, json, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (form) h['content-type'] = 'application/x-www-form-urlencoded';
  if (json) { h['content-type'] = 'application/json'; if (csrf) h['x-csrf-token'] = csrf; }
  const res = await fetch(BASE + p, {
    method, headers: h,
    body: form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : undefined,
    redirect: 'manual',
  });
  const sc = res.headers.getSetCookie?.() || [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  return { status: res.status, text, body };
}
const metaCsrf = (html) => (html.match(/<meta name="csrf" content="([^"]+)"/) || [])[1];
const formCsrf = (html) => (html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];

(async () => {
  console.log('\n=== B. 导入/导出（HTTP 端到端 8099）===\n');
  let up = true;
  try { await fetch(BASE + '/login'); } catch { up = false; }
  if (!up) {
    console.log('  SKIP  8099 未启动，跳过 HTTP 段。请先：PORT=8099 HOST=127.0.0.1 DATA_DIR=<repo>/data-verify node server.js');
    console.log(`\n结果：${pass} 通过 / ${fail} 失败（未含 HTTP 段）\n`);
    process.exit(fail ? 1 : 0);
  }

  let r = await req('GET', '/login');
  const login = await req('POST', '/login', { form: { _csrf: formCsrf(r.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', login.status === 302, `HTTP ${login.status}`);

  /* 未登录不可见 */
  const savedCookie = cookie; cookie = '';
  const anonPage = await req('GET', '/import');
  const anonPreview = await req('POST', '/api/import/preview', { json: { dataUrl: 'data:text/csv;base64,eCxl' } });
  check('未登录访问导入页被重定向', anonPage.status === 302, `HTTP ${anonPage.status}`);
  // CSRF 中间件挂在路由前：匿名 POST 先被 CSRF 拒（403），带会话时才轮到 requireLogin 重定向
  check('未登录调用预览接口被拒（CSRF 403 或重定向）', anonPreview.status === 403 || anonPreview.status === 302,
    `HTTP ${anonPreview.status}`);
  cookie = savedCookie;

  const dbFile = path.join(SERVER_DATA_DIR, 'homeledger.db');
  if (!(/^data-verify/.test(path.basename(SERVER_DATA_DIR)) && fs.existsSync(dbFile))) {
    // 目录守卫是防误写真实库的保护；但 8099 活着却被拦下说明是配置错误，不能当正常跳过放绿
    let alive = false;
    try { await fetch(BASE + '/healthz'); alive = true; } catch { /* 未起服务，正常跳过 */ }
    if (alive) {
      fail++;
      console.log(`  FAIL  8099 存活但 DATA_DIR 守卫拦下了 HTTP 段（${SERVER_DATA_DIR}）——请用 data-verify 前缀的隔离目录重跑`);
    } else {
      check('（跳过 HTTP 回导段：8099 未启动）', true);
    }
    console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
    process.exit(fail ? 1 : 0);
  }
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(dbFile);
  raw.exec('PRAGMA busy_timeout = 5000;');
  const homeId = Number(raw.prepare('SELECT MIN(id) AS id FROM ledgers').get().id);
  const adminId = Number(raw.prepare("SELECT id FROM users WHERE username = 'admin'").get().id);

  // 源账本（首页账本）种 14 类型流水，与 A3 同构，商户带「循源-」标记便于跨库核对
  const seedAccId = {};
  for (const [key, name, type] of ACC_DEFS) {
    const found = raw.prepare('SELECT id FROM accounts WHERE ledger_id = ? AND name = ?').get(homeId, name);
    seedAccId[key] = found?.id ?? Number(raw.prepare(
      "INSERT INTO accounts (ledger_id, name, type, icon, currency, initial_cents, balance_cents, sort_order, note, created_at) VALUES (?,?,?,'📦','CNY',0,0,0,NULL,datetime('now'))"
    ).run(homeId, name, type).lastInsertRowid);
  }
  const accIdByName = new Map(Object.entries(ACC_DEFS).map(([, [k, name]]) => [name, seedAccId[k]]));
  const seedStmt = raw.prepare(
    `INSERT INTO transactions (ledger_id, type, amount_cents, currency, rate, amount_base_cents, account_id, to_account_id,
      category_id, user_id, txn_date, note, merchant, status, source, created_at, updated_at)
     VALUES (?,?,?,'CNY',1,?,?,?,?,?,?,NULL,?,'cleared','manual',datetime('now'),datetime('now'))`
  );
  for (const c of CASES) {
    seedStmt.run(homeId, c.type, c.cents, c.cents, accIdByName.get(c.accName), c.toName ? accIdByName.get(c.toName) : null,
      null, adminId, c.date, c.m);
  }

  /* 导出：/export/csv 全量分页拼接 + BOM + 机读列 */
  r = await req('GET', '/export/csv');
  check('导出 CSV 200 且带 UTF-8 BOM', r.status === 200 && r.text.startsWith('\uFEFF'), `HTTP ${r.status}`);
  const exportCsv = r.text.replace(/^\uFEFF/, '');
  const csvLines = exportCsv.trim().split(/\r?\n/);
  check('导出表头 16 列且含 type_key', csvLines[0].split(',').length === 16 && csvLines[0].includes('type_key'), csvLines[0].slice(0, 60));
  check('导出行数与种子一致', csvLines.length - 1 === CASES.length, `${csvLines.length - 1} 行`);
  const exportB64 = Buffer.from(exportCsv, 'utf8').toString('base64');

  /* 建目标账本（POST /ledgers 自动切换会话）并整链路回导。
     with_default_accounts=0 得到裸账本：默认账户预设会经宽松匹配复用（微信零钱→微信钱包），
     与回导保真断言无关（账户复用语义），此处排除干扰 */
  r = await req('GET', '/ledgers');
  await req('POST', '/ledgers', { form: { _csrf: formCsrf(r.text), name: '回导E2E账本', kind: 'personal', with_default_accounts: '0' } });
  const targetId = Number(raw.prepare('SELECT MAX(id) AS id FROM ledgers').get().id);
  r = await req('GET', '/import');
  check('导入页 200（已切到新账本）', r.status === 200, `HTTP ${r.status}`);
  csrf = metaCsrf(r.text);

  r = await req('POST', '/api/import/preview', { json: { dataUrl: 'data:text/csv;base64,' + exportB64, fileName: 'export.csv' } });
  check('预览成功且行数正确（账单含「支付宝」账户名，来源标签允许任一引擎）',
    r.body?.ok === true && r.body.count === CASES.length, JSON.stringify({ source: r.body?.source, count: r.body?.count }));
  const transferSample = r.body?.sample?.find((s) => s.merchant === '循源-转账');
  check('预览样本按 type_key 标出「转账」而非误判支出', transferSample?.type === 'transfer' && transferSample?.type_label === '转账',
    JSON.stringify({ type: transferSample?.type, label: transferSample?.type_label }));

  r = await req('POST', '/api/import/commit', { json: { token: r.body?.token } });
  check('提交回导：14 笔入库 0 失败', r.body?.ok === true && r.body.imported === CASES.length && r.body.failed === 0,
    JSON.stringify({ imported: r.body?.imported, failed: r.body?.failed }));

  // 跨库逐笔核对：类型/金额/日期/账户/对方账户与源定义一致
  const cmpSql = `SELECT t.type, t.amount_cents, t.txn_date, a.name AS acc, ta.name AS to_acc
    FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN accounts ta ON ta.id = t.to_account_id
    WHERE t.ledger_id = ? AND t.merchant = ? AND t.deleted_at IS NULL`;
  const mismatch = [];
  for (const c of CASES) {
    const dst = raw.prepare(cmpSql).get(targetId, c.m);
    if (!dst || dst.type !== c.type || Number(dst.amount_cents) !== c.cents || dst.txn_date !== c.date
      || dst.acc !== c.accName || dst.to_acc !== c.toName) mismatch.push(c.m);
  }
  check('回导落库逐笔保真（类型/金额/日期/账户/对方账户）', mismatch.length === 0, mismatch.join('，') || '14/14 一致');

  /* 重复导入去重 */
  r = await req('POST', '/api/import/preview', { json: { dataUrl: 'data:text/csv;base64,' + exportB64, fileName: 'export-2.csv' } });
  r = await req('POST', '/api/import/commit', { json: { token: r.body?.token } });
  check('同一份 CSV 二次导入全部去重', r.body?.ok === true && r.body.imported === 0 && r.body.skipped === CASES.length,
    JSON.stringify({ imported: r.body?.imported, skipped: r.body?.skipped }));

  /* 坏请求分支 */
  r = await req('POST', '/api/import/commit', { json: { token: 'no-such-token' } });
  check('过期/伪造 token 提交被拒 400', r.status === 400, `HTTP ${r.status}`);
  r = await req('POST', '/api/import/preview', { json: { dataUrl: 'not-a-data-url' } });
  check('非 dataUrl 预览被拒 400', r.status === 400, `HTTP ${r.status}`);
  r = await req('POST', '/api/import/preview', { json: { dataUrl: 'data:text/csv;base64,' + Buffer.from('没有表头的文件', 'utf8').toString('base64') } });
  check('无表头文件预览 400 且报错可读', r.status === 400 && /表头/.test(r.body?.error || ''), r.body?.error);

  /* 微信账单 HTTP 导入：中性记录默认不导、includeNeutral 导为转账 */
  await req('POST', '/ledgers/switch', { form: { _csrf: csrf, ledger_id: String(homeId) } });
  r = await req('POST', '/api/import/preview', { json: { dataUrl: 'data:text/csv;base64,' + Buffer.from(WECHAT_CSV, 'utf8').toString('base64'), fileName: 'wechat.csv' } });
  check('预览识别微信账单与统计口径', r.body?.sourceLabel === '微信支付账单' && r.body.count === 2 && r.body.neutralCount === 3 && r.body.skipped === 3,
    JSON.stringify({ count: r.body?.count, neutral: r.body?.neutralCount, skipped: r.body?.skipped }));
  check('预览统计只算收支两笔', r.body?.stat?.expense === 4500 && r.body?.stat?.income === 888 && r.body?.stat?.transfer === 0,
    JSON.stringify(r.body?.stat));
  r = await req('POST', '/api/import/commit', { json: { token: r.body?.token, include_neutral: false } });
  check('默认不含中性记录：2 笔入库', r.body?.ok === true && r.body.imported === 2, JSON.stringify(r.body && { imported: r.body.imported }));

  r = await req('POST', '/api/import/preview', { json: { dataUrl: 'data:text/csv;base64,' + Buffer.from(WECHAT_CSV, 'utf8').toString('base64'), fileName: 'wechat-neutral.csv' } });
  r = await req('POST', '/api/import/commit', { json: { token: r.body?.token, include_neutral: true } });
  check('includeNeutral：已导入的 2 笔去重、3 笔中性入账', r.body?.ok === true && r.body.imported === 3 && r.body.skipped === 2,
    JSON.stringify({ imported: r.body?.imported, skipped: r.body?.skipped }));

  const neutralRows = raw.prepare(
    `SELECT t.amount_cents, a.name AS acc, ta.name AS to_acc FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN accounts ta ON ta.id = t.to_account_id
     WHERE t.ledger_id = ? AND t.source = 'import' AND t.type = 'transfer'
       AND (t.note LIKE '零钱充值%' OR t.note LIKE '提现到银行卡%' OR t.note LIKE '给儿子的亲属卡%')`
  ).all(homeId);
  check('中性记录落库为 transfer 且双边齐备（3 笔）', neutralRows.length === 3 && neutralRows.every((x) => x.acc && x.to_acc),
    neutralRows.map((x) => `${x.acc}→${x.to_acc}`).join('，'));
  const withdraw = neutralRows.find((x) => x.to_acc === '银行卡');
  check('提现行对方账户按「提现到银行卡」文字推断出银行卡', !!withdraw && Number(withdraw.amount_cents) === 50000,
    JSON.stringify(withdraw));

  raw.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('套件异常：', e); process.exit(1); });
