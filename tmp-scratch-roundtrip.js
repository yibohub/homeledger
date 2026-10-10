'use strict';
// 一次性实证脚本：导出 CSV → parseBill 回导，类型是否漂移（用完即删）
const { parseBill, toCsv, EXPORT_HEADER, exportRows } = require('./src/lib/importers');
const labels = { expense: '支出', income: '收入', transfer: '转账', lend: '借出', borrow: '借入', repay_receive: '收回借款', repay_pay: '偿还借款', reimburse: '报销入账', refund: '退款', fee: '手续费', interest: '利息收入', invest_buy: '投资买入', invest_sell: '投资卖出', adjust: '余额调整' };
const rows = Object.entries(labels).map(([type, label], i) => ({
  txn_date: `2026-10-0${i + 1}`, type_label: label, amount_cents: 1000 + i, currency: 'CNY',
  amount_base_cents: 1000 + i, category_path: '餐饮/外卖', account_name: '微信零钱', to_account_name: '',
  member_name: '', merchant: `商户${i}`, note: '', tag_names: '', source: 'manual', status: 'cleared', type,
}));
const csv = toCsv(EXPORT_HEADER, exportRows(null, rows));
const parsed = parseBill(Buffer.from(csv, 'utf8'));
console.log('source =', parsed.source);
for (const r of parsed.records) {
  const label = (r.note || '').split(' · ')[0];
  const want = Object.entries(labels).find(([, l]) => l === label)?.[0];
  const mark = r.type === want ? '' : '  <<< 漂移（应为 ' + want + '）';
  console.log(String(r.merchant).padEnd(8), '标签=', label.padEnd(5), '→ type =', r.type, mark);
}
console.log('neutralRecords =', parsed.neutralRecords.length);
