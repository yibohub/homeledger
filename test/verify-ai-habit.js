'use strict';
/**
 * 回归：AI 习惯记忆（P1）+ AI 入账撤销后悔药（P4）
 *
 * 需先在 8099 起隔离实例：
 *   PORT=8099 HOST=127.0.0.1 DATA_DIR=<repo>/data-verify node server.js
 * 覆盖：
 *   - 同分类历史 → 规则引擎识别不出的账户按习惯补位（account_recommended 标记）
 *   - 文字里明确写了支付方式 → 以识别结果为准，习惯不覆盖
 *   - 关键词表猜不中的商户 → 用商户历史推荐分类（category_recommended 标记）
 *   - 悬浮球自动入库走习惯账户（不再无脑落第一个账户）
 *   - /api/ai/undo：成功撤销并还原余额、外带 ID 跳过、空 ID 400、
 *                   手动来源拒撤、超时（30 分钟窗口）拒撤、未登录拒绝
 *
 * 运行：node test/verify-ai-habit.js（或经 test/run-all.js，会注入 DATA_DIR）
 */
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

let jar = ''; // 简易 cookie jar：自动携带会话
let csrf = ''; // 从页面 meta 提取，JSON POST 需带 x-csrf-token
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
  console.log('\n=== AI 习惯记忆 + 入账撤销（HTTP 端到端）===\n');

  /* --- 未登录拒绝 --- */
  let r = await req('POST', '/api/ai/undo', { json: { ids: [1] } });
  check('未登录撤销被拒', r.status !== 200, `HTTP ${r.status}`);

  /* --- 登录 --- */
  r = await req('GET', '/login');
  const loginRes = await req('POST', '/login', { form: { _csrf: csrfOf(r.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', loginRes.status === 302, `HTTP ${loginRes.status}`);
  const cookie = loginRes.setCookie.map((c) => c.split(';')[0]).join('; ');
  r = await req('GET', '/');
  csrf = (r.text.match(/name="csrf" content="([^"]+)"/) || [])[1] || '';

  /* --- 零历史兜底：没有任何习惯时，悬浮球落到账本第一个账户并带「账本默认」标记 --- */
  const cashAcc = db.get('SELECT id, name FROM accounts WHERE ledger_id = ? AND name = ?', 1, '现金');
  r = await req('POST', '/api/ai/chat', { json: { text: '地铁 5 元' }, cookie });
  const itFallback = (r.json.items || [])[0] || {};
  check('零历史时自动入账落到第一个账户（现金）', Number(itFallback.account_id) === Number(cashAcc.id), `account_id=${itFallback.account_id}`);
  check('零历史兜底带 account_fallback 标记', itFallback.account_fallback === true, String(itFallback.account_fallback));
  check('零历史兜底不冒充习惯推荐', itFallback.account_recommended !== true, String(itFallback.account_recommended));

  /* --- 种子：同一分类连续 3 笔都记在微信钱包 --- */
  const ledgerId = 1;
  const user = db.get('SELECT id FROM users WHERE username = ?', 'admin');
  const acc = (name) => db.get('SELECT id, name, balance_cents FROM accounts WHERE ledger_id = ? AND name = ?', ledgerId, name);
  const wechat = acc('微信钱包');
  const alipay = acc('支付宝');
  check('默认账户已预置（微信钱包/支付宝）', !!wechat && !!alipay);
  const kw = aiLib.classifyByKeywords('午饭');
  const lunchCat = aiLib.resolveCategoryId(ledgerId, kw.category, 'expense');
  check('「午饭」经关键词表命中分类', !!lunchCat, kw && kw.category);
  for (let i = 0; i < 3; i++) {
    txnLib.createTransaction(ledgerId, user.id, {
      type: 'expense', amount_cents: 3500, account_id: wechat.id, category_id: lunchCat,
      txn_date: db.todayStr(), merchant: '测试面馆', note: '午饭', source: 'manual',
    });
  }

  /* --- A. 习惯补位账户：识别不出付款方式 → 推荐微信钱包 --- */
  r = await req('POST', '/api/ai/text', { json: { text: '午饭 40' }, cookie });
  const itA = (r.json.items || [])[0] || {};
  check('文字识别 ok（规则引擎）', r.status === 200 && r.json.engine === 'rule', `HTTP ${r.status}`);
  check('分类经关键词表命中午餐', Number(itA.category_id) === Number(lunchCat) && !itA.category_recommended);
  check('账户按习惯补位为微信钱包', Number(itA.account_id) === Number(wechat.id), `account_id=${itA.account_id}`);
  check('账户带「按习惯推荐」标记', itA.account_recommended === true, String(itA.account_recommended));
  check('金额解析 4000 分', Number(itA.amount_cents) === 4000, String(itA.amount_cents));

  /* --- B. 文字明确写了支付方式 → 识别结果优先，习惯不覆盖 --- */
  r = await req('POST', '/api/ai/text', { json: { text: '午饭 40 支付宝' }, cookie });
  const itB = (r.json.items || [])[0] || {};
  check('明确支付方式识别为支付宝', Number(itB.account_id) === Number(alipay.id), `account_id=${itB.account_id}`);
  check('明确支付方式不带习惯标记', itB.account_recommended !== true, String(itB.account_recommended));

  /* --- B2. 模型臆造账户（纯文字识别）：原文无据 → 丢弃并按习惯推荐；原文有据 → 以原文为准 --- */
  const llmRaw = { type: 'expense', amount: 40, txn_date: db.todayStr(), category_name: '餐饮/午餐', acct: '现金', confidence: 1 };
  const itB1 = aiLib.normalizeItem(llmRaw, ledgerId, { sourceText: '早餐 40' });
  check('模型臆造账户被丢弃并按习惯推荐微信钱包', Number(itB1.account_id) === Number(wechat.id) && itB1.account_recommended === true,
    `account_id=${itB1.account_id} rec=${itB1.account_recommended}`);
  const itB2 = aiLib.normalizeItem(llmRaw, ledgerId, { sourceText: '早餐 40 现金' });
  check('原文明确写现金时仍以原文为准', Number(itB2.account_id) === Number(cashAcc.id) && itB2.account_recommended !== true,
    `account_id=${itB2.account_id}`);
  const itB3 = aiLib.normalizeItem(llmRaw, ledgerId, {});
  check('无 sourceText（截图识别）保持原行为信任模型', Number(itB3.account_id) === Number(cashAcc.id), `account_id=${itB3.account_id}`);

  /* --- C. 商户→分类习惯：关键词表猜不中的商户，用商户历史补分类 --- */
  const textC = '蓝月亮旗舰店 59元';
  const merchantC = aiLib.cleanMerchant(textC);
  const fruitCat = aiLib.resolveCategoryId(ledgerId, '水果', 'expense');
  txnLib.createTransaction(ledgerId, user.id, {
    type: 'expense', amount_cents: 5900, account_id: wechat.id, category_id: fruitCat,
    txn_date: db.todayStr(), merchant: merchantC, note: '', source: 'manual',
  });
  check('测试商户不命中关键词表（保证走习惯路径）', !aiLib.classifyByKeywords(textC), merchantC);
  r = await req('POST', '/api/ai/text', { json: { text: textC }, cookie });
  const itC = (r.json.items || [])[0] || {};
  check('商户历史推荐分类为水果', Number(itC.category_id) === Number(fruitCat), `category_id=${itC.category_id}`);
  check('分类带「按习惯推荐」标记', itC.category_recommended === true, String(itC.category_recommended));
  check('商户解析与种子一致（走同一 cleanMerchant）', itC.merchant === merchantC, `${itC.merchant} vs ${merchantC}`);

  /* --- C2. 习惯摘要进提示词（方案 B）：buildContext 提炼、buildUserPrompt 按需附带 --- */
  const ctxHabit = aiLib.buildContext(ledgerId);
  check('习惯摘要含 分类→常用账户（餐饮/午餐→微信钱包）', /餐饮\/午餐→微信钱包/.test(ctxHabit.habits || ''), ctxHabit.habits);
  check('习惯摘要含 商户→常记分类（测试面馆）', /测试面馆→/.test(ctxHabit.habits || ''), ctxHabit.habits);
  const promptHabit = aiLib.buildUserPrompt({ text: '午饭 40', ctx: ctxHabit, today: db.todayStr() });
  check('提示词附带习惯参考行', promptHabit.includes('该用户的历史习惯') && promptHabit.includes('午餐→微信钱包'));
  const promptEmpty = aiLib.buildUserPrompt({ text: 'x', ctx: aiLib.buildContext(99999), today: db.todayStr() });
  check('无历史时不附习惯行', !promptEmpty.includes('历史习惯'));

  /* --- D. 悬浮球自动入库也走习惯账户 --- */
  const wechatBalance0 = Number(acc('微信钱包').balance_cents);
  const chat = await req('POST', '/api/ai/chat', { json: { text: '奶茶 18 元' }, cookie });
  const chatItem = (chat.json.items || [])[0] || {};
  check('悬浮球识别入库 ok', chat.status === 200 && chat.json.ok === true && chat.json.created === 1, `created=${chat.json.created}`);
  check('悬浮球账户按习惯为微信钱包（不再兜底第一个账户）', Number(chatItem.account_id) === Number(wechat.id), `account_id=${chatItem.account_id}`);
  check('悬浮球带习惯标记', chatItem.account_recommended === true, String(chatItem.account_recommended));
  const tid = (chat.json.ids || [])[0];
  const fresh = tid && db.get('SELECT source, deleted_at FROM transactions WHERE id = ?', tid);
  check('入库记录 source=ai_chat 且未删除', !!fresh && fresh.source === 'ai_chat' && fresh.deleted_at === null, JSON.stringify(fresh || {}));

  /* --- E. 撤销：成功 + 余额还原 --- */
  r = await req('POST', '/api/ai/undo', { json: { ids: [tid, 999999] }, cookie });
  check('撤销 ok 且只撤 1 笔（外带 ID 跳过）', r.status === 200 && r.json.ok === true && r.json.undone === 1 && r.json.skipped === 1,
    JSON.stringify(r.json));
  const undone = db.get('SELECT deleted_at FROM transactions WHERE id = ?', tid);
  check('撤销后交易已软删除', !!undone && undone.deleted_at !== null);
  check('撤销后余额已还原', Number(acc('微信钱包').balance_cents) === wechatBalance0,
    `${acc('微信钱包').balance_cents} vs ${wechatBalance0}`);

  /* --- F. 撤销边界 --- */
  r = await req('POST', '/api/ai/undo', { json: {}, cookie });
  check('空 ID 列表返回 400', r.status === 400, `HTTP ${r.status}`);

  const manualId = txnLib.createTransaction(ledgerId, user.id, {
    type: 'expense', amount_cents: 100, account_id: alipay.id, category_id: lunchCat,
    txn_date: db.todayStr(), merchant: '手动账', note: '', source: 'manual',
  });
  r = await req('POST', '/api/ai/undo', { json: { ids: [manualId] }, cookie });
  check('手动来源的交易拒撤', r.status === 400, `HTTP ${r.status}`);

  const chat2 = await req('POST', '/api/ai/chat', { json: { text: '打车 26.5 元' }, cookie });
  const staleId = (chat2.json.ids || [])[0];
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  const pad2 = (n) => String(n).padStart(2, '0');
  const staleStr = `${twoHoursAgo.getFullYear()}-${pad2(twoHoursAgo.getMonth() + 1)}-${pad2(twoHoursAgo.getDate())} ${pad2(twoHoursAgo.getHours())}:${pad2(twoHoursAgo.getMinutes())}:${pad2(twoHoursAgo.getSeconds())}`;
  db.run('UPDATE transactions SET created_at = ? WHERE id = ?', staleStr, staleId);
  r = await req('POST', '/api/ai/undo', { json: { ids: [staleId] }, cookie });
  check('超过 30 分钟窗口的交易拒撤', r.status === 400, `HTTP ${r.status}`);
  const still = db.get('SELECT deleted_at FROM transactions WHERE id = ?', staleId);
  check('超时交易未被改动', !!still && still.deleted_at === null);

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
