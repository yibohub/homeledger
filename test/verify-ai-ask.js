'use strict';
/**
 * 回归：AI 对话查账（P2，/api/ai/chat 查询分支 + lib/ai-ask）
 *
 * 分两段：
 *   A. 进程内逻辑（独立库 data-verify-ask）：查询信号预筛、规则意图解析、时间范围解析
 *      （含 compare 用的「上一期」按自然月对齐）、模型意图归一化钳制、trend 出数、模板叙述
 *   B. HTTP 端到端（8099 隔离实例，run-all 自动拉起；无 AI Key → 规则引擎全链路）：
 *      记一笔/查账隐式分流、五类问法出数、查询不落库、反问引导、只读成员可问但不可记
 *
 * 运行：node test/verify-ai-ask.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ASK_DATA_DIR = path.join(__dirname, '..', 'data-verify-ask');
// 8099 实例的数据目录：run-all 会把服务端 DATA_DIR 传进环境，必须在下面覆盖前捕获
// （只读成员矩阵要直连「服务端」的库改角色；手工跑时先 export DATA_DIR=<8099 实例目录>）
const SERVER_DATA_DIR = process.env.DATA_DIR && process.env.DATA_DIR !== ASK_DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data-verify');
process.env.DATA_DIR = ASK_DATA_DIR;
fs.rmSync(ASK_DATA_DIR, { recursive: true, force: true });

const db = require('../src/db');
const auth = require('../src/lib/auth');
const txn = require('../src/lib/txn');
const ai = require('../src/lib/ai');
const aiAsk = require('../src/lib/ai-ask');

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}

db.init();
const today = db.todayStr();
const thisMonth = today.slice(0, 7);
const lastMonthYYYYMM = (() => {
  const [y, m] = thisMonth.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
})();
const monthEndOf = (month) => {
  const [y, m] = month.split('-').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-${new Date(Date.UTC(y, m, 0)).getUTCDate()}`;
};

/* ============================ A. 进程内逻辑 ============================ */

console.log('\n=== A1. 查询信号预筛（像问句才进查询分支）===\n');

for (const t of ['这个月餐饮花了多少', '房贷扣了没', '这个月比上个月多花多少', '钱都花哪了', '餐饮预算还剩多少', '查一下上个月的美团', '谁花得最多']) {
  check(`查询句命中信号：${t}`, aiAsk.looksLikeQuery(t));
}
for (const t of ['午饭 35 元', '昨天打车 26.5', '转账给张三 500', '房贷 3200 元']) {
  check(`记账句不误判：${t}`, !aiAsk.looksLikeQuery(t));
}
// 审查修复回归：带金额的口语记账句不被查询分支吞掉（无 Key 降级路径的主要误伤面）
for (const t of ['给谁买的礼物 88', '昨天请谁吃饭来着 120', '打车多少钱来着 25']) {
  check(`句尾带金额优先记账：${t}`, !aiAsk.looksLikeQuery(t));
}
check('强查询词例外：预算句即使带金额也走查账', aiAsk.looksLikeQuery('餐饮预算还剩多少来着'));
check('isExplicitRecord：句尾数字（无单位）也算记账', aiAsk.isExplicitRecord('打车 25') && !aiAsk.isExplicitRecord('这个月花了多少'));

console.log('\n=== A2. 规则意图解析（五类问法 + 优先级）===\n');

const CTX = {
  expensePaths: ['餐饮/午餐', '餐饮/饮料', '交通/打车', '居住/房贷', '服饰/上衣'],
  incomePaths: ['职业收入/工资'],
  members: ['张三', '李四'],
  merchants: ['美团', '房贷', '星巴克'],
};
const ruleOf = (t) => aiAsk.matchQueryByRules(t, CTX, today);

let r = ruleOf('这个月餐饮花了多少');
check('分类汇总：类型/口径/分类', r && r.query.type === 'category_summary' && r.query.metric === 'expense' && r.query.category?.name === '餐饮', JSON.stringify(r?.query?.category));
r = ruleOf('上个月收入多少');
check('分类汇总：收入口径', r && r.query.metric === 'income' && r.query.range?.month === lastMonthYYYYMM, JSON.stringify(r?.query?.range));
r = ruleOf('这个月比上个月多花多少');
check('对比：compare + 上一期', r && r.query.type === 'compare' && r.query.compare_to === 'prev_period' && r.query.range?.month === thisMonth);
r = ruleOf('近三个月餐饮趋势');
check('趋势：近三月 + 分类', r && r.query.type === 'trend' && r.query.trend_months === 3 && r.query.category?.name === '餐饮');
r = ruleOf('这个月支出最多的前两类是哪些');
check('排行：前 N', r && r.query.type === 'top' && r.query.top_n === 2 && r.query.by === 'category');
r = ruleOf('这个月谁花得最多');
check('排行：按成员', r && r.query.type === 'top' && r.query.by === 'member');
r = ruleOf('这个月餐饮预算还剩多少');
check('预算：分类预算', r && r.query.type === 'budget' && r.query.category?.name === '餐饮');
r = ruleOf('这个月在美团花了多少');
check('商户流水：金额问法', r && r.query.type === 'merchant' && r.query.merchant === '美团');
r = ruleOf('房贷扣了没');
check('商户流水：扣款确认型', r && r.query.type === 'merchant' && r.query.merchant === '房贷' && r.query.confirm === true);
r = ruleOf('帮我分析一下');
check('像问句但解析不出 → null（上层反问）', r === null);
r = ruleOf('这个月花了多少');
check('无分类无商户 → 总计汇总', r && r.query.type === 'category_summary' && r.query.category === null);

/* 相对日期单日问法（维护者实测：问「前天」模型曾曲解成最近 2 天，问的那天反而不在窗口内） */
for (const [t, off, label] of [['前天花了多少钱', -2, '前天'], ['大前天花了多少', -3, '大前天'], ['昨天支出多少', -1, '昨天'], ['今日收入多少', 0, '今天'], ['3天前花了多少', -3, '3天前'], ['三天前花了多少', -3, '3天前']]) {
  const rr = aiAsk.parseRangeByRules(t, today);
  check(`相对日期解析：${t} → 单日`, rr && rr.kind === 'between' && rr.from === shiftDate(today, off) && rr.to === rr.from && rr.day_label === label, JSON.stringify(rr));
}
r = ruleOf('前天花了多少钱');
check('前天问法 → 总计汇总且范围即前天单日', r && r.query.type === 'category_summary' && r.query.range?.kind === 'between' && r.query.range.from === shiftDate(today, -2), JSON.stringify(r?.query?.range));
/* P2 审查回归：时间词按句中位置仲裁，相对日不抢更早的时间词、比较句主语取「比」前 */
let rr2 = aiAsk.parseRangeByRules('这个月到今天花了多少', today);
check('「这个月到今天」仍答本月（相对日不抢更早时间词，不回归成单日）', rr2 && rr2.kind === 'month' && rr2.month === thisMonth, JSON.stringify(rr2));
rr2 = aiAsk.parseRangeByRules('上个月到今天花了多少', today);
check('「上个月到今天」仍答上月', rr2 && rr2.kind === 'month' && rr2.month === lastMonthYYYYMM, JSON.stringify(rr2));
rr2 = aiAsk.parseRangeByRules('今天比昨天多花多少', today);
check('「今天比昨天」主语取今天（compare 句取「比」前时间词）', rr2 && rr2.kind === 'between' && rr2.from === today && rr2.day_label === '今天', JSON.stringify(rr2));
rr2 = aiAsk.parseRangeByRules('前天比大前天多花多少', today);
check('「前天比大前天」主语取前天', rr2 && rr2.day_label === '前天', JSON.stringify(rr2));
check('「1234天前」位数超限不吞位解析（宁缺毋错交缺省）', aiAsk.parseRangeByRules('1234天前花了多少', today) === undefined);

console.log('\n=== A3. 时间范围与「上一期」（compare 的数字正确性靠它）===\n');

let rg = aiAsk.resolveRange({ kind: 'month', month: thisMonth }, today);
const prevMonth = monthOfShift(thisMonth, -1);
check('本月范围 = 1 日至月末', rg.start === `${thisMonth}-01` && rg.end === monthEndOf(thisMonth), `${rg.start} ~ ${rg.end}`);
check('本月的上一期 = 上个自然月（对齐自然月，不按天数回退滑月）', rg.prev.start === `${prevMonth}-01` && rg.prev.end === monthEndOf(prevMonth), `${rg.prev.start} ~ ${rg.prev.end}`);
rg = aiAsk.resolveRange({ kind: 'months', months: 3 }, today);
const expectStart = monthOfShift(thisMonth, -2) + '-01';
check('近三个月起点 = 前推 2 个月的 1 日', rg.start === expectStart, `${rg.start} ~ ${rg.end}`);
check('近三月的上一期 = 再往前 3 个自然月', rg.prev.start === monthOfShift(thisMonth, -5) + '-01', `${rg.prev.start} ~ ${rg.prev.end}`);
rg = aiAsk.resolveRange({ kind: 'days', days: 7 }, today);
check('最近 7 天：起点=今天-6', rg.start === shiftDate(today, -6) && rg.end === today, `${rg.start} ~ ${rg.end}`);
rg = aiAsk.resolveRange(aiAsk.parseRangeByRules('前天花了多少', today), today);
const d2 = shiftDate(today, -2);
// 跨年稳健：前天落在上一年时 label 带年份前缀（1月1/2日跑也不假红）
const d2Label = `${d2.slice(0, 4) === today.slice(0, 4) ? '' : d2.slice(0, 4) + '年'}${Number(d2.slice(5, 7))}月${Number(d2.slice(8, 10))}日（前天）`;
check('单日范围 label 人话化（「10月8日（前天）」式，跨年补年份）', rg.start === d2 && rg.end === d2
  && rg.label === d2Label, rg.label);
check('单日的上一期 = 前一天（等长回退，compare 可直接用）', rg.prev.start === shiftDate(today, -3) && rg.prev.end === rg.prev.start, `${rg.prev.start} ~ ${rg.prev.end}`);

/* 审查修复回归：显式年月不再丢年份、近 N 月上一期与本期等长 */
const ym = aiAsk.parseRangeByRules('2025年12月花了多少', today);
check('「2025年12月」解析为 2025-12（不丢年份）', ym && ym.month === '2025-12', JSON.stringify(ym));
const ym2 = aiAsk.parseRangeByRules('去年12月花了多少', today);
check('「去年12月」解析为去年', ym2 && ym2.month === `${Number(thisMonth.slice(0, 4)) - 1}-12`, JSON.stringify(ym2));
rg = aiAsk.resolveRange({ kind: 'months', months: 3 }, today);
const curLen = (new Date(`${rg.end}T00:00:00Z`) - new Date(`${rg.start}T00:00:00Z`)) / 86400000;
const prevLen = (new Date(`${rg.prev.end}T00:00:00Z`) - new Date(`${rg.prev.start}T00:00:00Z`)) / 86400000;
check('近三月的上一期与本期等长（不拿 70 天比 92 天）', curLen === prevLen, `本期 ${curLen + 1} 天 vs 上期 ${prevLen + 1} 天`);

console.log('\n=== A4. 模型意图归一化（白名单 + 钳制 + 分类回查）===\n');

const uid = Number(db.run(
  'INSERT INTO users (username, password_hash, display_name, avatar_color, is_admin, created_at) VALUES (?,?,?,?,1,?)',
  'askadmin', auth.hashPassword('ask-pass-123'), '查账回归', '#4f7cff', db.nowStr()
).lastInsertRowid);
const ledgerId = Number(db.createDefaultLedger(uid, '查账回归'));

let nq = aiAsk.normalizeModelQuery(
  { type: 'nonsense', metric: 'x', range: { kind: 'moon' } }, CTX, ledgerId, today);
check('未知类型拒绝', nq === null);
nq = aiAsk.normalizeModelQuery(
  { type: 'top', metric: 'expense', range: { kind: 'days', days: 9999 }, top_n: 99, category: '餐饮/午餐', by: 'member' },
  CTX, ledgerId, today);
check('类型保留 + days 钳到 366 + top_n 钳到 10', nq && nq.type === 'top' && nq.range.days === 366 && nq.top_n === 10, JSON.stringify(nq && nq.range));
check('模型分类名回查为真实路径', nq.category?.name === '餐饮/午餐', JSON.stringify(nq.category));
nq = aiAsk.normalizeModelQuery({ type: 'merchant', range: { kind: 'month' }, member: '不存在的人' }, CTX, ledgerId, today);
check('不在成员列表的 member 被丢弃', nq && !nq.member);

console.log('\n=== A4b. 规则显式参数优先合并（模型只补缺）===\n');

let mg = aiAsk.mergeRuleParams(
  { type: 'category_summary', range: { kind: 'between', from: '2026-10-08', to: '2026-10-08', day_label: '前天' } },
  { type: 'category_summary', metric: 'expense', range: { kind: 'days', days: 2 } });
check('规则显式 range 优先（「前天」不被模型 days:2 覆盖）', mg.range.kind === 'between' && mg.range.day_label === '前天', JSON.stringify(mg.range));
mg = aiAsk.mergeRuleParams({ type: 'trend', trend_months: 3 }, { type: 'trend', trend_months: 6 });
check('显式 trend_months=3 不被模型缺省 6 覆盖（近三月趋势曾答六个月）', mg.trend_months === 3, JSON.stringify(mg));
mg = aiAsk.mergeRuleParams({ type: 'top', top_n: 5 }, { type: 'top' });
check('显式 top_n=5 不被模型缺省覆盖', mg.top_n === 5);
mg = aiAsk.mergeRuleParams({ type: 'trend' }, { type: 'trend', trend_months: 12 });
check('规则没解析出 → 模型值保留', mg.trend_months === 12);
mg = aiAsk.mergeRuleParams(
  { type: 'merchant', range: { kind: 'days', days: 90 }, range_from_default: true },
  { type: 'merchant', range: { kind: 'month', month: '2026-10' } });
check('规则缺省窗口不算显式 → 模型 range 保留', mg.range.kind === 'month', JSON.stringify(mg.range));
r = ruleOf('支出趋势');
check('趋势无显式月数不再预填缺省（runQuery 兜底 6）', r && r.query.type === 'trend' && r.query.trend_months === undefined, JSON.stringify(r?.query));
r = ruleOf('钱都花哪了');
check('排行无显式 N 不再预填缺省 top_n', r && r.query.type === 'top' && r.query.top_n === undefined);
r = ruleOf('多花了多少');
check('对比无时间词不再预填缺省 range', r && r.query.type === 'compare' && r.query.range === undefined);

console.log('\n=== A5. trend 出数 + 模板叙述（进程内真实库）===\n');

const accId = Number(db.get('SELECT id FROM accounts WHERE ledger_id = ? ORDER BY id LIMIT 1', ledgerId).id);
const lunchCatId = ai.resolveCategoryId(ledgerId, '餐饮/午餐', 'expense');
for (const [off, cents] of [[0, 3500], [-1, 5000], [-2, 4500]]) {
  const [y, m] = thisMonth.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + off, 12));
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-12`;
  txn.createTransaction(ledgerId, uid, { type: 'expense', amount_cents: cents, account_id: accId, category_id: lunchCatId, txn_date: date, merchant: '面馆' });
}
const trendQ = { type: 'trend', metric: 'expense', trend_months: 3 };
const trendData = aiAsk.runQuery(ledgerId, trendQ, aiAsk.resolveRange({ kind: 'months', months: 3 }, today), today);
check('trend 序列 3 个月且金额正确', trendData.series.length === 3 && trendData.series[2].total === 3500 && trendData.series[1].total === 5000,
  JSON.stringify(trendData.series.map((s) => [s.month, s.total])));
const trendText = aiAsk.narrateTemplate(trendData);
check('趋势模板含逐月金额（本月 35.00）', trendText.includes('月') && trendText.includes('35.00'), trendText);

const cmpQ = { type: 'compare', metric: 'expense' };
const cmpData = aiAsk.runQuery(ledgerId, cmpQ, aiAsk.resolveRange({ kind: 'month', month: thisMonth }, today), today);
check('compare：本月 35 元 vs 上月 50 元，delta -1500 分', cmpData.cur_total === 3500 && cmpData.prev_total === 5000 && cmpData.delta === -1500,
  JSON.stringify({ cur: cmpData.cur_total, prev: cmpData.prev_total }));
check('对比模板含「少」与两期金额', aiAsk.narrateTemplate(cmpData).includes('少') && aiAsk.narrateTemplate(cmpData).includes('50.00'), aiAsk.narrateTemplate(cmpData));

/* 审查修复回归：成员榜笔数与金额同口径（转账/借贷不计入「N 笔」） */
const otherAcc = Number(db.get('SELECT id FROM accounts WHERE ledger_id = ? AND id != ? ORDER BY id LIMIT 1', ledgerId, accId).id);
txn.createTransaction(ledgerId, uid, { type: 'transfer', amount_cents: 10000, account_id: accId, to_account_id: otherAcc, txn_date: `${thisMonth}-13` });
const memberTop = aiAsk.runQuery(ledgerId, { type: 'top', metric: 'expense', by: 'member', top_n: 3 }, aiAsk.resolveRange({ kind: 'month', month: thisMonth }, today), today);
check('成员榜：金额 35 元且笔数只计收支（转账不算）', memberTop.rows.length === 1 && memberTop.rows[0].total === 3500 && memberTop.rows[0].count === 1,
  JSON.stringify(memberTop.rows));
const trendDefault = aiAsk.runQuery(ledgerId, { type: 'trend', metric: 'expense' }, aiAsk.resolveRange({ kind: 'months', months: 6 }, today), today);
check('trend 缺省 6 个月（显式参数下放 runQuery 兜底后行为不变）', trendDefault.series.length === 6, `months=${trendDefault.series.length}`);

/* 模板叠词回归：无分类时「全部支出」不再拼成「全部支出支出」（维护者实测答复原文） */
const sumTpl = aiAsk.narrateTemplate({ type: 'category_summary', metric: 'expense', label: '最近 2 天', category: null, total: 505620, count: 8, whole_total: 505620, share: 1, top_merchant: null });
check('汇总模板无分类不叠词（「全部支出 ¥5,056.20」）', sumTpl.includes('全部支出 ¥5,056.20') && !sumTpl.includes('支出支出'), sumTpl);
const sumTpl2 = aiAsk.narrateTemplate({ type: 'category_summary', metric: 'expense', label: '2026年10月', category: '餐饮', total: 3500, count: 1, whole_total: 346050, share: 0.01, top_merchant: null });
check('汇总模板有分类文案不变（「餐饮支出 ¥35.00」）', sumTpl2.startsWith('2026年10月餐饮支出 ¥35.00'), sumTpl2);

console.log('\n=== A6. 叙述数字核验（模型漏关键金额 → 退回模板）===\n');

// cmpData：cur 3500 / prev 5000 / delta -1500（分）
check('完整对比叙述（含两期与增减）通过核验', aiAsk.narrationCovers(cmpData, '本月支出 ¥35.00，上月 ¥50.00，少 ¥15.00。') === true);
check('只说结论丢上期基数 → 不通过（触发模板回退）', aiAsk.narrationCovers(cmpData, '这个月比上个月少花了 ¥15.00。') === false);
check('漏增减额 → 不通过', aiAsk.narrationCovers(cmpData, '本月 ¥35.00，上月 ¥50.00。') === false);
check('千分位/单位差异不影响核验（¥3,460.50 = ¥3460.50 = 3460.50元）',
  aiAsk.narrationCovers({ type: 'category_summary', total: 346050 }, '共花了 ¥3,460.50。') === true
  && aiAsk.narrationCovers({ type: 'category_summary', total: 346050 }, '共花了 3460.50元。') === true);
check('金额为 0 不作硬性要求（「上月无记录」可无数字）',
  aiAsk.narrationCovers({ type: 'compare', cur_total: 45400, prev_total: 0, delta: 45400 }, '这个月花了 ¥454.00，上个月没有记录。') === true);
check('对比类上期为 0 仍须口头交代基数（真实 Key 验证抓到的漏网案例）',
  aiAsk.narrationCovers({ type: 'compare', cur_total: 45400, prev_total: 0, delta: 45400 }, '这个月比上个月多花了¥454.00元。') === false
  && aiAsk.narrationCovers({ type: 'compare', cur_total: 45400, prev_total: 0, delta: 45400 }, '本月 ¥454.00，上月 ¥0.00，多 ¥454.00。') === true);
check('零交代正则：裸「无」插入语不放行、全角￥与带空格 0 元认',
  aiAsk.narrationCovers({ type: 'compare', cur_total: 45400, prev_total: 0, delta: 45400 }, '本月 ¥454.00，与上月相比无变化。') === false
  && aiAsk.narrationCovers({ type: 'compare', cur_total: 45400, prev_total: 0, delta: 45400 }, '本月 ¥454.00，上月￥0.00，多了 ¥454.00。') === true
  && aiAsk.narrationCovers({ type: 'compare', cur_total: 45400, prev_total: 0, delta: 45400 }, '本月 ¥454.00，上月为 0 元，多了 ¥454.00。') === true
  && aiAsk.narrationCovers({ type: 'compare', cur_total: 45400, prev_total: 0, delta: 45400 }, '买了 30 元的东西，多花了¥454.00。') === false);
check('trend 序列逐月金额都要出现',
  aiAsk.narrationCovers(trendData, '8月 ¥45.00、9月 ¥50.00、10月 ¥35.00。') === true
  && aiAsk.narrationCovers(trendData, '8月 ¥45.00、9月 ¥50.00。') === false);
check('budget 三项都要（预算/已用/剩余）',
  aiAsk.narrationCovers({ type: 'budget', rows: [{ amount: 10000, used: 3500, remaining: 6500 }] }, '预算 ¥100.00，已用 ¥35.00，还剩 ¥65.00') === true
  && aiAsk.narrationCovers({ type: 'budget', rows: [{ amount: 10000, used: 3500, remaining: 6500 }] }, '已用 ¥35.00，还剩 ¥65.00') === false
  && aiAsk.narrationCovers({ type: 'budget', rows: [{ amount: 10000, used: 3500, remaining: 6500 }] }, '预算 ¥100.00，还剩 ¥65.00') === false);
check('数字边界匹配：「35.00」不被「¥135.00」糊弄',
  aiAsk.narrationCovers({ type: 'category_summary', total: 3500 }, '花了 ¥135.00。') === false
  && aiAsk.narrationCovers({ type: 'category_summary', total: 3500 }, '花了 ¥35.00。') === true);
check('数值语义匹配（格式无关）：整元/少位小数/千分位/约数/万元缩写都算覆盖',
  aiAsk.narrationCovers({ type: 'category_summary', total: 45400 }, '这个月花了 ¥454。') === true
  && aiAsk.narrationCovers({ type: 'category_summary', total: 45400 }, '这个月花了 454.0 元。') === true
  && aiAsk.narrationCovers({ type: 'category_summary', total: 346050 }, '花了 ¥3,460.5。') === true
  && aiAsk.narrationCovers({ type: 'category_summary', total: 346050 }, '大约花了 ¥3,461。') === true
  && aiAsk.narrationCovers({ type: 'category_summary', total: 1500000 }, '花了 1.5万。') === true);
check('数值语义匹配：漏说关键数字仍被拒（核验的本职）',
  aiAsk.narrationCovers({ type: 'compare', cur_total: 45400, prev_total: 5000, delta: 40400 }, '这个月比上个月多花了不少。') === false
  && aiAsk.narrationCovers({ type: 'compare', cur_total: 45400, prev_total: 5000, delta: 40400 }, '本月 ¥454，上月 ¥50。') === false);
check('空数据防编数（真实 Key 实测：无预算时模型编「还剩 ¥10000.00」）',
  aiAsk.narrationCovers({ type: 'budget', rows: [] }, '餐饮预算还剩 ¥10000.00。') === false
  && aiAsk.narrationCovers({ type: 'budget', rows: [] }, '还没有生效中的预算，可以到「预算」页创建。') === true
  && aiAsk.narrationCovers({ type: 'category_summary', total: 0, count: 0 }, '本月还没有支出记录。') === true
  && aiAsk.narrationCovers({ type: 'category_summary', total: 0, count: 0 }, '本月支出 ¥0.00，共 0 笔。') === true
  && aiAsk.narrationCovers({ type: 'budget', rows: [] }, '本月（10月）还没有预算，上月也没有。') === true);

/* 不变式防线：模板自身必须天然通过核验——否则未来改 narrateTemplate/money 格式时，
   有 Key 用户会静默退化成永远退回模板（无 Key 测试环境不会红，只有这条断言能拦住） */
const TPL_CASES = [
  cmpData,
  trendData,
  memberTop,
  { type: 'budget', metric: 'expense', label: 'x', rows: [] },
  { type: 'category_summary', metric: 'expense', label: 'x', category: null, total: 0, count: 0, whole_total: 0, share: 0, top_merchant: null },
  { type: 'trend', metric: 'expense', category: null, label: 'x', series: [{ month: '2026-08', label: '8月', total: 0, count: 0 }, { month: '2026-09', label: '9月', total: 0, count: 0 }] },
  { type: 'top', by: 'category', metric: 'expense', label: 'x', top_n: 3, rows: [] },
  { type: 'merchant', metric: 'expense', keyword: '美团', label: 'x', confirm: false, total: 0, count: 0, latest: null },
  { type: 'category_summary', metric: 'expense', label: 'x', category: null, total: 346050, count: 4, whole_total: 346050, share: 1, top_merchant: { name: '美团', total: 123456, count: 2 } },
  { type: 'budget', metric: 'expense', label: 'x', rows: [{ name: '餐饮', amount: 10000, used: 3500, remaining: 6500, pct: 0.35 }, { name: '总预算', amount: 50000, used: 30000, remaining: 20000, pct: 0.6 }] },
  { type: 'budget', metric: 'expense', label: 'x', rows: [{ name: '超支的', amount: 5000, used: 8000, remaining: -3000, pct: 1.6 }] },
  { type: 'merchant', metric: 'expense', keyword: '美团', label: 'x', confirm: false, total: 123456, count: 5, latest: { date: '2026-10-01', amount: 4560, note: 'n' } },
  { type: 'compare', metric: 'expense', label: 'x', prev_label: 'y', category: null, cur_total: 45400, cur_count: 4, prev_total: 0, prev_count: 0, delta: 45400, pct: null },
  { type: 'top', by: 'category', metric: 'expense', label: 'x', top_n: 3, rows: [{ name: '居住', total: 320000, count: 1 }] },
];
let tplBad = 0;
for (const d of TPL_CASES) {
  if (aiAsk.narrationCovers(d, aiAsk.narrateTemplate(d)) !== true) tplBad++;
}
check(`模板叙述天然通过自身核验（${TPL_CASES.length} 场景，含零值/超支/千分位大额）`, tplBad === 0, `不过场景数=${tplBad}`);

console.log('\n--- 进程内段完成，进入 HTTP 段 ---\n');
if (fail) { console.log(`\n结果：${pass} 通过 / ${fail} 失败（进程内段未全过，跳过 HTTP 段）\n`); process.exit(1); }

/* 辅助：月份平移（A 段断言用） */
function monthOfShift(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function shiftDate(date, n) {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ============================ B. HTTP 端到端 ============================ */

const BASE = 'http://127.0.0.1:8099';
const { DatabaseSync } = require('node:sqlite');
let cookie = '';
let csrf = '';
async function req(method, p, { form, json, headers = {}, noCookie = false } = {}) {
  const h = { ...headers };
  if (cookie && !noCookie) h.cookie = cookie;
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
  // 未登录探测的响应会带回匿名会话的 Set-Cookie，绝不能覆盖已登录的 cookie
  if (sc.length && !noCookie) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}
const noComma = (s) => String(s).replace(/,/g, '');

(async () => {
  console.log('\n=== B. 记账/查账隐式分流 + 五类问法（HTTP 端到端 8099，规则引擎）===\n');
  let up = true;
  try { await fetch(BASE + '/login'); } catch { up = false; }
  if (!up) {
    console.log('  SKIP  8099 未启动，跳过 HTTP 段（8099 实例的库与进程内段 data-verify-ask 互不相干）。手工验证：PORT=8099 HOST=127.0.0.1 DATA_DIR=<repo>/data-verify node server.js');
    console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
    process.exit(fail ? 1 : 0);
  }

  let r = await req('GET', '/login');
  r = await req('POST', '/login', { form: { _csrf: (r.text.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1], username: 'admin', password: 'admin888' } });
  check('管理员登录', r.status === 302, `HTTP ${r.status}`);
  r = await req('GET', '/');
  csrf = (r.text.match(/name="csrf" content="([^"]+)"/) || [])[1] || '';
  check('已取得页面 CSRF 令牌', !!csrf);

  /* --- 未登录拒绝 --- */
  r = await req('POST', '/api/ai/chat', { json: { text: '这个月花了多少' }, noCookie: true });
  check('未登录查询被拒', r.status !== 200, `HTTP ${r.status}`);

  /* --- 造数：走记账分支（规则引擎）--- */
  const seeds = ['午饭 35 元', '打车 26.5 元', '买衣服 199 元', '房贷 3200 元', `${lastMonthYYYYMM}-15 午饭 50 元`];
  for (const s of seeds) {
    r = await req('POST', '/api/ai/chat', { json: { text: s } });
    check(`造数入账：${s}`, r.status === 200 && r.json.mode === 'record' && r.json.created === 1,
      `HTTP ${r.status} created=${r.json && r.json.created}`);
  }

  /* --- 查询分支：分类汇总 --- */
  r = await req('POST', '/api/ai/chat', { json: { text: '这个月餐饮花了多少' } });
  check('分类汇总：mode=answer 且规则引擎', r.status === 200 && r.json.mode === 'answer' && r.json.engine === 'rule', `HTTP ${r.status} engine=${r.json.engine}`);
  check('分类汇总金额正确（奶茶不属餐饮，35.00）', noComma(r.json.text).includes('35.00'), r.json.text);
  check('查询分支不落库（无 created/ids 字段）', r.json.created === undefined && r.json.ids === undefined);
  check('附带统计 JSON（前端可扩展）', r.json.data && r.json.data.type === 'category_summary');

  /* --- 查询分支：商户流水 --- */
  r = await req('POST', '/api/ai/chat', { json: { text: '这个月买衣服花了多少' } });
  check('商户流水金额（199.00）', r.json.mode === 'answer' && noComma(r.json.text).includes('199.00'), r.json.text);

  /* --- 查询分支：扣款确认 --- */
  r = await req('POST', '/api/ai/chat', { json: { text: '房贷扣了没' } });
  check('「扣了没」给确认式回答且金额正确', r.json.mode === 'answer' && r.json.text.includes('已扣') && noComma(r.json.text).includes('3200.00'), r.json.text);

  /* --- 查询分支：排行 --- */
  r = await req('POST', '/api/ai/chat', { json: { text: '这个月支出最多的分类是哪个' } });
  check('Top 榜第一名是居住（房贷 3200）', r.json.mode === 'answer' && r.json.text.includes('居住'), r.json.text);

  /* --- 查询分支：对比 --- */
  r = await req('POST', '/api/ai/chat', { json: { text: '这个月比上个月多花多少' } });
  check('对比：本月合计与上月基数都出现', r.json.mode === 'answer' && noComma(r.json.text).includes('3460.50') && noComma(r.json.text).includes('50.00'), r.json.text);

  /* --- 查询分支：相对日期（前天；打车类目不碰后续餐饮口径断言）--- */
  r = await req('POST', '/api/ai/chat', { json: { text: `${shiftDate(today, -2)} 打车 33 元` } });
  check('造数入账：前天一笔 33 元', r.status === 200 && r.json.mode === 'record' && r.json.created === 1, `HTTP ${r.status} mode=${r.json && r.json.mode}`);
  r = await req('POST', '/api/ai/chat', { json: { text: '前天花了多少钱' } });
  check('问「前天」答前天单日（人话 label，非最近2天/本月）', r.json.mode === 'answer' && r.json.data
    && r.json.data.label.includes('（前天）') && noComma(r.json.text).includes('33.00') && !r.json.text.includes('最近'), r.json.text);

  /* --- 查询分支：预算 --- */
  r = await req('GET', '/budgets');
  const catOpts = [...r.text.matchAll(/<option value="(\d+)"[^>]*>([^<]*?)（整个大分类）/g)].map((m) => ({ id: m[1], name: m[2].trim() }));
  const dining = catOpts.find((o) => o.name.includes('餐饮'));
  check('预算页可解析到「餐饮」大分类', !!dining, JSON.stringify(catOpts).slice(0, 120));
  r = await req('POST', '/budgets', {
    form: { _csrf: csrf, name: '餐饮预算E2E', amount: '100', scope: 'category', category_id: dining.id, period: 'monthly', alert_pct: '80', trigger_type: 'expense' },
  });
  check('创建餐饮分类预算（100 元）', r.status === 302, `HTTP ${r.status}`);
  r = await req('POST', '/api/ai/chat', { json: { text: '这个月餐饮预算还剩多少' } });
  check('预算回答：已用 35 还剩 65', r.json.mode === 'answer' && noComma(r.json.text).includes('65.00') && noComma(r.json.text).includes('35.00'), r.json.text);

  /* --- 查询分支：钱花哪了 → 排行兜底 --- */
  r = await req('POST', '/api/ai/chat', { json: { text: '钱都花哪了' } });
  check('「钱都花哪了」走排行', r.json.mode === 'answer' && r.json.data.type === 'top', r.json.text);

  /* --- 反问引导 --- */
  r = await req('POST', '/api/ai/chat', { json: { text: '帮我分析一下' } });
  check('像问句但解析不出 → clarify 引导', r.json.mode === 'clarify' && r.json.text.includes('记账'), r.json.text);

  /* --- 闲聊与记账不受影响 --- */
  r = await req('POST', '/api/ai/chat', { json: { text: '你好' } });
  check('闲聊走记账分支（友好返回，不反问）', r.status === 200 && r.json.mode === 'record' && (r.json.items || []).length === 0, `mode=${r.json.mode}`);
  r = await req('POST', '/api/ai/chat', { json: { text: '晚饭 42 元' } });
  check('记账仍自动入库', r.json.mode === 'record' && r.json.created === 1, `created=${r.json.created}`);

  /* --- 只读成员：可问不可记（直连 8099 实例的库改角色，run-all 会传 DATA_DIR）--- */
  const dbFile = path.join(SERVER_DATA_DIR, 'homeledger.db');
  if (fs.existsSync(dbFile)) {
    const raw = new DatabaseSync(dbFile);
    raw.exec('PRAGMA busy_timeout = 5000;');
    const adminId = raw.prepare('SELECT id FROM users WHERE username = ?').get('admin');
    raw.prepare("UPDATE ledger_members SET role = 'viewer' WHERE user_id = ?").run(adminId.id);
    r = await req('POST', '/api/ai/chat', { json: { text: '这个月餐饮花了多少' } });
    check('只读成员可查账', r.status === 200 && r.json.mode === 'answer', `HTTP ${r.status}`);
    r = await req('POST', '/api/ai/chat', { json: { text: '可乐 6 元' } });
    check('只读成员记账被 403 拒绝', r.status === 403 && /只读/.test(r.json.error || ''), `HTTP ${r.status}`);
    raw.prepare("UPDATE ledger_members SET role = 'owner' WHERE user_id = ?").run(adminId.id);
    raw.close();
    r = await req('POST', '/api/ai/chat', { json: { text: '可乐 6 元' } });
    check('恢复角色后记账正常', r.status === 200 && r.json.mode === 'record' && r.json.created === 1);

    /* 审查修复回归：归档账本只读——记账 403（查询仍可） */
    const raw2 = new DatabaseSync(dbFile);
    raw2.exec('PRAGMA busy_timeout = 5000;');
    raw2.prepare('UPDATE ledgers SET is_archived = 1').run();
    r = await req('POST', '/api/ai/chat', { json: { text: '薯片 9.9 元' } });
    check('归档账本记账被 403 拒绝', r.status === 403 && /归档/.test(r.json.error || ''), `HTTP ${r.status} ${r.json && r.json.error}`);
    r = await req('POST', '/api/ai/chat', { json: { text: '这个月餐饮花了多少' } });
    check('归档账本查账不受影响（只读）', r.status === 200 && r.json.mode === 'answer', `HTTP ${r.status}`);
    raw2.prepare('UPDATE ledgers SET is_archived = 0').run();
    raw2.close();
  } else {
    check('（跳过只读成员矩阵：8099 实例库不可达）', true);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
