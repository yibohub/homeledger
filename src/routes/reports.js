'use strict';
/** 报表与图表 */
const express = require('express');
const { all, get, todayStr, getSetting, setSetting, nowStr } = require('../db');
const auth = require('../lib/auth');
const txn = require('../lib/txn');
const fd = require('../lib/formdata');
const u = require('../lib/util');
const annual = require('../lib/annual');
const ai = require('../lib/ai');

const router = express.Router();

function parseRange(q, ledgerId = 0) {
  const today = todayStr();
  const curMonth = today.slice(0, 7);
  const preset = q.preset || 'month';
  if (preset === 'year') {
    const y = /^\d{4}$/.test(String(q.year || '')) ? q.year : today.slice(0, 4);
    return { start: `${y}-01-01`, end: `${y}-12-31`, label: `${y}年`, preset, key: y };
  }
  if (preset === 'custom' && q.from && q.to) {
    return { start: q.from, end: q.to, label: `${q.from} ~ ${q.to}`, preset, key: `${q.from}_${q.to}` };
  }
  if (preset === 'quarter') {
    const m = Number(curMonth.slice(5, 7));
    const qn = Math.floor((m - 1) / 3);
    const startM = qn * 3 + 1;
    const y = curMonth.slice(0, 4);
    return {
      start: `${y}-${u.pad(startM)}-01`,
      end: `${y}-${u.pad(startM + 2)}-31`,
      label: `${y}年 第${qn + 1} 季度`, preset, key: `${y}Q${qn + 1}`,
    };
  }
  if (preset === 'all') {
    // 始终用当前会话账本，query 里的 ledger_id 不参与（避免跨账本探测）
    const first = get('SELECT MIN(txn_date) AS d FROM transactions WHERE ledger_id = ?', Number(ledgerId) || 0);
    return { start: first?.d || `${curMonth}-01`, end: today, label: '全部时间', preset, key: 'all' };
  }
  const month = /^\d{4}-\d{2}$/.test(String(q.month || '')) ? q.month : curMonth;
  return { start: `${month}-01`, end: `${month}-31`, label: u.monthLabel(month), preset: 'month', key: month, month };
}

router.get('/reports', auth.requireLogin, (req, res) => {
  const ledger = res.locals.ledger;
  if (!ledger) return res.redirect('/');
  const ledgerId = Number(ledger.id);
  const range = parseRange(req.query, ledgerId);
  const kind = req.query.kind === 'income' ? 'income' : 'expense';

  const sum = txn.summary(ledgerId, range.start, range.end);
  const cats = txn.categoryBreakdown(ledgerId, range.start, range.end, kind);
  const subcats = txn.subcategoryBreakdown(ledgerId, range.start, range.end, kind, req.query.top || null);
  const trend = txn.monthlyTrend(ledgerId, 12);
  const days = txn.dailyBreakdown(ledgerId, range.start, range.end);
  const members = txn.memberBreakdown(ledgerId, range.start, range.end);
  const owners = txn.ownerBreakdown(ledgerId, range.start, range.end);
  const netWorth = txn.netWorthTrend(ledgerId, 12);
  const overview = txn.accountOverview(ledgerId);

  // 同期对比
  let compare = null;
  if (range.preset === 'month' && range.month) {
    const prevMonth = u.addMonths(range.month, -1);
    const prev = txn.summary(ledgerId, `${prevMonth}-01`, `${prevMonth}-31`);
    const lastYearMonth = `${Number(range.month.slice(0, 4)) - 1}-${range.month.slice(5, 7)}`;
    const lastYear = txn.summary(ledgerId, `${lastYearMonth}-01`, `${lastYearMonth}-31`);
    compare = {
      prevMonth: { label: u.monthLabel(prevMonth), ...prev },
      lastYear: { label: u.monthLabel(lastYearMonth), ...lastYear },
    };
  }

  // 星期分布
  const weekday = new Array(7).fill(0);
  for (const d of days) {
    const wd = new Date(`${d.date}T00:00:00`).getDay();
    weekday[wd] += d.expense;
  }

  // 消费笔数 & 均值
  const expenseCount = get(
    `SELECT COUNT(*) AS c, COALESCE(AVG(amount_base_cents),0) AS avg FROM transactions
     WHERE ledger_id = ? AND deleted_at IS NULL AND txn_date BETWEEN ? AND ? AND type IN ('expense','fee')`,
    ledgerId, range.start, range.end
  );
  const maxDay = days.reduce((a, b) => (b.expense > (a?.expense || 0) ? b : a), null);

  // 记账天数
  const activeDays = days.filter((d) => d.count > 0).length;

  // P7 月末预测：仅当前月的月视图出总口径预测（其他月份/年度/自定义区间无从谈「月末」）
  let monthForecast = null;
  if (range.preset === 'month' && range.month && range.month === todayStr().slice(0, 7)) {
    monthForecast = require('../lib/forecast').monthForecast(ledgerId, new Date());
  }

  res.render('reports', {
    title: '报表分析', activeNav: 'reports',
    range, kind, sum, cats, subcats, trend, days, members, owners, netWorth, overview,
    compare, weekday, expenseCount, maxDay, activeDays, monthForecast,
    top: req.query.top || null,
    today: todayStr(),
  });
});

/* ------------------------------ P9 年度账单 ------------------------------- */

function narrativeKey(ledgerId, year) {
  return `annual.narrative.${ledgerId}.${year}`;
}

function readNarrative(ledgerId, year) {
  try { return JSON.parse(getSetting(narrativeKey(ledgerId, year), 'null')); } catch { return null; }
}

router.get('/annual', auth.requireLogin, (req, res) => {
  const ledger = res.locals.ledger;
  if (!ledger) return res.redirect('/');
  const ledgerId = Number(ledger.id);
  const year = /^\d{4}$/.test(String(req.query.year || '')) ? String(req.query.year) : todayStr().slice(0, 4);
  const stats = annual.yearStats(ledgerId, year);
  // 年份切换器：账本第一笔账所在年 ~ 当前年（最多列 6 个，再往前不常见）
  const firstYear = Number((get(
    'SELECT MIN(txn_date) AS d FROM transactions WHERE ledger_id = ? AND deleted_at IS NULL', ledgerId
  )?.d || todayStr()).slice(0, 4));
  const curYear = Number(todayStr().slice(0, 4));
  const years = [];
  for (let y = curYear; y >= Math.max(firstYear, curYear - 5); y--) years.push(String(y));
  res.render('annual', {
    title: `${year} 年度账单`, activeNav: 'reports',
    stats, year, years,
    narrative: readNarrative(ledgerId, year),
    aiUsable: ai.isAiUsable(),
    today: todayStr(),
  });
});

// 模型写年度叙事：只喂聚合值（出网白名单），数字全部 SQL 预计算，模型不做算术不编数
router.post('/api/annual/narrative', auth.requireLogin, async (req, res) => {
  const ledger = res.locals.ledger;
  if (!ledger) return res.status(400).json({ ok: false, error: '没有账本' });
  const ledgerId = Number(ledger.id);
  const year = /^\d{4}$/.test(String(req.body.year || '')) ? String(req.body.year) : todayStr().slice(0, 4);
  try {
    if (!ai.isAiUsable()) {
      return res.status(400).json({ ok: false, error: '尚未配置 AI 模型（设置 → AI 截图记账），纯统计数据仍可正常查看' });
    }
    const stats = annual.yearStats(ledgerId, year);
    if (!stats.hasData) return res.status(400).json({ ok: false, error: `${year} 年还没有账目，先记几笔再来生成总结吧` });

    const out = await ai.callModel([
      {
        role: 'system',
        content: '你是家庭记账本的年度总结撰稿人。根据给出的年度统计写 3~5 句中文总结：亲切自然、有具体数字、有温度，像家人间的年终闲聊。只能引用给出的数字，绝不编造或计算新数字；不输出标题，不输出 JSON，只输出正文。',
      },
      { role: 'user', content: `请为以下年度账目写年度总结：\n${JSON.stringify(annual.narrativePayload(stats), null, 1)}` },
    ]);
    const text = String(out || '').trim().slice(0, 600);
    if (!text) return res.status(400).json({ ok: false, error: '模型没有返回内容，请稍后再试' });
    const rec = { text, generated_at: nowStr() };
    setSetting(narrativeKey(ledgerId, year), JSON.stringify(rec));
    auth.audit(req, 'annual.narrative', { ledgerId, detail: `${year} 年度总结生成（${text.length} 字）` });
    res.json({ ok: true, ...rec });
  } catch (e) {
    res.status(400).json({ ok: false, error: `生成失败：${e.message}` });
  }
});

module.exports = router;
