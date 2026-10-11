'use strict';
/**
 * P9 年度账单：把指定年份的全部数字用 SQL 统计出来（纯统计零 token），
 * 页面直接展示；模型叙事只描述这里的聚合值（模型不做任何算术）。
 */
const { all, get } = require('../db');
const txn = require('./txn');

/**
 * @returns {{
 *   year: string, hasData: boolean,
 *   totals: { expense: number, income: number, net: number, count: number, days: number },
 *   monthly: Array<{ month: string, expense: number, income: number }>,
 *   topCats: Array<{ name: string, total: number }>,
 *   topMerchants: Array<{ merchant: string, cnt: number, total: number }>,
 *   biggest: { txn_date: string, merchant: string, note: string, amount: number } | null,
 *   first: { txn_date: string, merchant: string, note: string, amount: number, type: string } | null,
 *   owners: Array<{ label: string, expense: number, income: number, cnt: number }>,
 * }}
 */
function yearStats(ledgerId, year) {
  const y = /^\d{4}$/.test(String(year)) ? String(year) : String(new Date().getFullYear());
  const start = `${y}-01-01`;
  const end = `${y}-12-31`;
  const base = 'ledger_id = ? AND deleted_at IS NULL AND txn_date BETWEEN ? AND ?';

  const totalsRows = all(
    `SELECT type, SUM(amount_base_cents) AS s, COUNT(*) AS c FROM transactions
     WHERE ${base} AND type IN ('expense','income') GROUP BY type`,
    ledgerId, start, end
  );
  const expense = Number(totalsRows.find((r) => r.type === 'expense')?.s || 0);
  const income = Number(totalsRows.find((r) => r.type === 'income')?.s || 0);
  const count = totalsRows.reduce((s, r) => s + Number(r.c), 0);
  const days = Number(get(
    `SELECT COUNT(DISTINCT txn_date) AS c FROM transactions WHERE ${base} AND type IN ('expense','income')`,
    ledgerId, start, end
  )?.c || 0);

  const monthlyRows = all(
    `SELECT strftime('%m', txn_date) AS m, type, SUM(amount_base_cents) AS s FROM transactions
     WHERE ${base} AND type IN ('expense','income') GROUP BY m, type`,
    ledgerId, start, end
  );
  const monthly = Array.from({ length: 12 }, (_, i) => {
    const m = String(i + 1).padStart(2, '0');
    return {
      month: m,
      expense: Number(monthlyRows.find((r) => r.m === m && r.type === 'expense')?.s || 0),
      income: Number(monthlyRows.find((r) => r.m === m && r.type === 'income')?.s || 0),
    };
  });

  // 支出 Top 分类：叶子层聚合，名字带父级路径（与报表口径一致）；
  // JOIN categories 后 ledger_id 必须限定表前缀（categories 也有同名列）
  const catRows = all(
    `SELECT t.category_id AS cid, SUM(t.amount_base_cents) AS total,
            c.name AS cname, p.name AS parent
     FROM transactions t
     JOIN categories c ON c.id = t.category_id
     LEFT JOIN categories p ON p.id = c.parent_id
     WHERE t.ledger_id = ? AND t.deleted_at IS NULL AND t.txn_date BETWEEN ? AND ?
       AND t.type = 'expense' AND t.category_id IS NOT NULL
     GROUP BY t.category_id ORDER BY total DESC LIMIT 8`,
    ledgerId, start, end
  );
  const topCats = catRows.map((r) => ({
    name: r.parent ? `${r.parent}/${r.cname}` : r.cname,
    total: Number(r.total),
  }));

  const merchRows = all(
    `SELECT merchant, COUNT(*) AS cnt, SUM(amount_base_cents) AS total FROM transactions
     WHERE ${base} AND type = 'expense' AND merchant IS NOT NULL AND merchant != ''
     GROUP BY merchant ORDER BY cnt DESC, total DESC LIMIT 8`,
    ledgerId, start, end
  );
  const topMerchants = merchRows.map((r) => ({ merchant: r.merchant, cnt: Number(r.cnt), total: Number(r.total) }));

  const biggestRow = get(
    `SELECT txn_date, merchant, note, amount_base_cents AS amount FROM transactions
     WHERE ${base} AND type = 'expense' ORDER BY amount DESC, id ASC LIMIT 1`,
    ledgerId, start, end
  );
  const firstRow = get(
    `SELECT txn_date, merchant, note, amount_base_cents AS amount, type FROM transactions
     WHERE ${base} AND type IN ('expense','income') ORDER BY txn_date ASC, id ASC LIMIT 1`,
    ledgerId, start, end
  );

  return {
    year: y,
    hasData: count > 0,
    totals: { expense, income, net: income - expense, count, days },
    monthly,
    topCats,
    topMerchants,
    biggest: biggestRow ? { ...biggestRow, amount: Number(biggestRow.amount) } : null,
    first: firstRow ? { ...firstRow, amount: Number(firstRow.amount) } : null,
    owners: txn.ownerBreakdown(ledgerId, start, end),
  };
}

/** 叙事用的聚合值快照（模型只拿这些，出网=聚合值；金额转元字符串，模型可直接引用不必算术） */
function narrativePayload(stats) {
  const yuan = (c) => (Number(c) / 100).toFixed(2);
  return {
    年份: stats.year,
    总支出元: yuan(stats.totals.expense),
    总收入元: yuan(stats.totals.income),
    结余元: yuan(stats.totals.net),
    记账天数: stats.totals.days,
    记账笔数: stats.totals.count,
    每月支出元: stats.monthly.map((m) => yuan(m.expense)).join(','),
    支出Top分类: stats.topCats.map((c) => `${c.name} ${yuan(c.total)}元`).slice(0, 5),
    最常去商户: stats.topMerchants.map((m) => `${m.merchant} ${m.cnt}笔`).slice(0, 5),
    最大单笔支出: stats.biggest ? `${stats.biggest.merchant || stats.biggest.note || ''} ${yuan(stats.biggest.amount)}元（${stats.biggest.txn_date}）` : '无',
    归属人支出: stats.owners.map((o) => `${o.label} ${yuan(o.expense)}元`).slice(0, 5),
  };
}

module.exports = { yearStats, narrativePayload };
