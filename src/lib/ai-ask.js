'use strict';
/**
 * AI 对话查账（P2）：悬浮球的「答」
 *
 * 三段式管线：意图解析（模型或规则）→ SQL 出数（统计函数）→ 叙述（模型或模板）。
 * 设计约束（docs/ai-roadmap.md §2）：
 *  - 数字靠统计：模型只做意图理解与结果叙述，拿不到任何自己算数的机会
 *  - 无 Key 降级：规则模板覆盖常见问法，未配置模型也能答（同一条链，engine=rule）
 *  - 数据自持：出网内容仅限聚合值 + 分类/商户/成员名称清单，不发完整流水
 *  - 只读成员可问：查询不改数据，与账本角色无关（路由层控制记账分支才要求可写）
 */
const { all, get, todayStr } = require('../db');
const { monthStart, monthEnd, lastMonths, money, pad } = require('./util');
const ai = require('./ai');
const txn = require('./txn');
const scheduler = require('./scheduler');

/* ------------------------------ 查询信号预筛 ------------------------------ */

/** 疑问/统计信号词：命中才进入查询分支（不命中直接走记账管线，零额外开销）。
 *  注意不含裸「谁」——「给谁买的礼物 88」这类记账句常带人称疑问词；
 *  「谁花得最多」这类真统计问句由「最/排行」覆盖 */
const QUERY_HINT_RE =
  /(多少|几笔|几次|哪[个些里]|排名|排行|最[多大少高低快]|top\s?\d*|趋势|走势|环比|同比|对比|比较|还剩|剩多少|超没超|会超|超支|超了|预算|扣了没|扣没扣|扣了吗|到账没|查[一]?[下看询]|看[一]?[下看]|统计|汇总|分析|花在哪|花哪里|花哪|钱去哪|钱花哪)/i;

/** 强查询词：句子里出现这些才可能是正经查账，金额出现也不转移为记账 */
const STRONG_QUERY_RE = /(预算|趋势|走势|环比|同比|对比|比较|排行|排名|还剩|超支|超了|平均)/;

/** 记账句尾带金额（「打车多少钱来着 25」「午饭 35 元」）：除非伴随强查询词，一律优先记账。
 *  无 Key 降级路径的主要误伤面就是这类带金额的口语记账被当成查询吞掉。 */
const TRAILING_AMOUNT_RE = /\d+(?:\.\d{1,2})?\s*(元|块钱|块|圆|¥|￥)?\s*[。!！?？]?\s*$/;

function isExplicitRecord(text) {
  const s = String(text || '').trim();
  return TRAILING_AMOUNT_RE.test(s) && !STRONG_QUERY_RE.test(s);
}

function looksLikeQuery(text) {
  const s = String(text || '');
  return QUERY_HINT_RE.test(s) && !isExplicitRecord(s);
}

/* ------------------------------ 查询上下文（本地） ------------------------------ */

/**
 * 出数与解析都只依赖账本内的名称清单：
 * 分类完整路径（按 kind 分列）、成员名、高频商户——既供规则匹配，也拼进模型提示词。
 */
function buildQueryContext(ledgerId) {
  const cats = all(
    `SELECT c.id, c.name, c.kind, p.name AS parent FROM categories c
     LEFT JOIN categories p ON p.id = c.parent_id
     WHERE (c.ledger_id IS NULL OR c.ledger_id = ?) AND c.is_archived = 0`,
    ledgerId
  );
  const members = all(
    `SELECT DISTINCT u.display_name AS name FROM ledger_members m JOIN users u ON u.id = m.user_id
     WHERE m.ledger_id = ? AND u.status = 'active'`,
    ledgerId
  ).map((r) => r.name);
  const merchants = all(
    `SELECT merchant, COUNT(*) AS cnt FROM transactions
     WHERE ledger_id = ? AND deleted_at IS NULL AND merchant IS NOT NULL AND merchant != ''
     GROUP BY merchant ORDER BY cnt DESC LIMIT 60`,
    ledgerId
  ).map((r) => r.merchant);
  return {
    expensePaths: cats.filter((c) => c.kind === 'expense').map((c) => (c.parent ? `${c.parent}/${c.name}` : c.name)),
    incomePaths: cats.filter((c) => c.kind === 'income').map((c) => (c.parent ? `${c.parent}/${c.name}` : c.name)),
    members,
    merchants,
  };
}

/* ------------------------------- 月份工具 ------------------------------- */

/** 'YYYY-MM' 加减月（1/31 减一月等 end-of-month 场景由 Date 归一化兜底） */
function shiftMonth(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}
function quarterOfMonth(month) {
  return Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1;
}
function monthRangeOf(month) {
  return { start: monthStart(month), end: monthEnd(month), label: `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月` };
}
/** 季度所在的首月 'YYYY-MM' */
function quarterStartMonth(year, q) {
  return `${year}-${pad(3 * (q - 1) + 1)}`;
}
/** 同长度紧邻上一期（任意日期区间通用） */
function prevOf(start, end, label) {
  const s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  const len = Math.round((e - s) / 86400000) + 1;
  const f = (d) => d.toISOString().slice(0, 10);
  return { start: f(new Date(s.getTime() - len * 86400000)), end: f(new Date(e.getTime() - len * 86400000)), label: `${label}的上一期` };
}

/**
 * 解析时间范围 → {start, end, label, prev}
 * kind：month / year / days / months / between；缺省本月。
 * prev 供 compare 类型用：按自然月对齐的用月数学（避免按天数回退滑月），
 * 任意区间用等长回退；规则层的季度区间带 prevFrom/prevTo 精确上一季。
 */
function resolveRange(range, today = todayStr()) {
  const thisMonth = today.slice(0, 7);
  const r = range || {};
  if (r.kind === 'month' && /^\d{4}-\d{2}$/.test(String(r.month || ''))) {
    const mr = monthRangeOf(r.month);
    return { ...mr, prev: monthRangeOf(shiftMonth(r.month, -1)) };
  }
  if (r.kind === 'year' && /^\d{4}$/.test(String(r.year || ''))) {
    const y = String(r.year);
    return {
      start: `${y}-01-01`, end: `${y}-12-31`, label: `${y}年`,
      prev: { start: `${Number(y) - 1}-01-01`, end: `${Number(y) - 1}-12-31`, label: `${Number(y) - 1}年` },
    };
  }
  if (r.kind === 'days' && Number(r.days) > 0) {
    const n = Math.min(Math.round(Number(r.days)), 366);
    const s = new Date(`${today}T00:00:00`);
    s.setDate(s.getDate() - (n - 1));
    const start = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`;
    return { start, end: today, label: `最近 ${n} 天`, prev: prevOf(start, today, `最近 ${n} 天`) };
  }
  if (r.kind === 'months' && Number(r.months) > 0) {
    const n = Math.min(Math.round(Number(r.months)), 24);
    const startMonth = shiftMonth(thisMonth, -(n - 1));
    // 上一期与本期等长（本期含「至今」的零头天数）：月中问「近三个月比之前三个月」才不会
    // 拿 70 天比 92 天，系统性得出「少花」的结论
    const ps = new Date(`${monthStart(startMonth)}T00:00:00Z`);
    const pe = new Date(`${today}T00:00:00Z`);
    const diffDays = Math.round((pe - ps) / 86400000); // 本期含头含尾共 diffDays+1 天
    const prevStartMonth = shiftMonth(startMonth, -n);
    const prevEnd = new Date(new Date(`${monthStart(prevStartMonth)}T00:00:00Z`).getTime() + diffDays * 86400000);
    return {
      start: monthStart(startMonth), end: today, label: `近 ${n} 个月`,
      prev: { start: monthStart(prevStartMonth), end: prevEnd.toISOString().slice(0, 10), label: `之前 ${n} 个月` },
    };
  }
  if (r.kind === 'between' && /^\d{4}-\d{2}-\d{2}$/.test(String(r.from)) && /^\d{4}-\d{2}-\d{2}$/.test(String(r.to))) {
    const from = r.from <= r.to ? r.from : r.to;
    const to = r.from <= r.to ? r.to : r.from;
    const label = `${from} ~ ${to}`;
    const prev = /^\d{4}-\d{2}-\d{2}$/.test(String(r.prevFrom)) && /^\d{4}-\d{2}-\d{2}$/.test(String(r.prevTo))
      ? { start: r.prevFrom, end: r.prevTo, label: '上一期' }
      : prevOf(from, to, label);
    return { start: from, end: to, label, prev };
  }
  const mr = monthRangeOf(thisMonth);
  return { ...mr, prev: monthRangeOf(shiftMonth(thisMonth, -1)) };
}

/* ------------------------------- 规则解析 ------------------------------- */

const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function parseCnNumber(s) {
  if (/^\d+$/.test(s)) return Number(s);
  return CN_NUM[s] || null;
}

/** 在文本里找出现的分类（按该 kind 的路径段最长匹配），返回 {name: 命中的段} 或 null。
 *  返回「段」而不是整条路径：用户问「餐饮」应统计整个大分类（含子分类），
 *  runQuery 会再用 resolveCategoryId 把段解析回分类 id（父分类 id 的 SQL 自带子分类展开）。 */
function matchCategory(text, ctx, kind) {
  const paths = kind === 'income' ? ctx.incomePaths : ctx.expensePaths;
  const s = String(text || '');
  let best = null;
  for (const p of paths) {
    for (const seg of p.split('/')) {
      if (seg && s.includes(seg) && (!best || seg.length > best.seg.length)) best = { seg, path: p };
    }
  }
  return best ? { name: best.seg } : null;
}

/** 在文本里找账本里出现过的商户（最长匹配） */
function matchMerchant(text, ctx) {
  const s = String(text || '');
  let best = null;
  for (const m of ctx.merchants) {
    if (m && s.includes(m) && (!best || m.length > best.length)) best = m;
  }
  return best;
}

function matchMember(text, ctx) {
  const s = String(text || '');
  return ctx.members.find((m) => m && s.includes(m)) || null;
}

/** 从文本解析时间范围（规则版），未识别返回 undefined 交由缺省（本月） */
function parseRangeByRules(text, today) {
  const s = String(text || '');
  const thisMonth = today.slice(0, 7);
  const year = Number(thisMonth.slice(0, 4));
  let m;
  if ((m = s.match(/(?:近|最近)\s*(\d{1,2}|[一两二三四五六七八九十]+)\s*个?月/))) {
    const n = parseCnNumber(m[1]);
    if (n) return { kind: 'months', months: n };
  }
  if ((m = s.match(/(?:近|最近)\s*(\d{1,3})\s*天/))) return { kind: 'days', days: Number(m[1]) };
  if (/上上个月/.test(s)) return { kind: 'month', month: shiftMonth(thisMonth, -2) };
  // 「这个月」要先于「上个月」判：「这个月比上个月多花多少」主语是本月，
  // 文本里两个词都会出现，按先出现谁就归谁会错挂到上月
  if (/这(个)?月|本(个)?月/.test(s)) return { kind: 'month', month: thisMonth };
  if (/上(个)?月|上一月/.test(s)) return { kind: 'month', month: shiftMonth(thisMonth, -1) };
  // 显式年月要先于裸月份判：「2025年12月」若走 (\d{1,2})月 会丢掉年份、错算成今年 12 月
  if ((m = s.match(/((?:19|20)\d{2})\s*[-/.年]?\s*(\d{1,2})\s*月/))) {
    const y = Number(m[1]);
    const mm = Number(m[2]);
    if (mm >= 1 && mm <= 12) return { kind: 'month', month: `${y}-${pad(mm)}` };
  }
  if ((m = s.match(/(去年|今年)?(\d{1,2})月/))) {
    const y = m[1] === '去年' ? year - 1 : year;
    const mm = Number(m[2]);
    if (mm >= 1 && mm <= 12) return { kind: 'month', month: `${y}-${pad(mm)}` };
  }
  if (/这(个)?季度|本季度/.test(s)) {
    const startMonth = quarterStartMonth(year, quarterOfMonth(thisMonth));
    return {
      kind: 'between', from: monthStart(startMonth), to: monthEnd(shiftMonth(startMonth, 2)),
      prevFrom: monthStart(shiftMonth(startMonth, -3)), prevTo: monthEnd(shiftMonth(startMonth, -1)),
    };
  }
  if (/上(个)?季度/.test(s)) {
    const yq = quarterOfMonth(thisMonth) === 1
      ? { y: year - 1, q: 4 }
      : { y: year, q: quarterOfMonth(thisMonth) - 1 };
    const startMonth = quarterStartMonth(yq.y, yq.q);
    return {
      kind: 'between', from: monthStart(startMonth), to: monthEnd(shiftMonth(startMonth, 2)),
      prevFrom: monthStart(shiftMonth(startMonth, -3)), prevTo: monthEnd(shiftMonth(startMonth, -1)),
    };
  }
  if (/去年/.test(s)) return { kind: 'year', year: year - 1 };
  if (/今年|年度|全年/.test(s)) return { kind: 'year', year };
  if ((m = s.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})[日号]?/))) {
    // 带具体日期：以该日所在月处理（首版口径）
    return { kind: 'month', month: `${m[1]}-${pad(Number(m[2]))}` };
  }
  return undefined;
}

/**
 * 规则版意图解析：按 预算 → 趋势 → 对比 → 排行 → 商户 → 分类汇总 的优先级匹配。
 * 返回 null 表示「像查询但解析不出」→ 上层反问。
 */
function matchQueryByRules(text, ctx, today = todayStr()) {
  const s = String(text || '');
  const metric = /收入|赚|进账/.test(s) ? 'income' : 'expense';
  const range = parseRangeByRules(s, today);
  const confirmAsk = /扣了没|扣没扣|扣了吗|到账没/.test(s);

  // 1) 预算执行
  if (/预算/.test(s) && /还剩|剩多少|超|多少|执行|用了多少/.test(s)) {
    return { query: { type: 'budget', metric, range, category: matchCategory(s, ctx, 'expense') } };
  }
  // 2) 趋势（逐月序列）
  if (/趋势|走势/.test(s)) {
    const monthsM = s.match(/(?:近|最近)?\s*(\d{1,2}|[一两二三四五六七八九十]+)\s*个?月/);
    const n = monthsM ? parseCnNumber(monthsM[1]) : 6;
    return { query: { type: 'trend', metric, range, trend_months: n || 6, category: matchCategory(s, ctx, metric) } };
  }
  // 3) 对比（本期 vs 上一期）
  if (/多花|少花|多收|多了|少了|增|减|变化|对比|比较|环比|同比|比.{0,6}(月|季度|年)/.test(s)) {
    return { query: { type: 'compare', metric, range: range || { kind: 'month' }, compare_to: 'prev_period', category: matchCategory(s, ctx, metric) } };
  }
  // 4) 排行（Top N / 谁花最多 / 钱花哪了）
  if (/(排名|排行|最[多大少]|top\s?\d*|前\s*[一两二三四五六七八九十\d]+|花[在到]?哪|钱去哪|钱花哪|哪[个些].{0,4}(分类|类|地方))/.test(s)) {
    const topM = s.match(/(?:前|top\s*)\s*([一两二三四五六七八九十\d]+)/i);
    const topN = topM ? parseCnNumber(topM[1]) : 3;
    return {
      query: {
        type: 'top', metric, range, top_n: Math.min(Math.max(topN || 3, 1), 10),
        by: /谁|每个人|成员/.test(s) ? 'member' : 'category',
      },
    };
  }
  // 5) 商户/关键词流水（含「扣了没」确认型）
  const merchant = matchMerchant(s, ctx);
  if (merchant && /(多少|几笔|几回|花|付|扣|一共|合计)/.test(s)) {
    return { query: { type: 'merchant', metric, range: range || (confirmAsk ? { kind: 'month' } : { kind: 'days', days: 90 }), merchant, confirm: confirmAsk } };
  }
  // 6) 分类汇总 / 总计
  if (/(多少|几笔|几回|一共|合计|总计)/.test(s)) {
    return { query: { type: 'category_summary', metric, range: range || { kind: 'month' }, category: matchCategory(s, ctx, metric) } };
  }
  return null;
}

/* ----------------------------- 模型意图解析 ----------------------------- */

const ASK_SYSTEM_PROMPT = `你是家庭记账助手的意图解析器。判断用户这句话是「记账」（记录一笔收支）还是「查账」（询问账目统计）。
只输出一个 JSON 对象，不要解释，不要使用 Markdown 代码块。
intent：record=记账，query=查账，other=都不是（闲聊/无关）。
confidence：0~1，你对判断的把握。
intent 为 query 时给出 query 结构：
  type：category_summary(分类或总计汇总) | compare(两段时间对比) | trend(逐月趋势) | top(排行) | budget(预算执行) | merchant(按商户或关键词查流水)
  metric：expense(支出) | income(收入)，缺省 expense
  range：{"kind":"month","month":"YYYY-MM"} 或 {"kind":"year","year":2026} 或 {"kind":"days","days":30} 或 {"kind":"months","months":3} 或 {"kind":"between","from":"YYYY-MM-DD","to":"YYYY-MM-DD"}；用户没说时间就用本月
  compare_to：compare 类型固定为 "prev_period"
  category：分类名，必须原样取自给定的分类路径列表，拿不准就留空
  merchant：商户名，优先取自给定的常见商户列表
  member：成员名，必须取自给定的成员列表
  top_n：数字，默认 3
  trend_months：trend 类型的月数，默认 6
输出示例：
{"intent":"query","confidence":0.9,"query":{"type":"category_summary","metric":"expense","range":{"kind":"month","month":"2026-10"},"category":"餐饮"}}`;

function buildAskUserPrompt(text, ctx, today) {
  return [
    `今天是 ${today}。`,
    `支出分类路径：${ctx.expensePaths.join('、')}`,
    `收入分类路径：${ctx.incomePaths.join('、')}`,
    `成员：${ctx.members.join('、') || '（无）'}`,
    `常见商户（按出现频率）：${ctx.merchants.slice(0, 30).join('、') || '（无）'}`,
    `用户这句话：${text}`,
  ].join('\n');
}

async function parseQueryByModel(text, ctx, today, cfg) {
  const out = await ai.callModel(
    [
      { role: 'system', content: ASK_SYSTEM_PROMPT },
      { role: 'user', content: buildAskUserPrompt(text, ctx, today) },
    ],
    cfg
  );
  return ai.extractJson(out);
}

/** 模型意图 → 安全的内部 query 结构（类型白名单、越界钳制、分类名回查真实 id） */
function normalizeModelQuery(raw, ctx, ledgerId, today = todayStr()) {
  if (!raw || typeof raw !== 'object') return null;
  const TYPES = ['category_summary', 'compare', 'trend', 'top', 'budget', 'merchant'];
  if (!TYPES.includes(raw.type)) return null;
  const metric = raw.metric === 'income' ? 'income' : 'expense';
  const kind = ['month', 'year', 'days', 'months', 'between'].includes(raw.range?.kind) ? raw.range.kind : 'month';
  const range = kind === 'month' ? { kind, month: String(raw.range.month || today.slice(0, 7)) }
    : kind === 'year' ? { kind, year: Number(raw.range.year) || Number(today.slice(0, 4)) }
    : kind === 'days' ? { kind, days: Math.min(Math.max(Math.round(Number(raw.range.days)) || 30, 1), 366) }
    : kind === 'months' ? { kind, months: Math.min(Math.max(Math.round(Number(raw.range.months)) || 3, 1), 24) }
    : { kind, from: String(raw.range.from || ''), to: String(raw.range.to || '') };
  const q = {
    type: raw.type,
    metric,
    range,
    compare_to: raw.compare_to || 'prev_period',
    top_n: Math.min(Math.max(Math.round(Number(raw.top_n)) || 3, 1), 10),
    trend_months: Math.min(Math.max(Math.round(Number(raw.trend_months)) || 6, 2), 24),
  };
  if (raw.category) {
    const catId = ai.resolveCategoryId(ledgerId, raw.category, metric === 'income' ? 'income' : 'expense');
    if (catId) {
      const row = get(
        'SELECT c.name, p.name AS parent FROM categories c LEFT JOIN categories p ON p.id = c.parent_id WHERE c.id = ?',
        catId
      );
      q.category = { name: row ? (row.parent ? `${row.parent}/${row.name}` : row.name) : String(raw.category) };
    }
  }
  if (raw.merchant) q.merchant = String(raw.merchant).trim().slice(0, 60);
  if (raw.member && ctx.members.includes(raw.member)) q.member = raw.member;
  if (q.type === 'top' && raw.by === 'member') q.by = 'member';
  return q;
}

/* --------------------------------- 出数 --------------------------------- */

const typesOf = (metric) => (metric === 'income' ? txn.INCOME_TYPES : txn.EXPENSE_TYPES);

function sumByType(ledgerId, { start, end }, metric, categoryId = null) {
  const cond = categoryId ? ' AND (t.category_id = ? OR t.category_id IN (SELECT id FROM categories WHERE parent_id = ?))' : '';
  const row = get(
    `SELECT COALESCE(SUM(t.amount_base_cents),0) AS total, COUNT(*) AS cnt
     FROM transactions t WHERE t.ledger_id = ? AND t.deleted_at IS NULL AND t.txn_date BETWEEN ? AND ?
       AND t.type IN (${typesOf(metric).map(() => '?').join(',')})${cond}`,
    ledgerId, start, end, ...typesOf(metric), ...(categoryId ? [categoryId, categoryId] : [])
  );
  return { total: Number(row?.total || 0), count: Number(row?.cnt || 0) };
}

function runQuery(ledgerId, q, range, today = todayStr()) {
  const metric = q.metric === 'income' ? 'income' : 'expense';
  switch (q.type) {
    case 'category_summary': {
      const catId = q.category ? ai.resolveCategoryId(ledgerId, q.category.name, metric === 'income' ? 'income' : 'expense') : null;
      const part = sumByType(ledgerId, range, metric, catId);
      const whole = sumByType(ledgerId, range, metric, null);
      let topMerchant = null;
      if (catId && part.count) {
        topMerchant = get(
          `SELECT COALESCE(t.merchant, t.note, '未记商户') AS name, SUM(t.amount_base_cents) AS s, COUNT(*) AS c
           FROM transactions t WHERE t.ledger_id = ? AND t.deleted_at IS NULL AND t.txn_date BETWEEN ? AND ?
             AND t.type IN (${typesOf(metric).map(() => '?').join(',')})
             AND (t.category_id = ? OR t.category_id IN (SELECT id FROM categories WHERE parent_id = ?))
           GROUP BY COALESCE(t.merchant, t.note) ORDER BY s DESC LIMIT 1`,
          ledgerId, range.start, range.end, ...typesOf(metric), catId, catId
        );
      }
      return {
        type: 'category_summary', metric, label: range.label, category: q.category ? q.category.name : null,
        total: part.total, count: part.count,
        whole_total: whole.total, share: whole.total ? part.total / whole.total : 0,
        top_merchant: topMerchant ? { name: topMerchant.name, total: Number(topMerchant.s), count: Number(topMerchant.c) } : null,
      };
    }
    case 'compare': {
      const catId = q.category ? ai.resolveCategoryId(ledgerId, q.category.name, metric === 'income' ? 'income' : 'expense') : null;
      const cur = sumByType(ledgerId, range, metric, catId);
      const prev = sumByType(ledgerId, range.prev, metric, catId);
      return {
        type: 'compare', metric, label: range.label, prev_label: range.prev.label, category: q.category ? q.category.name : null,
        cur_total: cur.total, cur_count: cur.count, prev_total: prev.total, prev_count: prev.count,
        delta: cur.total - prev.total,
        pct: prev.total ? (cur.total - prev.total) / prev.total : null,
      };
    }
    case 'trend': {
      const n = Math.min(Math.max(Math.round(Number(q.trend_months)) || 6, 2), 24);
      const months = lastMonths(n, new Date(`${today}T00:00:00`));
      const catId = q.category ? ai.resolveCategoryId(ledgerId, q.category.name, metric === 'income' ? 'income' : 'expense') : null;
      const cond = catId ? ' AND (t.category_id = ? OR t.category_id IN (SELECT id FROM categories WHERE parent_id = ?))' : '';
      const rows = all(
        `SELECT strftime('%Y-%m', t.txn_date) AS m, SUM(t.amount_base_cents) AS s, COUNT(*) AS c
         FROM transactions t WHERE t.ledger_id = ? AND t.deleted_at IS NULL
           AND t.type IN (${typesOf(metric).map(() => '?').join(',')}) AND t.txn_date >= ? AND t.txn_date <= ?${cond}
         GROUP BY m ORDER BY m`,
        ledgerId, ...typesOf(metric), monthStart(months[0]), monthEnd(months[months.length - 1]), ...(catId ? [catId, catId] : [])
      );
      const map = new Map(rows.map((r) => [r.m, r]));
      return {
        type: 'trend', metric, category: q.category ? q.category.name : null, label: `近 ${n} 个月`,
        series: months.map((mo) => {
          const r = map.get(mo);
          return { month: mo, label: `${Number(mo.slice(5, 7))}月`, total: Number(r?.s || 0), count: Number(r?.c || 0) };
        }),
      };
    }
    case 'top': {
      if (q.by === 'member') {
        // 不复用 txn.memberBreakdown：它的 COUNT(*) 不滤类型（转账/借贷也计数），
        // 会让「某 N 笔」虚高且与分类榜口径不一致；这里金额与笔数同口径过滤
        const rows = all(
          `SELECT u.display_name AS name, SUM(t.amount_base_cents) AS total, COUNT(*) AS cnt
           FROM transactions t JOIN users u ON u.id = t.user_id
           WHERE t.ledger_id = ? AND t.deleted_at IS NULL AND t.txn_date BETWEEN ? AND ?
             AND t.type IN (${typesOf(metric).map(() => '?').join(',')})
           GROUP BY u.id ORDER BY total DESC LIMIT ?`,
          ledgerId, range.start, range.end, ...typesOf(metric), Math.min(q.top_n || 3, 10)
        ).map((rw) => ({ name: rw.name, total: Number(rw.total), count: Number(rw.cnt) }));
        return { type: 'top', by: 'member', metric, label: range.label, top_n: q.top_n || 3, rows };
      }
      const rows = txn.categoryBreakdown(ledgerId, range.start, range.end, metric === 'income' ? 'income' : 'expense')
        .slice(0, q.top_n || 3)
        .map((r) => ({ name: r.name, total: r.total, count: r.cnt }));
      return { type: 'top', by: 'category', metric, label: range.label, top_n: q.top_n || 3, rows };
    }
    case 'budget': {
      const budgets = all(
        `SELECT * FROM budgets WHERE ledger_id = ? AND is_active = 1
           AND (period = 'monthly' OR (period = 'custom'
                AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?)))`,
        ledgerId, today, today
      );
      const catId = q.category ? ai.resolveCategoryId(ledgerId, q.category.name, 'expense') : null;
      const rows = [];
      for (const b of budgets) {
        if (b.scope === 'category' && catId && Number(b.category_id) !== catId) continue;
        if (b.scope === 'account') continue; // 账户预算与查账口径无关，首版不展示
        let name = '总预算';
        if (b.scope === 'category' && b.category_id) {
          const c = get('SELECT c.name, p.name AS parent FROM categories c LEFT JOIN categories p ON p.id = c.parent_id WHERE c.id = ?', b.category_id);
          name = c ? (c.parent ? `${c.parent}/${c.name}` : c.name) : '分类预算';
        }
        const used = scheduler.budgetUsedInRange(b, range.start, range.end);
        rows.push({
          name,
          amount: Number(b.amount_cents),
          used,
          remaining: Number(b.amount_cents) - used,
          pct: Number(b.amount_cents) ? used / Number(b.amount_cents) : 0,
        });
      }
      return { type: 'budget', metric, label: range.label, rows };
    }
    case 'merchant': {
      const keyword = String(q.merchant || '').slice(0, 60);
      const r = txn.listTransactions(ledgerId, { keyword, from: range.start, to: range.end, pageSize: 200, sort: 'date_desc' });
      return {
        type: 'merchant', metric, keyword, label: range.label, confirm: !!q.confirm,
        total: metric === 'income' ? r.sum.income : r.sum.expense,
        count: r.total,
        latest: r.rows[0] ? { date: r.rows[0].txn_date, amount: Number(r.rows[0].amount_base_cents), note: String(r.rows[0].note || r.rows[0].merchant || '').slice(0, 50) } : null,
      };
    }
    default:
      throw new Error(`未知查询类型：${q.type}`);
  }
}

/* --------------------------------- 叙述 --------------------------------- */

const NARRATE_SYSTEM_PROMPT = `你是家庭记账助手。根据给定的统计结果回答用户的问题。
要求：
1. 用 1~3 句话直接给结论，自然口语，不啰嗦。
2. 只能使用统计结果里出现的数字和名称，禁止自己计算、估算或补充任何新数字。
3. 金额字段是「分」，32450 表示 ¥324.50；输出统一写成 ¥xxx.xx，不要更换精度或自己换算错的数值。
4. 回答必须带上统计结果中的全部关键金额，省略任何关键数字都是不合格回答：对比类必须同时给出本期、上一期与增减额（上一期为 0 时要明确说「上个月没有支出/记录」）；汇总类给金额与笔数；预算类给预算、已用与剩余；趋势类逐月金额；排行类每个名次的金额；商户类给笔数与合计（有最近一笔也要给）。
5. 直接输出回答文字，不要 JSON，不要 Markdown。`;

async function narrateByModel(question, data, cfg) {
  const out = await ai.callModel(
    [
      { role: 'system', content: NARRATE_SYSTEM_PROMPT },
      { role: 'user', content: `用户问题：${question}\n统计结果（JSON）：${JSON.stringify(data)}` },
    ],
    cfg
  );
  const t = String(out || '').trim();
  if (!t) throw new Error('模型叙述为空');
  return t.slice(0, 500);
}

/* --------------------------- 叙述数字核验（防漏基数） --------------------------- */

/** 该类统计回答必须出现的金额（分）；0 不要求（「上月无记录」这类可以没有数字） */
function keyAmountsOf(data) {
  const out = [];
  switch (data.type) {
    case 'category_summary': out.push(data.total); break;
    case 'compare': out.push(data.cur_total, data.prev_total, Math.abs(data.delta)); break;
    case 'trend': for (const r of data.series) out.push(r.total); break;
    case 'top': for (const r of data.rows) out.push(r.total); break;
    case 'budget': for (const r of data.rows) out.push(r.amount, r.used, Math.abs(r.remaining)); break;
    case 'merchant': if (data.count) out.push(data.total); break;
  }
  return out.filter((c) => Number.isFinite(c) && c !== 0);
}

/** 归一化后提取数字：模型可能写 ¥3,460.50 / ¥3460.5 / 454元 / 约¥3461，逗号、货币符不作数 */
const normNum = (s) => String(s).replace(/[,\s¥￥元]/g, '');

/** 从叙述里提取全部数字（转为分）。按数值比对而非字符串匹配：
 *  「¥454」= 454.00、「454.0」= 454.00——字符串匹配会把整元/少位小数的合格回答误杀
 *  （真实 Key 下频繁误触发回退的根因）；解析天然带边界，「1454」不会糊弄 454。
 *  带「万」后缀按倍乘解析（「1.5万」= 1500 元） */
function numbersIn(text) {
  const out = new Set();
  for (const m of normNum(text).matchAll(/(\d+(?:\.\d+)?)(万)?/g)) {
    const cents = Math.round(parseFloat(m[1]) * (m[2] ? 10000 : 1) * 100);
    if (Number.isFinite(cents)) out.add(cents);
  }
  return out;
}

/** 带货币锚点的金额（¥xxx / xxx元/块，可带万）：只有这些是「声称的金额」，
 *  月份（10月）、笔数（8笔）不算——空数据场景用它防模型凭空编数。
 *  已知漏网形态（防线定位是抓主要形态、非完备封闭）：中文数字（一百元）、全角数字、
 *  RMB 后缀、3万5千 混合写法——均提取不到，空数据时会放行（叙述仅展示不落库，风险可忽略） */
function currencyAmountsIn(text) {
  const s = String(text || '');
  const out = [];
  const val = (str, wan) => Math.round(parseFloat(str.replace(/,/g, '')) * (wan ? 10000 : 1) * 100);
  for (const m of s.matchAll(/[¥￥]\s*([\d,]+(?:\.\d+)?)\s*(万)?/g)) out.push(val(m[1], m[2]));
  for (const m of s.matchAll(/([\d,]+(?:\.\d+)?)\s*(万)?\s*(?:元|块)/g)) out.push(val(m[1], m[2]));
  return out.filter(Number.isFinite);
}

/** 模型叙述是否覆盖全部关键金额；不覆盖就退回模板（确定性优先，与防臆造账户同一模式）。
 *  允许 ±1 元的取整差（模型爱写「约 ¥3461」）：核验的职责是抓「漏说」，不是逼模型抄格式 */
const ROUND_TOLERANCE_CENTS = 100;

function narrationCovers(data, text) {
  const keys = keyAmountsOf(data);
  if (!keys.length) {
    // 空数据（无预算/无记录/全零）：没有关键金额可查，但叙述里不允许出现非零的「声称金额」
    // ——真实 Key 实测模型会在无预算时编「还剩 ¥10000.00」；模板自己的 ¥0.00 放行
    return currencyAmountsIn(text).every((c) => Math.abs(c) <= ROUND_TOLERANCE_CENTS);
  }
  const nums = [...numbersIn(text)];
  if (!keys.every((k) => nums.some((n) => Math.abs(n - k) <= ROUND_TOLERANCE_CENTS))) return false;
  // 对比类上期为 0：金额豁免可以，但基数必须口头交代（「上个月没有支出」/「上月 ¥0.00」），
  // 否则「多花了¥454」式的无参照回答会溜过（真实 Key 验证抓到的案例）。
  // 在原文上匹配并防数字内 0 误中（「454.00 元」的 0 不算交代了基数）；「无」必须带宾语，
  // 裸「无从查证」类插入语和事实错误的「与上月相比无变化」都不放行；全角 ￥ 与「0 元」带空格同样认
  if (data.type === 'compare' && data.prev_total === 0 && data.cur_total !== 0) {
    return /(没有|无(?:记录|支出|花费|消费|开销|数据|流水)|未记录|为零|[¥￥]\s*0|(?<![\d.])0\s*元)/.test(String(text));
  }
  return true;
}

function pctText(x) {
  return x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(1)}%`;
}

/** 模板叙述：无 Key / 模型失败时的确定性兜底 */
function narrateTemplate(data) {
  const sgn = data.metric === 'income' ? '收入' : '支出';
  switch (data.type) {
    case 'category_summary': {
      const what = data.category || `全部${sgn}`;
      let t = `${data.label}${what}${sgn} ${money(data.total)}，共 ${data.count} 笔`;
      if (data.category && data.whole_total) t += `，占${sgn}的 ${pctText(data.share)}`;
      if (data.top_merchant) t += `；最大头是「${data.top_merchant.name}」${money(data.top_merchant.total)}（${data.top_merchant.count} 笔）`;
      return t + '。';
    }
    case 'compare': {
      const what = data.category ? `${data.category}${sgn}` : sgn;
      const word = data.delta >= 0 ? '多' : '少';
      let t = `${data.label}${what} ${money(data.cur_total)}（${data.cur_count} 笔），${data.prev_label}是 ${money(data.prev_total)}，${word} ${money(Math.abs(data.delta))}`;
      if (data.pct != null) t += `（${data.delta >= 0 ? '+' : '-'}${pctText(Math.abs(data.pct))}）`;
      return t + '。';
    }
    case 'trend': {
      const what = data.category ? `${data.category}${sgn}` : sgn;
      const parts = data.series.map((r) => `${r.label} ${money(r.total)}`);
      return `${data.label}${what}：${parts.join('、')}。`;
    }
    case 'top': {
      if (!data.rows.length) return `${data.label}还没有${sgn}记录。`;
      const rows = data.rows.map((r, i) => `${i + 1}. ${r.name} ${money(r.total)}（${r.count} 笔）`);
      return `${data.label}${sgn}排行：${rows.join('；')}。`;
    }
    case 'budget': {
      if (!data.rows.length) return `${data.label}还没有生效中的预算，可到「预算」页创建。`;
      return data.rows.map((r) => {
        const base = `${r.name}：预算 ${money(r.amount)}，已用 ${money(r.used)}（${pctText(r.pct)}）`;
        return r.remaining >= 0 ? `${base}，还剩 ${money(r.remaining)}` : `${base}，⚠ 已超支 ${money(-r.remaining)}`;
      }).join('；') + '。';
    }
    case 'merchant': {
      if (!data.count) return `${data.label}没有查到「${data.keyword}」的相关记录。`;
      if (data.confirm) return `已扣：${data.label}「${data.keyword}」共 ${data.count} 笔、合计 ${money(data.total)}${data.latest ? `，最近一笔 ${data.latest.date} ${money(data.latest.amount)}` : ''}。`;
      return `${data.label}「${data.keyword}」共 ${data.count} 笔、合计 ${money(data.total)}${data.latest ? `；最近一笔 ${data.latest.date} ${money(data.latest.amount)}` : ''}。`;
    }
    default:
      return '这个统计我还不会念，试试换个问法。';
  }
}

/* ------------------------------- 管线入口 ------------------------------- */

const CLARIFY_TEXT =
  '这句话我拿不准是想记账还是想查账。记一笔试试「午饭 35 元」；查账试试「这个月餐饮花了多少」「餐饮预算还剩多少」「这个月比上个月多花多少」。';

/**
 * 悬浮球文本查询管线。
 * 返回 null = 不是查询（调用方继续走记账管线）；否则返回 {mode, engine, text, data, warnings}。
 *  - mode 'answer'：已出数并叙述
 *  - mode 'clarify'：像查询但解析不出，反问引导
 */
async function handleAssistantText({ text, ledgerId, today = todayStr() }) {
  const q = String(text || '').trim();
  if (!q || !looksLikeQuery(q)) return null;

  const cfg = ai.getAiConfig();
  const ctx = buildQueryContext(ledgerId);
  let parsed = matchQueryByRules(q, ctx, today);
  let usedModel = false;

  if (ai.isAiUsable()) {
    try {
      const mp = await parseQueryByModel(q, ctx, today, cfg);
      if (mp && mp.intent === 'record') return null; // 模型确认是记账 → 交回记账管线
      // 低置信的 query 判定不采纳（confidence 缺省视为可信），沿用规则解析结果
      const confOk = mp && (mp.confidence === undefined || Number(mp.confidence) >= 0.5);
      if (mp && confOk && mp.intent === 'query' && mp.query) {
        const nq = normalizeModelQuery(mp.query, ctx, ledgerId, today);
        if (nq) {
          parsed = { query: nq };
          usedModel = true;
        }
      }
    } catch {
      // 模型解析失败 → 沿用规则结果
    }
  }

  if (!parsed) {
    const hint = ai.isAiUsable() ? '' : '（配置 AI 模型后可回答更灵活的问法）';
    return { mode: 'clarify', engine: 'rule', text: CLARIFY_TEXT + hint, data: null, warnings: [] };
  }
  if (/扣了没|扣没扣|扣了吗|到账没/.test(q)) parsed.query.confirm = true;

  const range = resolveRange(parsed.query.range, today);
  const data = runQuery(ledgerId, parsed.query, range, today);
  let answer = narrateTemplate(data);
  const warnings = [];
  if (ai.isAiUsable()) {
    try {
      const modelText = await narrateByModel(q, data, cfg);
      // 叙述数字核验：模型漏掉关键金额（如对比句丢上月基数）就退回模板，确定性优先
      if (narrationCovers(data, modelText)) answer = modelText;
      else warnings.push('AI 叙述未覆盖全部关键数字，已用标准格式回答');
    } catch {
      // 叙述失败 → 保留模板文案
    }
  }
  return { mode: 'answer', engine: usedModel ? 'llm' : 'rule', text: answer, data, warnings };
}

module.exports = {
  looksLikeQuery, isExplicitRecord, buildQueryContext, matchQueryByRules, parseRangeByRules,
  resolveRange, normalizeModelQuery, runQuery, narrateTemplate, narrationCovers, keyAmountsOf,
  handleAssistantText, QUERY_HINT_RE, CLARIFY_TEXT,
};
