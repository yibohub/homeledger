'use strict';
/**
 * 回归：AI 记账助手（POST /api/ai/chat + 前端挂载）
 *
 * 需先在 8099 起隔离实例：
 *   PORT=8099 HOST=127.0.0.1 DATA_DIR=<repo>/data-verify node server.js
 * 覆盖：未登录拒绝、空载荷、纯文字自动记账（规则引擎）、文字+图片附件关联、
 *       仅图片零结果的友好返回、页面挂载（FAB/面板/脚本/CSS）、明细页 AI 筛选可见、
 *       敏感记账本地分流（收入类关键词命中不出网，默认开可关；mock 模型计数器验证）
 *
 * 运行：node test/verify-ai-chat.js
 */
const http = require('node:http');
const BASE = 'http://127.0.0.1:8099';

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
// 1x1 透明 PNG
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

(async () => {
  console.log('\n=== AI 记账助手（HTTP 端到端）===\n');

  /* --- 未登录拒绝 --- */
  let r = await req('POST', '/api/ai/chat', { json: { text: '午饭 10 元' } });
  check('未登录 POST 被拒', r.status !== 200, `HTTP ${r.status}`);

  /* --- 登录 --- */
  r = await req('GET', '/login');
  const loginRes = await req('POST', '/login', { form: { _csrf: csrfOf(r.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', loginRes.status === 302, `HTTP ${loginRes.status}`);
  const cookie = loginRes.setCookie.map((c) => c.split(';')[0]).join('; ');

  /* --- 页面挂载 --- */
  r = await req('GET', '/');
  csrf = (r.text.match(/name="csrf" content="([^"]+)"/) || [])[1] || '';
  check('已取得页面 CSRF 令牌', !!csrf);
  check('总览页渲染助手 FAB', r.text.includes('id="aiFab"'));
  check('总览页渲染助手面板', r.text.includes('id="aiPanel"') && r.text.includes('id="aiMsgs"'));
  check('面板带状态提示（已连接或规则解析）', r.text.includes('规则解析') || r.text.includes('AI 模型已连接'));
  check('layout 引入 assistant.js', r.text.includes('/static/js/assistant.js'));
  const layoutHtml = r.text; // 总览页 HTML（悬浮球挂载处）
  r = await req('GET', '/static/js/assistant.js');
  check('assistant.js 可访问', r.status === 200 && r.text.includes('/api/ai/chat'), `HTTP ${r.status}`);
  check('语音输入（P3）：面板含麦克风按钮且默认隐藏（不支持浏览器不留死按钮）', layoutHtml.includes('id="aiMic"') && /id="aiMic"[^>]*hidden/.test(layoutHtml), '');
  check('语音输入（P3）：转写逻辑挂载 Web Speech + 中文', r.text.includes('SpeechRecognition') && r.text.includes('zh-CN'), '');
  check('语音输入（P3）：非安全上下文不亮按钮（HTTP 访问 NAS 时 not-allowed 的根因防护）', r.text.includes('window.isSecureContext'), '');
  check('语音输入（P3）：转写只回显不自动发送', (() => {
    // 按源码区段截取语音段断言（整文件级的正则会被 send() 函数自身命中，拦不住真回归）
    const segStart = r.text.indexOf('语音输入（P3');
    const segEnd = r.text.indexOf('/* ------------------------------ 气泡');
    const seg = r.text.slice(Math.max(0, segStart), segEnd > segStart ? segEnd : undefined);
    return segStart >= 0 && segEnd > segStart && !/send\s*\(/.test(seg) && /textEl\.value\s*=/.test(seg);
  })(), '');
  r = await req('GET', '/static/css/app.css');
  check('助手样式已发布', r.status === 200 && r.text.includes('.ai-fab') && r.text.includes('.ai-bubble'));
  check('语音录音中样式已发布', r.status === 200 && (r.text.includes('.ai-icon-btn.listening') || r.text.includes('aiMicPulse')), '');
  check('CSS 有 [hidden] 全局防御（否则 display:grid 的按钮压过 hidden 属性变成死按钮）', r.status === 200 && r.text.includes('[hidden] { display: none !important; }'), '');

  /* --- 参数校验 --- */
  r = await req('POST', '/api/ai/chat', { json: { text: '   ' }, cookie });
  check('空载荷返回 400 + code=empty', r.status === 400 && r.json && r.json.code === 'empty', `HTTP ${r.status}`);

  /* --- 纯文字自动记账（规则引擎兜底）--- */
  const chat = await req('POST', '/api/ai/chat', { json: { text: '昨天午饭 35 元，打车 26.5 元' }, cookie });
  check('纯文字识别 ok', chat.status === 200 && chat.json.ok === true, `HTTP ${chat.status}`);
  check('识别出 2 笔且已入库', chat.json.items && chat.json.items.length === 2 && chat.json.created === 2,
    `items=${(chat.json.items || []).length} created=${chat.json.created}`);
  check('规则引擎标记 engine=rule', chat.json.engine === 'rule');
  check('未配置模型时有降级提示', (chat.json.warnings || []).some((w) => /规则解析|尚未配置/.test(w)),
    (chat.json.warnings || []).join(' | '));
  const lunch = (chat.json.items || []).find((it) => /午/.test(it.category_path || '') || /午饭/.test(it.merchant || it.note || ''));
  check('金额解析正确（3500 分）', lunch && Number(lunch.amount_cents) === 3500, lunch && String(lunch.amount_cents));
  // 本地今天（不能用 toISOString：那是 UTC 日期，凌晨 0-8 点会比本地慢一天，断言必挂）
  const localToday = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  check('相对日期解析为昨天', lunch && lunch.txn_date && lunch.txn_date < localToday(), lunch && lunch.txn_date);

  /* --- 数据落库：source=ai_chat --- */
  const list = await req('GET', '/transactions?source=ai_chat', { cookie });
  check('明细页「ai_chat」筛选可访问', list.status === 200, `HTTP ${list.status}`);
  check('明细列表出现 35.00', list.text.includes('35.00'));

  /* --- 文字 + 图片：附件关联 --- */
  const chat2 = await req('POST', '/api/ai/chat', { json: { text: '奶茶 18 元', images: [{ dataUrl: TINY_PNG, name: 'bill.png' }] }, cookie });
  check('图文混合识别 ok', chat2.status === 200 && chat2.json.ok === true, `HTTP ${chat2.status}`);
  check('图片已存档', (chat2.json.images || []).length === 1, `images=${(chat2.json.images || []).length}`);
  check('图片已关联到生成的流水', (chat2.json.linked || []).length >= 1, JSON.stringify(chat2.json.linked || []));
  const createdId = (chat2.json.ids || [])[0];
  if (createdId) {
    r = await req('GET', `/transactions/${createdId}/edit`, { cookie });
    check('详情页可见关联原图', r.status === 200 && r.text.includes('/uploads/'));
  }

  /* --- 仅图片（无文字）：零结果友好返回 --- */
  const chat3 = await req('POST', '/api/ai/chat', { json: { images: [{ dataUrl: TINY_PNG }] }, cookie });
  check('仅图片不报 500/400', chat3.status === 200, `HTTP ${chat3.status}`);
  check('零结果 ok=true 不算失败', chat3.json.ok === true && (chat3.json.items || []).length === 0 && chat3.json.created === 0);
  check('零结果带降级提示', (chat3.json.warnings || []).length >= 1, (chat3.json.warnings || []).join(' | '));

  /* --- 超限裁剪 --- */
  const many = Array.from({ length: 9 }, () => ({ dataUrl: TINY_PNG }));
  const chat4 = await req('POST', '/api/ai/chat', { json: { text: '测试', images: many }, cookie });
  check('图片最多收 6 张（9 张入参被裁剪）', (chat4.json.images || []).length === 6, `images=${(chat4.json.images || []).length}`);

  /* --- 敏感记账本地分流（默认开；mock 模型带调用计数器）--- */
  console.log('\n=== 敏感记账本地分流 ===\n');
  const db = require('../src/db');
  const dbGet = (k) => db.getSetting(k, '');
  // mock 模型：返回合法识别结果 + 调用计数（被调用即计数，分流正确时敏感文本应为 0 次）
  let mockCalls = 0;
  const MODEL_MERCHANT = '对照模型识别';
  const mock = http.createServer((mq, mr) => {
    mq.on('data', () => {});
    mq.on('end', () => {
      mockCalls += 1;
      mr.writeHead(200, { 'Content-Type': 'application/json' });
      mr.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        items: [{ type: 'expense', amount: 35, txn_date: new Date().toISOString().slice(0, 10), merchant: MODEL_MERCHANT, category_name: '餐饮/午餐', confidence: 0.9 }],
      }) } }] }));
    });
  });
  await new Promise((res2) => mock.listen(0, '127.0.0.1', res2));
  // 走设置路由写配置（顺带覆盖 ai.sensitive_local_only 的 checkbox 解析）
  r = await req('GET', '/settings', { cookie });
  check('设置页渲染敏感分流开关', r.status === 200 && r.text.includes('敏感记账走本地规则'), `HTTP ${r.status}`);
  const aiCsrf = csrfOf(r.text);
  await req('POST', '/settings/ai', {
    cookie, form: {
      _csrf: aiCsrf, 'ai.enabled': '1', 'ai.base_url': `http://127.0.0.1:${mock.address().port}/v1`,
      'ai.model': 'mock-guard', 'ai.vision': '1', 'ai.timeout_ms': '90000', 'ai.sensitive_local_only': '1',
    },
  });
  check('开关默认持久化为开', dbGet('ai.sensitive_local_only') === 'true', dbGet('ai.sensitive_local_only'));

  // 开关 ON：敏感文本不出网
  const beforeSensitive = mockCalls;
  r = await req('POST', '/api/ai/chat', { json: { text: '十月工资 12000 到账' }, cookie });
  check('敏感文本（工资）走规则引擎', r.json?.engine === 'rule' && r.json.ok === true, `engine=${r.json?.engine}`);
  check('敏感文本模型零调用', mockCalls === beforeSensitive, `calls=${mockCalls - beforeSensitive}`);
  check('敏感分流带透明提示', (r.json.warnings || []).some((w) => w.includes('未发送至模型服务')), (r.json.warnings || []).join(' | '));
  check('规则链正确识别收入（type=income 且金额 12000）',
    (r.json.items || []).some((it) => it.type === 'income' && Number(it.amount_cents) === 1200000),
    JSON.stringify((r.json.items || [])[0] || {}));

  // 开关 ON：草稿路径同样分流（不入库）
  r = await req('POST', '/api/ai/text', { json: { text: '年终奖 8000' }, cookie });
  check('草稿路径敏感文本也走规则（不入库）',
    r.json?.engine === 'rule' && r.json.items?.length >= 1 && r.json.created === undefined, `engine=${r.json?.engine}`);
  check('敏感文本模型仍零调用', mockCalls === beforeSensitive, `calls=${mockCalls - beforeSensitive}`);

  // 开关 ON：非敏感文本正常走模型（防误拦）
  r = await req('POST', '/api/ai/chat', { json: { text: '午饭 35 元' }, cookie });
  check('非敏感文本正常走模型（engine=llm）', r.json?.engine === 'llm', `engine=${r.json?.engine}`);
  check('模型结果生效（商户来自 mock）', (r.json.items || [])[0]?.merchant === MODEL_MERCHANT, (r.json.items || [])[0]?.merchant);
  check('非敏感模型调用 +1', mockCalls === beforeSensitive + 1, `calls=${mockCalls - beforeSensitive}`);

  // 开关 OFF（设置路由不勾选 → 持久化为 false）：同一敏感文本改走模型
  await req('POST', '/settings/ai', {
    cookie, form: {
      _csrf: aiCsrf, 'ai.enabled': '1', 'ai.base_url': `http://127.0.0.1:${mock.address().port}/v1`,
      'ai.model': 'mock-guard', 'ai.vision': '1', 'ai.timeout_ms': '90000',
    },
  });
  check('开关关闭持久化', dbGet('ai.sensitive_local_only') === 'false', dbGet('ai.sensitive_local_only'));
  r = await req('POST', '/api/ai/chat', { json: { text: '十月工资 12000 到账' }, cookie });
  check('关掉后敏感文本走模型（对比口径）', r.json?.engine === 'llm', `engine=${r.json?.engine}`);
  check('关掉后模型调用 +1', mockCalls === beforeSensitive + 2, `calls=${mockCalls - beforeSensitive}`);

  mock.close();
  db.setSetting('ai.enabled', 'false');
  db.setSetting('ai.base_url', '');
  db.setSetting('ai.model', '');
  db.setSetting('ai.sensitive_local_only', 'true');

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
