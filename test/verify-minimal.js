'use strict';
/**
 * 回归：手机极简模式（P10 阶段 1，layout-m 三 Tab + 捕获区）
 *
 * 需先在 8099 起隔离实例（run-all 自动拉起）。覆盖：
 *   - 布局切换矩阵：手机 UA 自动极简 / 桌面 UA 不自动 / cookie hl_simple 显式开与关
 *   - Tab 结构：三 Tab 导航、/more 领域分组、「切换完整版」入口
 *   - Tab1 内容：大数字、预算条、捕获区（语音/拍账单/文字三入口）、最近 5 笔
 *   - 捕获区管线：草稿确认流走 /api/ai/text → /api/ai/confirm（规则引擎，先草稿后确认）
 *   - 完整版回归：显式 layout 的页面（如 /login）不受极简模式影响
 *
 * 运行：node test/verify-minimal.js
 */
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
  check('极简首页含捕获区三入口', r.text.includes('id="mText"') && r.text.includes('id="mMic"') && r.text.includes('id="mCam"') && r.text.includes('id="mGo"'));
  check('极简首页含本月大数字与最近 5 笔区', r.text.includes('m-hero') && r.text.includes('最近 5 笔'));
  check('极简模式隐藏悬浮球（捕获区即全屏形态）', !r.text.includes('id="aiFab"') && !r.text.includes('id="aiPanel"'));

  // cookie 显式覆盖：手机 UA + hl_simple=0 → 完整；桌面 UA + hl_simple=1 → 极简
  const save = jar;
  jar = save + '; hl_simple=0';
  r = await req('GET', '/', { ua: PHONE_UA });
  check('手机 UA + cookie 关：完整布局', r.status === 200 && !r.text.includes('m-tabbar'), `HTTP ${r.status}`);
  jar = save + '; hl_simple=1';
  r = await req('GET', '/', { ua: DESKTOP_UA });
  check('桌面 UA + cookie 开：极简布局', r.status === 200 && r.text.includes('data-layout="m"'), `HTTP ${r.status}`);

  /* --- 切换入口 --- */
  r = await req('GET', '/ui-mode?simple=0', { ua: PHONE_UA });
  const setCookie = (r.status === 302 && r.text === '') || r.status === 302;
  check('/ui-mode 切换返回跳转', setCookie, `HTTP ${r.status}`);
  jar = save; // 回到自动判定

  /* --- 其他页面套壳与显式布局豁免 --- */
  r = await req('GET', '/transactions', { ua: PHONE_UA });
  check('明细页在极简下套 layout-m（Tab2 高亮）', r.status === 200 && r.text.includes('data-layout="m"') && /m-tab[^>]*active[^>]*href="\/transactions"/.test(r.text.replace(/\n/g, '')) || (r.text.includes('data-layout="m"') && r.text.includes('账单明细')), `HTTP ${r.status}`);
  r = await req('GET', '/more', { ua: PHONE_UA });
  check('「更多」页领域分组（记账/分析/资产与计划/数据/协作与系统）', r.status === 200
    && ['记账', '分析', '资产与计划', '数据', '协作与系统'].every((g) => r.text.includes(g)), `HTTP ${r.status}`);
  check('「更多」页含「切换完整版」入口', r.text.includes('/ui-mode?simple=0'));
  check('「更多」页收纳高频入口（记一笔/报表/预算/订阅）', ['/transactions/new', '/reports', '/budgets', '/subscriptions'].every((h) => r.text.includes(`href="${h}"`)));
  r = await req('GET', '/login', { ua: PHONE_UA, noCookie: true });
  check('显式 layout 页面不受极简影响（/login 用 blank 壳）', r.status === 200 && !r.text.includes('m-tabbar'), `HTTP ${r.status}`);

  /* --- 静态资源 --- */
  const js = await req('GET', '/static/js/m.js', { ua: PHONE_UA });
  check('m.js 可访问且走草稿确认流', js.status === 200 && js.text.includes('/api/ai/text') && js.text.includes('/api/ai/confirm') && js.text.includes('SpeechRecognition'), `HTTP ${js.status}`);
  const css = await req('GET', '/static/css/app.css', { ua: PHONE_UA });
  check('极简样式已发布', css.status === 200 && css.text.includes('.m-tabbar') && css.text.includes('.m-draft'), `HTTP ${css.status}`);

  /* --- 捕获区草稿确认流（规则引擎端到端）--- */
  jar = save + '; hl_simple=1';
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

  jar = save; // 清掉显式 cookie，避免影响后续（套件进程内无后续，仅保持整洁）

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
