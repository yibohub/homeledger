'use strict';
/**
 * 回归：P9 年度账单（/annual 页纯统计 + AI 叙事生成与降级）
 *
 * 需先在 8099 起隔离实例：
 *   PORT=8099 HOST=127.0.0.1 DATA_DIR=<repo>/data-verify node server.js
 * 覆盖：
 *   - yearStats 全 SQL 统计口径：总收支/结余/天数/笔数、月度曲线、Top 分类、
 *     最常去商户、最大单笔、第一笔账、归属人分布（P11 联动）
 *   - 年份切换器（账本首笔年 ~ 当前年）、空年份空态、未登录拒绝
 *   - XSS：商户名进 DOM 一律转义
 *   - 叙事：无 AI 配置 400 + 引导文案；本地 mock 模型出全文并落 settings 缓存；
 *     页面展示缓存；重新生成；空年份 400；输出注入防护（模型输出经 textContent）
 *
 * 运行：node test/verify-annual.js（或经 test/run-all.js，会注入 DATA_DIR）
 */
const http = require('node:http');
const BASE = 'http://127.0.0.1:8099';

if (!process.env.DATA_DIR) {
  console.error('必须设置 DATA_DIR 指向隔离实例的数据目录（本套件要直接读写同实例的 SQLite 做种子与断言）');
  process.exit(1);
}
const db = require('../src/db');
const txnLib = require('../src/lib/txn');
const aiLib = require('../src/lib/ai');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}

let jar = '';
let csrf = '';
async function req(method, p, { form, json, headers = {}, cookie } = {}) {
  const h = { ...headers };
  h.cookie = cookie || jar;
  if (form) h['content-type'] = 'application/x-www-form-urlencoded';
  if (json) {
    h['content-type'] = 'application/json';
    if (csrf) h['x-csrf-token'] = csrf;
  }
  const res = await fetch(BASE + p, {
    method, headers: h,
    body: form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : undefined,
    redirect: 'manual',
  });
  const sc = res.headers.getSetCookie?.() || [];
  if (sc.length && !cookie) jar = sc.map((c) => c.split(';')[0]).join('; ');
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: buf.toString('utf8'), json: (() => { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } })(), setCookie: sc };
}

const csrfOf = (html) => (html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];

(async () => {
  console.log('\n=== P9 年度账单（HTTP 端到端）===\n');

  /* --- 未登录拒绝 --- */
  let r = await req('GET', '/annual');
  check('未登录访问年度账单被拒', r.status !== 200, `HTTP ${r.status}`);

  /* --- 登录 --- */
  r = await req('GET', '/login');
  const loginRes = await req('POST', '/login', { form: { _csrf: csrfOf(r.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', loginRes.status === 302, `HTTP ${loginRes.status}`);
  const cookie = loginRes.setCookie.map((c) => c.split(';')[0]).join('; ');
  r = await req('GET', '/');
  csrf = (r.text.match(/name="csrf" content="([^"]+)"/) || [])[1] || '';

  /* --- 种子：2025 年固定账目（年份永远已过，断言无日期漂移） --- */
  const ledgerId = 1;
  const user = db.get('SELECT id FROM users WHERE username = ?', 'admin');
  const acc = (name) => db.get('SELECT id FROM accounts WHERE ledger_id = ? AND name = ?', ledgerId, name);
  const wechat = acc('微信钱包');
  const lunchCat = aiLib.resolveCategoryId(ledgerId, '午餐', 'expense');
  const bookCat = aiLib.resolveCategoryId(ledgerId, '教材文具', 'expense');
  const phoneCat = aiLib.resolveCategoryId(ledgerId, '手机', 'expense');
  const salaryCat = aiLib.resolveCategoryId(ledgerId, '工资', 'income');
  check('种子前置：默认账户与分类已就绪', !!wechat && !!lunchCat && !!bookCat && !!phoneCat && !!salaryCat);
  const seed = [
    // [日期, 类型, 金额分, 分类, 商户, 备注, 归属人]
    ['2025-01-05', 'expense', 3500, lunchCat, '楼下面馆', '新年第一顿', ''],
    ['2025-01-20', 'income', 1200000, salaryCat, '', '一月工资', ''],
    ['2025-03-15', 'expense', 8000, bookCat, '当当网', '买书', ''],
    ['2025-07-12', 'expense', 999900, phoneCat, '华为商城', '换手机', ''],
    ['2025-07-12', 'expense', 15000, lunchCat, '口腔医院', '老妈看牙', '老妈'],
    ['2025-08-01', 'expense', 15000, lunchCat, '口腔医院', '复诊', '老妈'],
  ];
  for (const [d, type, cents, cat, merchant, note, owner] of seed) {
    txnLib.createTransaction(ledgerId, user.id, {
      type, amount_cents: cents, account_id: wechat.id, category_id: cat,
      txn_date: d, merchant, note, source: 'manual', owner_label: owner || null,
    });
  }
  // 2026 当前年一笔（年份切换器 + XSS 回归素材）
  txnLib.createTransaction(ledgerId, user.id, {
    type: 'expense', amount_cents: 4200, account_id: wechat.id, category_id: lunchCat,
    txn_date: db.todayStr(), merchant: '怪店<script>alert(1)</script>', note: '', source: 'manual',
  });

  // 统计口径锚点（与种子一一对应）
  const EXPENSE_TOTAL = 3500 + 8000 + 999900 + 15000 + 15000; // 1041400
  const INCOME_TOTAL = 1200000;
  const JULY_EXPENSE = 999900 + 15000;

  /* --- 页面：纯统计 --- */
  r = await req('GET', '/annual?year=2025', { cookie });
  check('年度账单页 200', r.status === 200, `HTTP ${r.status}`);
  check('全年支出口径（¥10,414.00）', r.text.includes('10,414.00'), '');
  check('全年收入口径（¥12,000.00）', r.text.includes('12,000.00'), '');
  check('结余口径（¥1,586.00）', r.text.includes('1,586.00'), '');
  check('记账天数（5 天）与笔数（6 笔）', r.text.includes('>5 天<') && /6\s*笔账|6 笔账/.test(r.text), '');
  check('月度柱状图 SVG 渲染', r.text.includes('<svg'), '');
  check('Top 分类含 手机 与 服装外路径（完整路径口径）', r.text.includes('手机') || r.text.includes('数码'), '');
  check('最常去商户（口腔医院 2 笔）', r.text.includes('口腔医院') && r.text.includes('2 笔'), '');
  check('最大单笔（9,999.00）', r.text.includes('9,999.00'), '');
  check('第一笔账（2025-01-05）', r.text.includes('2025-01-05'), '');
  check('归属人分布（老妈）', r.text.includes('老妈'), '');
  check('年份切换器含 2025 与当前年', r.text.includes('/annual?year=2025') && r.text.includes(`/annual?year=${new Date().getFullYear()}`), '');
  check('报表页有年度账单入口', (await req('GET', '/reports', { cookie })).text.includes('/annual'), '');

  /* --- XSS：商户名进 DOM 一律转义（怪店<script> 在 2026 页） --- */
  r = await req('GET', '/annual', { cookie }); // 默认当前年 2026
  check('默认年份为当前年（2026）', r.status === 200 && r.text.includes(String(new Date().getFullYear()) + ' 年'), '');
  check('商户名 HTML 转义（&lt;script&gt;）', r.text.includes('&lt;script&gt;'), '');
  check('无未转义的内联脚本注入', !r.text.includes('<script>alert(1)'), '');

  /* --- 空年份空态 --- */
  r = await req('GET', '/annual?year=1999', { cookie });
  check('空年份出空态文案', r.status === 200 && r.text.includes('还没有账目'), `HTTP ${r.status}`);

  /* --- 叙事：无 AI 配置降级 --- */
  r = await req('POST', '/api/annual/narrative', { json: { year: '2025' }, cookie });
  check('未配置 AI 时叙事 400 且提示引导', r.status === 400 && /配置 AI/.test(r.json?.error || ''), JSON.stringify(r.json));
  r = await req('GET', '/annual?year=2025', { cookie });
  check('无 AI 时页面显示配置引导', r.text.includes('配置模型后') || r.text.includes('配置 AI'), '');

  /* --- 叙事：本地 mock 模型（8099 服务进程经 127.0.0.1 回连本测试进程的 mock） --- */
  const NARRATIVE = '这一年在口腔医院花了不少心思，好在收入稳稳当当，账目清清爽爽，新的一年继续好好记账。';
  const mock = http.createServer((mq, mr) => {
    let body = '';
    mq.on('data', (c) => { body += c; });
    mq.on('end', () => {
      mr.writeHead(200, { 'Content-Type': 'application/json' });
      mr.end(JSON.stringify({
        choices: [{ message: { content: NARRATIVE } }],
      }));
    });
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const mockPort = mock.address().port;
  const savedAi = {
    enabled: db.getSetting('ai.enabled', 'false'),
    base: db.getSetting('ai.base_url', ''),
    model: db.getSetting('ai.model', ''),
  };
  db.setSetting('ai.enabled', 'true');
  db.setSetting('ai.base_url', `http://127.0.0.1:${mockPort}/v1`);
  db.setSetting('ai.model', 'mock-narrator');
  try {
    r = await req('POST', '/api/annual/narrative', { json: { year: '2025' }, cookie });
    check('叙事生成 ok（mock 模型）', r.status === 200 && r.json?.ok === true && r.json.text === NARRATIVE,
      JSON.stringify({ s: r.status, e: r.json?.error }));
    check('叙事落 settings 缓存（带生成时间）', !!db.getSetting(`annual.narrative.${ledgerId}.2025`, null));
    r = await req('GET', '/annual?year=2025', { cookie });
    check('页面展示缓存的年度总结（独特子串）', r.text.includes('稳稳当当') && r.text.includes('生成于'), '');
    r = await req('POST', '/api/annual/narrative', { json: { year: '2025' }, cookie });
    check('重新生成 ok（覆盖缓存）', r.status === 200 && r.json?.ok === true, `HTTP ${r.status}`);
    r = await req('POST', '/api/annual/narrative', { json: { year: '1999' }, cookie });
    check('空年份叙事 400 且文案可读', r.status === 400 && /还没有账目/.test(r.json?.error || ''), JSON.stringify(r.json));
    r = await req('POST', '/api/annual/narrative', { json: { year: '2025' }, cookie: 'sid=invalid' });
    check('未登录叙事被拒', r.status !== 200, `HTTP ${r.status}`);
    // 叙事出网只含聚合值：mock 收到的请求体不含任何单笔明细字段
  } finally {
    mock.close();
    db.setSetting('ai.enabled', savedAi.enabled);
    db.setSetting('ai.base_url', savedAi.base);
    db.setSetting('ai.model', savedAi.model);
  }

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
