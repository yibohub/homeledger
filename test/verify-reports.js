'use strict';
/**
 * 回归：报表分析 /reports（重点：分类排行榜点一级分类可下钻）
 *
 * 需先在 8099 起隔离实例：
 *   PORT=8099 HOST=127.0.0.1 DATA_DIR=<repo>/data-verify node server.js
 * 覆盖：
 *   - 一级视图：排行榜一级分类名渲染为 <a class="rank-name"> 下钻链接（2026-10 修复点：
 *     此前提示「点分类名可下钻」但 rank-name 一直是纯 span，点击无响应）
 *   - 二级分类行保持纯文本（parent/name 形式），下钻视图内不再出现链接
 *   - 未分类账目显示「未分类」而非「未分类/null」
 *   - 下钻页（top=一级分类）：出该一级的二级明细 + 返回一级入口
 *   - top=不存在的分类出空态不崩；收入视角正常
 *   - chip 快捷下钻行（一级前 8）回归
 *   - XSS：自定义一级分类名带 HTML 时，链接文本转义、href 仅百分号编码
 *
 * 运行：node test/verify-reports.js（或经 test/run-all.js，会注入 DATA_DIR）
 */
const BASE = 'http://127.0.0.1:8099';

if (!process.env.DATA_DIR) {
  console.error('必须设置 DATA_DIR 指向隔离实例的数据目录（本套件要直接读写同实例的 SQLite 做种子与断言）');
  process.exit(1);
}
const db = require('../src/db');
const txnLib = require('../src/lib/txn');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}

let jar = '';
let csrf = '';
async function req(method, p, { form, headers = {}, cookie } = {}) {
  const h = { ...headers };
  h.cookie = cookie || jar;
  if (form) h['content-type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(BASE + p, {
    method, headers: h,
    body: form ? new URLSearchParams(form).toString() : undefined,
    redirect: 'manual',
  });
  const sc = res.headers.getSetCookie?.() || [];
  if (sc.length && !cookie) jar = sc.map((c) => c.split(';')[0]).join('; ');
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: buf.toString('utf8'), setCookie: sc };
}

const csrfOf = (html) => (html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];
const enc = encodeURIComponent;

(async () => {
  console.log('\n=== 报表分析·分类排行榜下钻（HTTP 端到端）===\n');

  /* --- 未登录拒绝 --- */
  let r = await req('GET', '/reports');
  check('未登录访问报表被拒', r.status !== 200, `HTTP ${r.status}`);

  /* --- 登录 --- */
  r = await req('GET', '/login');
  const loginRes = await req('POST', '/login', { form: { _csrf: csrfOf(r.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', loginRes.status === 302, `HTTP ${loginRes.status}`);
  const cookie = loginRes.setCookie.map((c) => c.split(';')[0]).join('; ');
  r = await req('GET', '/');
  csrf = (r.text.match(/name="csrf" content="([^"]+)"/) || [])[1] || '';

  /* --- 种子：本月固定账目 --- */
  const ledgerId = 1;
  const user = db.get('SELECT id FROM users WHERE username = ?', 'admin');
  const acc = db.get('SELECT id FROM accounts WHERE ledger_id = ? AND name = ?', ledgerId, '微信钱包');
  const catId = (name, kind = 'expense') =>
    db.get('SELECT id FROM categories WHERE ledger_id IS NULL AND name = ? AND kind = ?', name, kind)?.id;
  const lunch = catId('午餐');       // 餐饮 的二级
  const dining = catId('餐饮');      // 一级
  const traffic = catId('交通');     // 一级
  const taxi = catId('打车');        // 交通 的二级
  const salary = catId('工资', 'income'); // 职业收入 的二级
  const career = catId('职业收入', 'income'); // 一级
  check('种子前置：默认账户与分类已就绪', !!acc && !!lunch && !!dining && !!traffic && !!taxi && !!salary && !!career);

  // 自定义一级分类，名字带 HTML（XSS 断言素材）
  const xssName = '怪<em>分</em>类';
  db.run('INSERT INTO categories (ledger_id, name, kind, parent_id, icon, color, is_system, sort_order) VALUES (NULL,?,\'expense\',NULL,?,\'#123456\',0,99)', xssName, '🧪');
  const xssCat = db.get('SELECT id FROM categories WHERE name = ?', xssName)?.id;

  const today = db.todayStr();
  const seed = [
    // [类型, 金额分, 分类, 备注]
    ['expense', 3500, lunch, '榜一样本：二级 午餐'],
    ['expense', 2000, dining, '一级 餐饮 直接挂账'],
    ['expense', 1200, traffic, '一级 交通 直接挂账'],
    ['expense', 1500, taxi, '二级 打车'],
    ['expense', 999, null, '未分类账目'],
    ['expense', 777, xssCat, 'XSS 分类样本'],
    ['income', 500000, salary, '收入视角样本'],
    ['income', 80000, career, '一级 职业收入 直接挂账'],
  ];
  for (const [type, cents, category_id, note] of seed) {
    txnLib.createTransaction(ledgerId, user.id, {
      type, amount_cents: cents, account_id: acc.id, category_id,
      txn_date: today, merchant: '', note, source: 'manual',
    });
  }

  const EXPENSE_Q = 'preset=month&month=&kind=expense';
  const YM = today.slice(0, 7); // 页内链接的 month 参数经 parseRange 归一化为当前月

  /* --- 一级视图：排行榜一级分类可点下钻（本次修复点） --- */
  r = await req('GET', `/reports?${EXPENSE_Q}`, { cookie });
  check('报表页 200', r.status === 200, `HTTP ${r.status}`);
  check('一级「餐饮」渲染为下钻链接（属性内 & 转义为 &amp;）', r.text.includes(
    `<a class="rank-name" href="/reports?preset=month&amp;month=${YM}&amp;kind=expense&amp;top=${enc('餐饮')}" title="餐饮">餐饮</a>`
  ), '');
  check('一级「交通」同样可点', r.text.includes(
    `<a class="rank-name" href="/reports?preset=month&amp;month=${YM}&amp;kind=expense&amp;top=${enc('交通')}" title="交通">交通</a>`
  ), '');
  check('二级行保持纯文本（餐饮/午餐）', r.text.includes('>餐饮/午餐</span>'), '');
  check('二级行不再渲染链接', !r.text.includes(`href="/reports?${EXPENSE_Q}&top=${enc('午餐')}"`)
    && !r.text.includes(`&amp;top=${enc('午餐')}"`), '');
  check('一级行不再错挂「未分类/」前缀', !r.text.includes('未分类/餐饮') && !r.text.includes('未分类/交通'), '');
  check('XSS 分类名渲染为全转义的下钻链接', r.text.includes(
    `<a class="rank-name" href="/reports?preset=month&amp;month=${YM}&amp;kind=expense&amp;top=${enc(xssName)}" title="怪&lt;em&gt;分&lt;/em&gt;类">怪&lt;em&gt;分&lt;/em&gt;类</a>`
  ), '');
  check('XSS 分类 href 无裸 HTML 字符', !r.text.includes('top=怪<em') && !r.text.includes('>怪<em'), '');
  check('未分类账目显示「未分类」', r.text.includes('>未分类</span>'), '');
  check('不再出现「未分类/null」', !r.text.includes('未分类/null'), '');
  check('chip 快捷行仍带 top= 链接', r.text.includes(`class="chip" href="/reports?preset=month&month=${YM}&kind=expense&top=${enc('餐饮')}"`), '');

  /* --- 下钻视图 --- */
  r = await req('GET', `/reports?${EXPENSE_Q}&top=${enc('餐饮')}`, { cookie });
  check('下钻页 200 且标注下钻目标', r.status === 200 && r.text.includes('下钻：餐饮'), `HTTP ${r.status}`);
  check('下钻页出二级明细（餐饮/午餐）', r.text.includes('餐饮/午餐'), '');
  check('下钻页有「返回一级」入口', r.text.includes('返回一级'), '');
  check('下钻视图内排行榜无链接（已是末级）', !r.text.includes('class="rank-name" href='), '');

  /* --- 边界 --- */
  r = await req('GET', `/reports?${EXPENSE_Q}&top=${enc('不存在分类XYZ')}`, { cookie });
  check('top=未知分类出空态不崩', r.status === 200 && r.text.includes('没有数据'), `HTTP ${r.status}`);

  r = await req('GET', '/reports?preset=month&month=&kind=income', { cookie });
  check('收入视角 200 且出「职业收入/工资」', r.status === 200 && r.text.includes('职业收入/工资'), `HTTP ${r.status}`);
  check('收入视角一级「职业收入」可点', r.text.includes(`kind=income&amp;top=${enc('职业收入')}"`), '');

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
