'use strict';
/**
 * 回归：手机极简模式（P10，layout-m 三 Tab + 捕获区）
 *
 * 需先在 8099 起隔离实例（run-all 自动拉起）。覆盖：
 *   - 布局切换矩阵：手机 UA 自动极简 / 桌面 UA 不自动 / cookie hl_simple 显式开与关
 *   - Tab 结构：三 Tab 导航、/more 领域分组、「切换完整版」入口
 *   - Tab1 内容：大数字、预算条、捕获区（语音/拍账单/文字三入口）、最近 5 笔
 *   - 捕获区管线：草稿确认流走 /api/ai/text → /api/ai/confirm（规则引擎，先草稿后确认）
 *   - 问账嵌入（阶段 2）：问句走 ai-ask 查账返回回答而非草稿、不改数据；
 *     只读成员可见捕获区（拍单隐藏）可问不可记；桌面 AI 页文字快记同分流
 *   - 完整版回归：显式 layout 的页面（如 /login）不受极简模式影响
 *
 * 运行：node test/verify-minimal.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// 8099 实例的数据目录：run-all 会把服务端 DATA_DIR 传进环境，手工跑时默认 data-verify
// （只读矩阵要直连该库改角色；目录名不是 data-verify* 就跳过，防止手工误指真实数据目录）
const SERVER_DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data-verify');

const BASE = 'http://127.0.0.1:8099';
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}

let jar = '';
let csrf = '';
async function req(method, p, { form, json, headers = {}, ua = DESKTOP_UA, noCookie = false } = {}) {
  const h = { 'user-agent': ua, ...headers };
  if (!noCookie) h.cookie = jar;
  if (form) h['content-type'] = 'application/x-www-form-urlencoded';
  if (json) {
    h['content-type'] = 'application/json';
    if (csrf) h['x-csrf-token'] = csrf;
  }
  const res = await fetch(BASE + p, { method, headers: h, body: form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : undefined, redirect: 'manual' });
  const sc = res.headers.getSetCookie?.() || [];
  // 模拟浏览器：Set-Cookie 并入 jar（hl_simple 切换依赖它）
  const extra = sc.map((c) => c.split(';')[0]);
  if (extra.length) {
    const map = new Map(jar.split('; ').filter(Boolean).map((c) => [c.split('=')[0], c.split('=')[1]]));
    for (const e of extra) map.set(e.split('=')[0], e.split('=')[1]);
    jar = [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
const csrfOf = (html) => (html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];

(async () => {
  console.log('\n=== 手机极简模式（P10 阶段 1）===\n');

  /* --- 登录（桌面 UA，会话建立）--- */
  let r = await req('GET', '/login');
  const login = await req('POST', '/login', { form: { _csrf: csrfOf(r.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', login.status === 302, `HTTP ${login.status}`);
  r = await req('GET', '/', { ua: DESKTOP_UA });
  csrf = (r.text.match(/name="csrf" content="([^"]+)"/) || [])[1] || '';
  check('已取得 CSRF 令牌', !!csrf);

  /* --- 布局切换矩阵 --- */
  r = await req('GET', '/', { ua: DESKTOP_UA });
  check('桌面 UA：完整布局（无 m-tabbar）', r.status === 200 && !r.text.includes('m-tabbar') && r.text.includes('class="shell"'), `HTTP ${r.status}`);
  r = await req('GET', '/', { ua: PHONE_UA });
  check('手机 UA：自动极简（layout-m + 三 Tab）', r.status === 200 && r.text.includes('data-layout="m"') && r.text.includes('m-tabbar')
    && r.text.includes('href="/transactions"') && r.text.includes('href="/more"'), `HTTP ${r.status}`);
  check('极简首页含捕获区三入口（输入框独占一行 + 按钮行带文字标签）', r.text.includes('id="mText"') && r.text.includes('id="mMic"') && r.text.includes('id="mCam"') && r.text.includes('id="mGo"')
    && r.text.includes('m-capture-actions') && r.text.includes('>语音</span>') && r.text.includes('>识别</span>'));
  check('极简首页含本月大数字与最近 5 笔区', r.text.includes('m-hero') && r.text.includes('最近 5 笔'));
  check('极简模式隐藏悬浮球（捕获区即全屏形态）', !r.text.includes('id="aiFab"') && !r.text.includes('id="aiPanel"'));

  // cookie 显式覆盖：手机 UA + hl_simple=0 → 完整；桌面 UA + hl_simple=1 → 极简
  const save = jar;
  const setJar = (simple) => {
    const map = new Map(save.split('; ').filter(Boolean).map((c) => [c.split('=')[0], c.split('=')[1]]));
    if (simple === null) map.delete('hl_simple'); else map.set('hl_simple', String(simple));
    jar = [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  };
  setJar(0);
  r = await req('GET', '/', { ua: PHONE_UA });
  check('手机 UA + cookie 关：完整布局', r.status === 200 && !r.text.includes('m-tabbar'), `HTTP ${r.status}`);
  setJar(1);
  r = await req('GET', '/', { ua: DESKTOP_UA });
  check('桌面 UA + cookie 开：极简布局', r.status === 200 && r.text.includes('data-layout="m"'), `HTTP ${r.status}`);

  /* --- 切换入口 --- */
  r = await req('GET', '/ui-mode?simple=0', { ua: PHONE_UA });
  const setCookie = (r.status === 302 && r.text === '') || r.status === 302;
  check('/ui-mode 切换返回跳转', setCookie, `HTTP ${r.status}`);
  jar = save; // 回到自动判定

  /* --- 其他页面套壳与显式布局豁免 --- */
  r = await req('GET', '/transactions', { ua: PHONE_UA });
  check('明细页在极简下套 layout-m 且 Tab2 高亮', r.status === 200 && r.text.includes('data-layout="m"')
    && /<a class="m-tab active" href="\/transactions"/.test(r.text.replace(/\n/g, '')), `HTTP ${r.status}`);
  r = await req('GET', '/more', { ua: PHONE_UA });
  check('「更多」页领域分组（记账/分析/资产与计划/数据/协作与系统）', r.status === 200
    && ['记账', '分析', '资产与计划', '数据', '协作与系统'].every((g) => r.text.includes(g)), `HTTP ${r.status}`);
  check('极简下「更多」页提供「切换完整版」', r.text.includes('/ui-mode?simple=0'));
  check('「更多」页有退出登录入口（手机共用设备场景）', /action="\/logout"/.test(r.text) && r.text.includes('退出登录'));
  setJar(0);
  r = await req('GET', '/more', { ua: PHONE_UA });
  check('完整模式下「更多」页反向提供「切换极简版」（切换不是单行道）', r.status === 200 && r.text.includes('/ui-mode?simple=1'), `HTTP ${r.status}`);
  setJar(null);
  check('「更多」页收纳高频入口（记一笔/报表/预算/订阅）', ['/transactions/new', '/reports', '/budgets', '/subscriptions'].every((h) => r.text.includes(`href="${h}"`)));
  r = await req('GET', '/login', { ua: PHONE_UA, noCookie: true });
  check('显式 layout 页面不受极简影响（/login 用 blank 壳）', r.status === 200 && !r.text.includes('m-tabbar'), `HTTP ${r.status}`);

  /* --- 静态资源 --- */
  const js = await req('GET', '/static/js/m.js', { ua: PHONE_UA });
  check('m.js 可访问且走草稿确认流', js.status === 200 && js.text.includes('/api/ai/text') && js.text.includes('/api/ai/confirm') && js.text.includes('SpeechRecognition'), `HTTP ${js.status}`);
  check('m.js 语音同样要求安全上下文（HTTP 下不亮按钮）', js.status === 200 && js.text.includes('window.isSecureContext'), '');
  check('m.js 问句分支渲染回答卡（answer/clarify）', js.status === 200 && js.text.includes("data.mode === 'answer'") && js.text.includes('m-answer'), '');
  check('m.js 拍单按钮判空（只读视图无 mCam 不报错）', js.status === 200 && js.text.includes('if (camBtn)'), '');
  const djs = await req('GET', '/static/js/app.js', { ua: DESKTOP_UA });
  check('桌面 AI 页文字快记同分流（问句出回答不建草稿）', djs.status === 200 && djs.text.includes("res.mode === 'answer'"), `HTTP ${djs.status}`);
  const css = await req('GET', '/static/css/app.css', { ua: PHONE_UA });
  check('极简样式已发布', css.status === 200 && css.text.includes('.m-tabbar') && css.text.includes('.m-draft'), `HTTP ${css.status}`);

  /* --- 捕获区草稿确认流（规则引擎端到端）--- */
  setJar(1);
  /* XSS 回归（审查 P1）：账户名可含 </script>（开放 API 也能自动建账户），内嵌 JSON 必须转义 */
  const accPage = await req('GET', '/accounts', { ua: PHONE_UA });
  const createAcc = await req('POST', '/accounts', {
    form: { _csrf: csrfOf(accPage.text), name: 'A</script>B', type: 'cash', icon: '💵', initial_balance: '0' },
    ua: PHONE_UA,
  });
  r = await req('GET', '/', { ua: PHONE_UA });
  {
    const block = (r.text.match(/id="mAccounts">([\s\S]*?)<\/script>/) || [null, ''])[1];
    check('含 </script> 的账户名不破坏内嵌 JSON（转义为 \\u003c）', createAcc.status === 302
      && block.includes('A\\u003c/script\\u003eB') && !block.includes('</script'), `${createAcc.status} | block=${block.slice(0, 60)}`);
  }
  const home1 = await req('GET', '/', { ua: PHONE_UA });
  const accs = JSON.parse((home1.text.match(/id="mAccounts">([\s\S]*?)<\/script>/) || [null, '[]'])[1]);
  check('首页内嵌账户清单（缺账户草稿的确认依赖）', accs.length >= 1, JSON.stringify(accs).slice(0, 80));
  r = await req('POST', '/api/ai/text', { json: { text: '午饭 35 元' }, ua: PHONE_UA });
  check('草稿接口出草稿不入库', r.status === 200 && r.json.ok === true && r.json.items.length === 1 && r.json.created === undefined, `HTTP ${r.status}`);
  const draft = r.json.items[0];
  check('草稿带分类与金额（规则引擎）', Number(draft.amount_cents) === 3500 && !!draft.category_id, JSON.stringify({ a: draft.amount_cents, c: draft.category_id }));
  if (!draft.account_id) draft.account_id = accs[0].id; // 与 m.js 草稿卡片同行为：缺账户时下拉默认第一项
  r = await req('POST', '/api/ai/confirm', { json: { items: [draft], source: 'ai_screenshot' }, ua: PHONE_UA });
  check('确认后入库', r.status === 200 && r.json.ok === true && r.json.created === 1, `HTTP ${r.status} ${r.text.slice(0, 80)}`);
  r = await req('GET', '/transactions', { ua: PHONE_UA });
  check('明细页可见入账记录（35.00）', r.status === 200 && r.text.includes('35.00'), `HTTP ${r.status}`);
  r = await req('GET', '/', { ua: PHONE_UA });
  check('极简首页「最近 5 笔」出现该记录（非空态占位文案）', r.status === 200 && r.text.includes('m-txn') && /m-txn[\s\S]{0,400}午饭/.test(r.text), '');

  /* --- 问账嵌入 Tab1（阶段 2）：同一输入框，问句走查账、记账句照旧出草稿 --- */
  // 首页 m-txn 最多渲染 5 条，≥5 笔时页面计数不变、断言恒真——只读不变式按库内计数（评审建议）；
  // 库不可达（非 data-verify* 测试目录）时退回页面计数粗验
  const dbFile = path.join(SERVER_DATA_DIR, 'homeledger.db');
  const dbReachable = /^data-verify/.test(path.basename(SERVER_DATA_DIR)) && fs.existsSync(dbFile);
  const txnCountInDb = () => {
    const c = new DatabaseSync(dbFile);
    c.exec('PRAGMA busy_timeout = 5000;');
    const n = c.prepare('SELECT COUNT(*) AS c FROM transactions WHERE deleted_at IS NULL').get().c;
    c.close();
    return n;
  };
  const countInHtml = (html) => (html.match(/class="m-txn"/g) || []).length;
  const before = dbReachable ? txnCountInDb() : countInHtml(r.text);
  r = await req('POST', '/api/ai/text', { json: { text: '这个月餐饮花了多少' }, ua: PHONE_UA });
  check('问句返回查账回答而非草稿', r.status === 200 && r.json.ok === true
    && (r.json.mode === 'answer' || r.json.mode === 'clarify') && (r.json.text || '').length > 0 && r.json.items === undefined,
    `HTTP ${r.status} mode=${r.json && r.json.mode} text=${r.json ? String(r.json.text).slice(0, 30) : ''}`);
  check('无 Key 时查账走规则引擎（零依赖降级）', r.json.engine === 'rule', `engine=${r.json && r.json.engine}`);
  const afterHome = await req('GET', '/', { ua: PHONE_UA });
  const after = dbReachable ? txnCountInDb() : countInHtml(afterHome.text);
  check('问句不产生任何新记录（查账只读）', after === before, `${before} → ${after}`);

  /* --- 只读成员：可见捕获区可问账，拍单隐藏、不可记（直连 8099 实例的库改角色）--- */
  if (dbReachable) {
    const raw = new DatabaseSync(dbFile);
    raw.exec('PRAGMA busy_timeout = 5000;');
    // 按 ledger_id 圈定（多账本不误伤其他账本角色）；恢复用捕获的原角色，try/finally 保证中途异常也复位（评审建议）
    const adminRow = raw.prepare('SELECT u.id AS id, lm.role AS role, lm.ledger_id AS ledger_id FROM ledger_members lm JOIN users u ON u.id = lm.user_id WHERE u.username = ?').get('admin');
    try {
      raw.prepare("UPDATE ledger_members SET role = 'viewer' WHERE user_id = ? AND ledger_id = ?").run(adminRow.id, adminRow.ledger_id);
      r = await req('GET', '/', { ua: PHONE_UA });
      check('只读成员也见捕获区（可问账），拍单隐藏、主按钮变「提问」', r.status === 200
        && r.text.includes('id="mCapture"') && r.text.includes('id="mText"') && r.text.includes('id="mGo"')
        && !r.text.includes('id="mCam"') && r.text.includes('>提问</span>'), `HTTP ${r.status}`);
      r = await req('POST', '/api/ai/text', { json: { text: '这个月餐饮花了多少' }, ua: PHONE_UA });
      check('只读成员问句可查账', r.status === 200 && r.json && (r.json.mode === 'answer' || r.json.mode === 'clarify'), `HTTP ${r.status} mode=${r.json && r.json.mode}`);
      r = await req('POST', '/api/ai/text', { json: { text: '可乐 6 元' }, ua: PHONE_UA });
      check('只读成员记账句被 403 拒绝（JSON 提示可问账）', r.status === 403 && /只读/.test((r.json || {}).error || '') && ((r.json || {}).error || '').includes('提问'), `HTTP ${r.status} ${r.json && r.json.error}`);
    } finally {
      raw.prepare('UPDATE ledger_members SET role = ? WHERE user_id = ? AND ledger_id = ?').run(adminRow.role, adminRow.id, adminRow.ledger_id);
      raw.close();
    }
    r = await req('POST', '/api/ai/text', { json: { text: '晚饭 42 元' }, ua: PHONE_UA });
    check('恢复角色后记账句照旧出草稿', r.status === 200 && r.json && r.json.ok === true && r.json.items.length === 1 && r.json.mode === undefined, `HTTP ${r.status}`);
  } else {
    check('（跳过只读矩阵：8099 实例库不可达或非测试目录）', true);
  }

  jar = save; // 清掉显式 cookie，避免影响后续（套件进程内无后续，仅保持整洁）

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
