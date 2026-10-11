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
const dictLib = require('../src/lib/dict');

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

  /* --- G. 审查边界：自定义账户名核验 + 归档账户不参与推荐 --- */
  const customId = db.run(
    `INSERT INTO accounts (ledger_id, name, type, icon, currency, initial_cents, balance_cents, sort_order, created_at)
     VALUES (?,?,?,?,?,0,0,90,?)`,
    ledgerId, '浦发卡', 'debit', '🏦', 'CNY', db.nowStr()
  ).lastInsertRowid;
  const customRaw = { type: 'expense', amount: 40, txn_date: db.todayStr(), category_name: '餐饮/午餐', acct: '浦发卡', confidence: 1 };
  const itG1 = aiLib.normalizeItem(customRaw, ledgerId, { sourceText: '午饭 40 浦发卡' });
  check('自定义命名账户原文有据时不被丢弃', Number(itG1.account_id) === Number(customId) && itG1.account_recommended !== true,
    `account_id=${itG1.account_id}`);
  const itG2 = aiLib.normalizeItem(customRaw, ledgerId, { sourceText: '午饭 40' });
  check('自定义账户名原文无据时交给习惯（微信钱包）', Number(itG2.account_id) === Number(wechat.id) && itG2.account_recommended === true,
    `account_id=${itG2.account_id}`);
  check('臆造账户名同步丢弃（不给开放 API 后门）', itG2.account_name === null, String(itG2.account_name));

  db.run('UPDATE accounts SET is_archived = 1 WHERE id = ?', wechat.id);
  const itG3 = aiLib.normalizeItem({ type: 'expense', amount: 40, txn_date: db.todayStr(), category_name: '餐饮/午餐', confidence: 1 }, ledgerId, { sourceText: '午饭 40' });
  check('归档账户不参与习惯推荐', Number(itG3.account_id) !== Number(wechat.id) && Number(itG3.account_id) !== Number(customId),
    `account_id=${itG3.account_id}`);
  db.run('UPDATE accounts SET is_archived = 0 WHERE id = ?', wechat.id);


  /* --- P11 消费归属人：提取/臆造核验/习惯补位/名单/统计/落库 --- */
  const famSaved = db.getSetting(`family.members.${ledgerId}`, "[]");
  db.setSetting(`family.members.${ledgerId}`, JSON.stringify(['老妈', '老爸']));
  check('归属人名单：手动名单在前', aiLib.familyMembers(ledgerId).slice(0, 2).join(',') === '老妈,老爸', JSON.stringify(aiLib.familyMembers(ledgerId)));
  const o1 = aiLib.normalizeItem({ type: 'expense', amount: 50, txn_date: db.todayStr(), merchant: '口腔医院', for_member: '老妈' }, ledgerId, { sourceText: '给老妈买药 50 元 口腔医院' });
  check('归属人提取：for_member 原文有据 → 采用', o1.owner_label === '老妈', JSON.stringify(o1.owner_label));
  const o2 = aiLib.normalizeItem({ type: 'expense', amount: 50, txn_date: db.todayStr(), merchant: '超市', for_member: '红霞' }, ledgerId, { sourceText: '超市购物 50 元' });
  check('归属人臆造核验：原文没提到 → 丢弃', o2.owner_label === null, JSON.stringify(o2.owner_label));
  // 习惯补位：先经确认接口落两笔带归属人的口腔医院（顺带覆盖 confirm 落库链路）
  const accAny = db.get('SELECT id FROM accounts WHERE ledger_id = ? AND is_archived = 0 LIMIT 1', ledgerId);
  let confirmedOwner = false;
  for (const amt of [60, 55]) {
    const rC = await req('POST', '/api/ai/confirm', { json: { items: [{ type: 'expense', amount_cents: amt * 100, account_id: Number(accAny.id), category_id: null, txn_date: db.todayStr(), merchant: '口腔医院', note: '', owner_label: '老妈' }], source: 'ai_screenshot' } });
    confirmedOwner = !!(rC.json && rC.json.ok);
  }
  check('确认入库接口接受归属人', confirmedOwner, '');
  const ownerRow = db.get("SELECT owner_label FROM transactions WHERE ledger_id = ? AND merchant = '口腔医院' AND deleted_at IS NULL LIMIT 1", ledgerId);
  check('确认入库：owner_label 落库', ownerRow && ownerRow.owner_label === '老妈', JSON.stringify(ownerRow));
  const o3 = aiLib.normalizeItem({ type: 'expense', amount: 60, txn_date: db.todayStr(), merchant: '口腔医院' }, ledgerId, { sourceText: '口腔医院 60 元' });
  check('归属人习惯补位：同商户 ≥2 次 → 推荐且带标记', o3.owner_label === '老妈' && o3.owner_recommended === true, JSON.stringify({ o: o3.owner_label, r: o3.owner_recommended }));
  check('归属人沉淀并入候选名单', aiLib.familyMembers(ledgerId).includes('老妈'), JSON.stringify(aiLib.familyMembers(ledgerId)));
  const ob = txnLib.ownerBreakdown(ledgerId, '2000-01-01', '9999-12-31');
  check('归属人统计聚合', ob.length >= 1 && ob[0].label === '老妈' && ob[0].cnt >= 2, JSON.stringify(ob));
  check('流水按归属人筛选', txnLib.listTransactions(ledgerId, { owner: '老妈' }).rows.length >= 2, '');
  check('归属人筛选清洗空白（「 老 妈 」→ 老妈）', txnLib.listTransactions(ledgerId, { owner: ' 老 妈 ' }).rows.length >= 2, '');

  /* --- 名单路由 HTTP（审查 P1 回归：分隔正则曾把字母 s 当分隔符，Rose 被劈开）--- */
  r = await req('GET', '/members');
  check('成员页渲染家庭名单卡片', r.status === 200 && r.text.includes('家庭成员（归属人）'), `HTTP ${r.status}`);
  const fSaved2 = await req('POST', '/members/family', {
    form: { _csrf: csrfOf(r.text), names: 'Rose、Alice、老妈' },
  });
  const famAfterPost = JSON.parse(db.getSetting(`family.members.${ledgerId}`, '[]'));
  check('名单保存：含字母 s 的名字不被劈开（Rose 完整）',
    fSaved2.status === 302 && famAfterPost.includes('Rose') && famAfterPost.includes('Alice') && famAfterPost.length === 3,
    JSON.stringify(famAfterPost));
  db.setSetting(`family.members.${ledgerId}`, famSaved);

  /* --- H. P13 个人词表：沉淀 / 优先于系统表 / 可删除 / 防复活 --- */
  const gasKw = aiLib.classifyByKeywords('煤气站 80元');
  const gasCat = gasKw && aiLib.resolveCategoryId(ledgerId, gasKw.category, 'expense');
  check('「煤气站」命中系统关键词表（燃气费，词表优先级的前提）', !!gasCat, gasKw && gasKw.category);
  if (gasCat) {
    r = await req('POST', '/api/ai/text', { json: { text: '煤气站 80元' }, cookie });
    const itH0 = (r.json.items || [])[0] || {};
    check('无词表时系统关键词给燃气费', Number(itH0.category_id) === Number(gasCat) && !itH0.category_recommended,
      `category_id=${itH0.category_id}`);

    const merchantD = aiLib.cleanMerchant('煤气站 80元');
    for (let i = 0; i < 3; i++) {
      // 走手动记账路由：同时覆盖「POST /transactions 触发沉淀」的挂点
      await req('POST', '/transactions', {
        cookie, form: {
          _csrf: csrf, type: 'expense', amount: '80', account_id: String(alipay.id), category_id: String(fruitCat),
          txn_date: db.todayStr(), merchant: merchantD, note: '',
        },
      });
    }
    const dictRows0 = dictLib.listActive(ledgerId);
    check('3 笔稳定映射自动沉淀个人词表（商户→水果）',
      dictRows0.some((e) => e.kw === merchantD && Number(e.category_id) === Number(fruitCat) && e.hits === 3),
      JSON.stringify(dictRows0));

    r = await req('POST', '/api/ai/text', { json: { text: '煤气站 80元' }, cookie });
    const itH1 = (r.json.items || [])[0] || {};
    check('个人词表优先于系统关键词表（煤气站→水果而非燃气费）',
      Number(itH1.category_id) === Number(fruitCat) && itH1.category_recommended === true,
      `category_id=${itH1.category_id}`);

    check('词表包含匹配（备注/原文含关键词也命中）',
      dictLib.lookup(ledgerId, '', `在${merchantD}加气 50`, 'expense') !== null);
    check('词表 kind 过滤（支出词表不给收入用）',
      dictLib.lookup(ledgerId, merchantD, `${merchantD} 50`, 'income') === null);

    const setPage = await req('GET', '/settings', { cookie });
    check('设置页展示个人词表卡（可解释）', setPage.status === 200 && setPage.text.includes('个人词表') && setPage.text.includes(merchantD),
      `HTTP ${setPage.status}`);

    r = await req('POST', '/settings/dict/delete', {
      cookie, form: { _csrf: csrf, kw: merchantD, kind: 'expense' },
    });
    check('词表逐条删除（可遗忘）', r.status === 302 && !dictLib.listActive(ledgerId).some((e) => e.kw === merchantD), `HTTP ${r.status}`);
    r = await req('POST', '/api/ai/text', { json: { text: '煤气站 80元' }, cookie });
    const itH2 = (r.json.items || [])[0] || {};
    check('删除后回落系统关键词（燃气费），兜底链不死锁',
      Number(itH2.category_id) === Number(gasCat) && !itH2.category_recommended, `category_id=${itH2.category_id}`);

    await req('POST', '/transactions', {
      cookie, form: {
        _csrf: csrf, type: 'expense', amount: '80', account_id: String(alipay.id), category_id: String(fruitCat),
        txn_date: db.todayStr(), merchant: merchantD, note: '',
      },
    });
    check('已删条目不自动复活（4 笔 100% 也不回表）',
      !dictLib.listActive(ledgerId).some((e) => e.kw === merchantD));
  }

  // 占比不达标不沉淀：3 水果 + 2 其他 = 60% < 80%
  const merchantMix = aiLib.cleanMerchant('混合站 10元');
  const otherCat = aiLib.resolveCategoryId(ledgerId, '其他支出', 'expense');
  for (let i = 0; i < 3; i++) {
    txnLib.createTransaction(ledgerId, user.id, {
      type: 'expense', amount_cents: 1000, account_id: wechat.id, category_id: fruitCat,
      txn_date: db.todayStr(), merchant: merchantMix, note: '', source: 'manual',
    });
  }
  for (let i = 0; i < 2; i++) {
    txnLib.createTransaction(ledgerId, user.id, {
      type: 'expense', amount_cents: 1000, account_id: wechat.id, category_id: otherCat,
      txn_date: db.todayStr(), merchant: merchantMix, note: '', source: 'manual',
    });
  }
  check('主分类占比不足 80% 不沉淀', !dictLib.listActive(ledgerId).some((e) => e.kw === merchantMix));

  /* --- I. P12 反馈闭环：推荐被改 → 负反馈 → 习惯退火（分类/归属人/账户 + 词表联动） --- */
  const merchantFb = aiLib.cleanMerchant('康齿堂 300元');
  check('「康齿堂」不命中关键词表（保证走习惯路径）', !aiLib.classifyByKeywords('康齿堂 300元'));
  for (let i = 0; i < 2; i++) {
    txnLib.createTransaction(ledgerId, user.id, {
      type: 'expense', amount_cents: 30000, account_id: wechat.id, category_id: lunchCat,
      txn_date: db.todayStr(), merchant: merchantFb, note: '', source: 'manual', owner_label: '老妈',
    });
  }
  r = await req('POST', '/api/ai/text', { json: { text: '康齿堂 300元' }, cookie });
  const itI0 = (r.json.items || [])[0] || {};
  check('反馈前：习惯推荐分类/账户/归属人（午餐+微信+老妈）',
    Number(itI0.category_id) === Number(lunchCat) && itI0.category_recommended === true
      && Number(itI0.account_id) === Number(wechat.id) && itI0.account_recommended === true
      && itI0.owner_label === '老妈' && itI0.owner_recommended === true,
    JSON.stringify({ c: itI0.category_id, a: itI0.account_id, o: itI0.owner_label }));

  // 模拟 m.js/app.js：确认时全改掉，并带上「编辑前的推荐快照」
  const snap = { category_id: itI0.category_id, account_id: itI0.account_id, owner_label: itI0.owner_label || null };
  r = await req('POST', '/api/ai/confirm', {
    cookie, json: {
      items: [{ ...itI0, category_id: fruitCat, account_id: alipay.id, owner_label: '', rec_snapshot: snap }],
      source: 'ai_screenshot',
    },
  });
  check('改推荐后确认入库 ok', r.status === 200 && r.json.ok === true && r.json.created === 1, `HTTP ${r.status}`);
  const fbRows = db.all('SELECT field, recommended, confirmed FROM habit_feedback WHERE ledger_id = ? AND merchant = ?', ledgerId, merchantFb);
  check('三个被改字段各记一条负反馈',
    fbRows.filter((x) => x.field === 'category').length === 1
      && fbRows.filter((x) => x.field === 'account').length === 1
      && fbRows.filter((x) => x.field === 'owner').length === 1,
    JSON.stringify(fbRows));
  check('反馈行记录推荐值与最终值（category）',
    fbRows.some((x) => x.field === 'category' && Number(x.recommended) === Number(lunchCat) && Number(x.confirmed) === Number(fruitCat)),
    JSON.stringify(fbRows.filter((x) => x.field === 'category')));

  check('习惯分类退火：午餐被扣穿，水果接棒', Number(aiLib.habitCategoryId(ledgerId, merchantFb)) === Number(fruitCat),
    String(aiLib.habitCategoryId(ledgerId, merchantFb)));
  check('习惯归属人退火：老妈被清掉后不再推荐', aiLib.habitOwnerId(ledgerId, merchantFb) === null);
  r = await req('POST', '/api/ai/text', { json: { text: '康齿堂 300元' }, cookie });
  const itI1 = (r.json.items || [])[0] || {};
  check('下一次草稿改推荐水果且不带归属人（学错的不再教）',
    Number(itI1.category_id) === Number(fruitCat) && itI1.category_recommended === true
      && !itI1.owner_label,
    JSON.stringify({ c: itI1.category_id, o: itI1.owner_label }));
  const ctxFb = aiLib.buildContext(ledgerId);
  check('习惯摘要不再含被扣穿的映射（康齿堂→餐饮/午餐）', !/康齿堂→餐饮\/午餐/.test(ctxFb.habits || ''), ctxFb.habits);

  // 词表联动扣分：3 笔词表映射被连续改 2 次 → 词表失效 + 习惯同步退火
  const merchantDict = aiLib.cleanMerchant('甲词表站 60元');
  check('「甲词表站」不命中关键词表', !aiLib.classifyByKeywords('甲词表站 60元'));
  for (let i = 0; i < 3; i++) {
    txnLib.createTransaction(ledgerId, user.id, {
      type: 'expense', amount_cents: 6000, account_id: wechat.id, category_id: fruitCat,
      txn_date: db.todayStr(), merchant: merchantDict, note: '', source: 'manual',
    });
  }
  // lib 直建不走路由挂点，显式触发一次沉淀（与 POST /transactions 内部同款调用）
  dictLib.sediment(ledgerId, merchantDict);
  check('词表联动前提：甲词表站已沉淀', dictLib.listActive(ledgerId).some((e) => e.kw === merchantDict));
  for (let round = 0; round < 2; round++) {
    r = await req('POST', '/api/ai/text', { json: { text: '甲词表站 60元' }, cookie });
    const itD = (r.json.items || [])[0] || {};
    r = await req('POST', '/api/ai/confirm', {
      cookie, json: {
        items: [{
          ...itD, category_id: lunchCat,
          rec_snapshot: { category_id: itD.category_id, account_id: itD.account_id, owner_label: itD.owner_label || null },
        }],
        source: 'ai_screenshot',
      },
    });
    check(`第 ${round + 1} 次改掉词表推荐并确认`, r.status === 200 && r.json.ok === true, `HTTP ${r.status}`);
  }
  check('词表被连续改 2 次后失效（hits 3−2−2<1）',
    !dictLib.listActive(ledgerId).some((e) => e.kw === merchantDict),
    JSON.stringify(dictLib.listActive(ledgerId).slice(0, 5)));
  r = await req('POST', '/api/ai/text', { json: { text: '甲词表站 60元' }, cookie });
  const itD2 = (r.json.items || [])[0] || {};
  check('词表失效 + 习惯同扣穿：最终推荐落到用户改后的分类（午餐）',
    Number(itD2.category_id) === Number(lunchCat) && itD2.category_recommended === true,
    `category_id=${itD2.category_id}`);

  // 反馈扣分持久：demote 不被后续 sediment 重估抹掉（审查 P3-2 修复回归）
  const merchantP = aiLib.cleanMerchant('乙持久站 20元');
  for (let i = 0; i < 3; i++) {
    txnLib.createTransaction(ledgerId, user.id, {
      type: 'expense', amount_cents: 2000, account_id: wechat.id, category_id: fruitCat,
      txn_date: db.todayStr(), merchant: merchantP, note: '', source: 'manual',
    });
  }
  dictLib.sediment(ledgerId, merchantP);
  dictLib.demote(ledgerId, merchantP, fruitCat);
  check('词表扣分后有效分 3−2=1 仍存活（listActive 展示有效值）',
    dictLib.listActive(ledgerId).some((e) => e.kw === merchantP && e.hits === 1));
  txnLib.createTransaction(ledgerId, user.id, {
    type: 'expense', amount_cents: 2000, account_id: wechat.id, category_id: fruitCat,
    txn_date: db.todayStr(), merchant: merchantP, note: '', source: 'manual',
  });
  dictLib.sediment(ledgerId, merchantP); // 重估刷新 hits=4，penalty 应保留
  check('sediment 重估不抹掉扣分（有效分 4−2=2）',
    dictLib.listActive(ledgerId).some((e) => e.kw === merchantP && e.hits === 2));
  dictLib.demote(ledgerId, merchantP, fruitCat);
  check('再次扣分即失效（4−2−2<1 → dismissed）', !dictLib.listActive(ledgerId).some((e) => e.kw === merchantP));

  // 类型被改（支出↔收入）时只比归属人（审查 P3-8 修复回归：跨 kind 分类/账户比对无意义）
  aiLib.recordDraftFeedback(ledgerId, [{
    type: 'income', merchant: '类型变更站', category_id: lunchCat, account_id: alipay.id, owner_label: '',
    rec_snapshot: { type: 'expense', category_id: fruitCat, account_id: wechat.id, owner_label: '老妈' },
  }]);
  const rowsType = db.all('SELECT field FROM habit_feedback WHERE merchant = ?', '类型变更站');
  check('类型变更只记归属人一条负反馈', rowsType.length === 1 && rowsType[0].field === 'owner', JSON.stringify(rowsType));

  // 没推荐过的字段被改不记反馈（其他兜底换成真分类不是惩罚）
  const beforeNoRec = Number(db.get('SELECT COUNT(*) AS c FROM habit_feedback').c);
  r = await req('POST', '/api/ai/confirm', {
    cookie, json: {
      items: [{
        type: 'expense', amount_cents: 1200, txn_date: db.todayStr(), merchant: '无推荐站',
        account_id: alipay.id, category_id: fruitCat, note: '',
        rec_snapshot: { category_id: null, account_id: null, owner_label: null },
      }],
    },
  });
  check('快照为空的字段不产生负反馈', r.status === 200 && r.json.ok === true
    && Number(db.get('SELECT COUNT(*) AS c FROM habit_feedback').c) === beforeNoRec);
  // 旧客户端不带快照：优雅跳过
  r = await req('POST', '/api/ai/confirm', {
    cookie, json: { items: [{ type: 'expense', amount_cents: 1200, txn_date: db.todayStr(), merchant: '无快照站', account_id: alipay.id, category_id: fruitCat, note: '' }] },
  });
  check('不带快照的旧客户端确认不报错也不记反馈', r.status === 200 && r.json.ok === true
    && Number(db.get('SELECT COUNT(*) AS c FROM habit_feedback').c) === beforeNoRec);

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
