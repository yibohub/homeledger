'use strict';
/**
 * 回归：P15 识别原文落库（ai_inputs 识别事件表，docs/ai-roadmap.md §P15）
 *
 * 需先在 8099 起隔离实例（run-all 自动拉起）：
 *   PORT=8099 HOST=127.0.0.1 DATA_DIR=<repo>/data-verify node server.js
 * 覆盖：text 入口记一行（原文/引擎/笔数）、查询句不落库（ai-ask 不在本表口径）、
 *       scan 入口记一行（附言+图片数）、chat 自动入库带 first_txn_id、
 *       openapi /ai/bill 记 source=api、空载荷 400 不落库、
 *       0 笔识别照样落库（失败样本恰是分析素材）、4000 字符截断
 *
 * 运行：node test/verify-ai-inputs.js
 */
const fs = require('node:fs');
const path = require('node:path');

const BASE = 'http://127.0.0.1:8099';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}

// 8099 实例的数据目录：run-all 会把服务端 DATA_DIR 传进环境；手工跑时默认 data-verify
const SERVER_DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data-verify');
// 每次读都开新连接：只读连接在 WAL 下会停在打开瞬间的快照，看不到服务端新写入（实测踩坑）；
// 可写连接（测试只读不写）能读到最新已提交状态。轮询兜底跨过写入可见性的毫秒级窗口。
function db() {
  const { DatabaseSync } = require('node:sqlite');
  const conn = new DatabaseSync(path.join(SERVER_DATA_DIR, 'homeledger.db'));
  conn.exec('PRAGMA busy_timeout = 5000;');
  return conn;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function inputCount() {
  for (let i = 0; ; i++) {
    try { return Number(db().prepare('SELECT COUNT(*) AS c FROM ai_inputs').get().c); }
    catch (e) { if (i >= 9) throw e; await sleep(100); }
  }
}
// 轮询到「行数超过 afterCount」（即本次 POST 的新行已可见）再取最新行——
// 服务端响应与写入对新连接可见之间存在毫秒级窗口，只兜「非空」会读到旧行
async function lastInput(afterCount = 0) {
  for (let i = 0; ; i++) {
    const conn = db();
    const n = Number(conn.prepare('SELECT COUNT(*) AS c FROM ai_inputs').get().c);
    if (n > afterCount || i >= 19) {
      const row = conn.prepare('SELECT * FROM ai_inputs ORDER BY id DESC LIMIT 1').get();
      conn.close();
      return row;
    }
    conn.close();
    await sleep(100);
  }
}

let jar = '';
let csrf = '';
async function req(method, p, { form, json, headers = {}, auth: bearer } = {}) {
  const h = { ...headers };
  h.cookie = jar;
  if (form) h['content-type'] = 'application/x-www-form-urlencoded';
  if (json) {
    h['content-type'] = 'application/json';
    if (csrf) h['x-csrf-token'] = csrf;
  }
  if (bearer) h.authorization = `Bearer ${bearer}`;
  const res = await fetch(BASE + p, {
    method, headers: h,
    body: form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : undefined,
    redirect: 'manual',
  });
  const sc = res.headers.getSetCookie?.() || [];
  if (sc.length) jar = sc.map((c) => c.split(';')[0]).join('; ');
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: buf.toString('utf8'), json: (() => { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } })() };
}
const csrfOf = (html) => (html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];

(async () => {
  console.log('\n=== P15 识别原文落库（HTTP 端到端）===\n');
  let up = true;
  try { await fetch(BASE + '/login'); } catch { up = false; }
  if (!up) {
    console.log('  SKIP  8099 未启动。请先：PORT=8099 HOST=127.0.0.1 DATA_DIR=<repo>/data-verify node server.js');
    console.log(`\n结果：${pass} 通过 / ${fail} 失败（未含 HTTP 段）\n`);
    process.exit(fail ? 1 : 0);
  }

  let r = await req('GET', '/login');
  const login = await req('POST', '/login', { form: { _csrf: csrfOf(r.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', login.status === 302, `HTTP ${login.status}`);
  r = await req('GET', '/');
  csrf = (r.text.match(/name="csrf" content="([^"]+)"/) || [])[1] || '';
  check('取得页面 CSRF 令牌', !!csrf);

  const before = await inputCount();
  check('ai_inputs 表已就位（迁移建表）', before === 0, `rows=${before}`);

  /* --- text 入口：记账句落一行 --- */
  r = await req('POST', '/api/ai/text', { json: { text: '午饭 30 元' } });
  check('text 记账识别成功（规则引擎）', r.status === 200 && r.json?.ok === true && r.json?.items?.length >= 1,
    JSON.stringify({ engine: r.json?.engine, items: r.json?.items?.length }));
  let row = await lastInput(before);
  check('text 落库：source/engine/原文/笔数',
    row && row.source === 'text' && row.engine === 'rule' && row.input_text === '午饭 30 元'
    && Number(row.item_count) === r.json.items.length && Number(row.image_count) === 0,
    JSON.stringify(row));

  /* --- text 入口：查询句走 ai-ask，不落库 --- */
  const cntAfterTxn = await inputCount();
  r = await req('POST', '/api/ai/text', { json: { text: '这个月花了多少' } });
  check('查询句走对话查账（不进记账管线）', r.status === 200 && r.json?.ok === true && !!r.json?.mode, `mode=${r.json?.mode}`);
  const cntAfterQuery = await inputCount();
  check('查询句不落 ai_inputs（口径只含记账识别）', cntAfterQuery === cntAfterTxn, `count=${cntAfterQuery}`);

  /* --- scan 入口：文字附言识别 --- */
  r = await req('POST', '/api/ai/scan', { json: { text: '打车 15 元', images: [] } });
  check('scan 识别成功', r.status === 200 && r.json?.ok === true, JSON.stringify({ engine: r.json?.engine }));
  row = await lastInput(cntAfterQuery);
  check('scan 落库：source/附言原文/图片数',
    row && row.source === 'scan' && row.input_text === '打车 15 元' && Number(row.image_count) === 0 && row.attachment_id == null,
    JSON.stringify(row));

  /* --- chat 入口：自动入库带 first_txn_id --- */
  const cntBeforeChat = await inputCount();
  r = await req('POST', '/api/ai/chat', { json: { text: '咖啡 22 元' } });
  check('chat 自动入库成功', r.status === 200 && r.json?.created >= 1, JSON.stringify({ created: r.json?.created }));
  row = await lastInput(cntBeforeChat);
  const chatTxn = row && row.first_txn_id
    ? db().prepare('SELECT id, amount_base_cents FROM transactions WHERE id = ?').get(row.first_txn_id)
    : null;
  check('chat 落库：source/first_txn_id 指向实账（撤销后可回溯原文）',
    row && row.source === 'chat' && chatTxn && Number(chatTxn.amount_base_cents) === 2200,
    JSON.stringify({ row: row && { source: row.source, first: row.first_txn_id }, txn: chatTxn }));

  /* --- 空载荷：400 且不落库 --- */
  const cntBeforeEmpty = await inputCount();
  r = await req('POST', '/api/ai/chat', { json: {} });
  check('空载荷被拒 400', r.status === 400, `HTTP ${r.status}`);
  const cntAfterEmpty = await inputCount();
  check('空载荷不落库', cntAfterEmpty === cntBeforeEmpty, `count=${cntAfterEmpty}`);

  /* --- 0 笔识别照样落库（失败样本恰是分析素材）+ 4000 截断 --- */
  const longText = '随便说点什么没有金额 ' + 'x'.repeat(5000);
  r = await req('POST', '/api/ai/text', { json: { text: longText } });
  check('无金额文本识别 0 笔不报错', r.status === 200 && r.json?.items?.length === 0, `items=${r.json?.items?.length}`);
  row = await lastInput(cntAfterEmpty);
  check('0 笔识别照样落库（失败样本）且原文截断 4000',
    row && row.source === 'text' && Number(row.item_count) === 0 && row.input_text.length === 4000,
    `len=${row && row.input_text.length}`);

  /* --- openapi /ai/bill：source=api + confirm 入库 --- */
  r = await req('GET', '/settings');
  await req('POST', '/settings/api-tokens', { form: { _csrf: csrfOf(r.text), name: 'p15-check' } });
  r = await req('GET', '/settings');
  const token = (r.text.match(/data-token="(hl_[A-Za-z0-9_-]+)"/) || [])[1];
  check('开放 API 令牌已创建', !!token, '');
  const cntBeforeApi = await inputCount();
  r = await req('POST', '/api/open/ai/bill', { auth: token, json: { text: '停车费 10 元', confirm: true } });
  check('openapi /ai/bill 识别入库成功', r.status === 200 && r.json?.ok === true && r.json?.created >= 1,
    JSON.stringify({ created: r.json?.created, engine: r.json?.engine }));
  row = await lastInput(cntBeforeApi);
  check('api 落库：source=api / 原文 / first_txn_id',
    row && row.source === 'api' && row.input_text === '停车费 10 元' && row.first_txn_id != null,
    JSON.stringify(row && { source: row.source, first: row.first_txn_id }));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
