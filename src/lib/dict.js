'use strict';
/**
 * P13 个人动态词表：从本账本历史沉淀「商户→分类」稳定映射。
 *
 * 系统关键词表（ai.js KEYWORD_RULES）是全体用户共享的静态表，本模块给每个账本
 * 一份自己的词表：同一商户被用户亲手归到同一分类 ≥3 次且占比 ≥80%，即视为
 * 「稳定映射」入表；normalizeItem 的分类兜底链里优先于系统表（用户自己的记法
 * 高于通用常识）。可解释（设置页逐条可见）、可遗忘（删除后 dismissed 永不自动
 * 复活）。纯统计零 token。
 */
const { all, get, getSetting, setSetting, nowStr } = require('../db');

const DICT_CAP = 200;        // 生效条目上限（超出不再新增；词表是兜底链一环，防无限膨胀）
const DISMISSED_KEEP = 50;   // 已删条目保留上限（只为阻止同商户反复沉淀，超出裁最旧）
const MIN_HITS = 3;          // 至少 3 笔才可能沉淀
const DOMINANT_RATIO = 0.8;  // 主分类占比 ≥80% 才算「稳定」

function load(ledgerId) {
  try { return JSON.parse(getSetting(`dict.categories.${ledgerId}`, '[]')) || []; } catch { return []; }
}

function save(ledgerId, list) {
  setSetting(`dict.categories.${ledgerId}`, JSON.stringify(list));
}

/**
 * 记一笔后触发：重估该商户映射的成熟度，达标则入表/刷新笔数。
 * 已删（dismissed）条目不复活——用户明确否定过的映射不该自己爬回来。
 */
function sediment(ledgerId, merchant) {
  try {
    const kw = String(merchant || '').trim().slice(0, 60);
    if (!kw) return false;
    const rows = all(
      `SELECT t.category_id AS cid, c.kind AS kind, COUNT(*) AS cnt
       FROM transactions t JOIN categories c ON c.id = t.category_id AND c.is_archived = 0
       WHERE t.ledger_id = ? AND t.deleted_at IS NULL AND t.merchant = ?
         AND t.category_id IS NOT NULL AND t.type IN ('expense','income')
       GROUP BY t.category_id ORDER BY cnt DESC, cid DESC`,
      ledgerId, kw
    );
    if (!rows.length) return false;
    const total = rows.reduce((s, r) => s + r.cnt, 0);
    const top = rows[0];
    if (total < MIN_HITS || top.cnt / total < DOMINANT_RATIO) return false;
    const list = load(ledgerId);
    const hit = list.find((e) => e.kw === kw && e.kind === top.kind);
    if (hit) {
      if (hit.dismissed) return false;
      hit.hits = total;
      hit.updated_at = nowStr();
      save(ledgerId, list);
      return true;
    }
    if (list.filter((e) => !e.dismissed).length >= DICT_CAP) return false;
    list.push({ kw, kind: top.kind, category_id: Number(top.cid), hits: total, updated_at: nowStr(), dismissed: 0 });
    // 已删条目超限：裁掉最旧的，防长尾账本反复沉淀风暴
    const dismissed = list.filter((e) => e.dismissed);
    if (dismissed.length > DISMISSED_KEEP) {
      const drop = new Set(dismissed.slice(0, dismissed.length - DISMISSED_KEEP));
      save(ledgerId, list.filter((e) => !drop.has(e)));
      return true;
    }
    save(ledgerId, list);
    return true;
  } catch (e) {
    console.error('[dict] 沉淀失败（不影响记账）:', e.message);
    return false;
  }
}

/**
 * 兜底链匹配：先商户全等（最准），再对「商户+备注+分类名」包含匹配（与系统表同口径）。
 * 只回仍存在的未归档分类；kind 不符跳过（支出/收入词表分开）。
 */
function lookup(ledgerId, merchant, text, kind) {
  const kw = String(merchant || '').trim().slice(0, 60);
  const hay = String(text || '');
  const entries = load(ledgerId).filter((e) => !e.dismissed && e.kind === kind);
  const alive = (e) => get(
    'SELECT id FROM categories WHERE id = ? AND is_archived = 0 AND kind = ?', e.category_id, kind
  );
  if (kw) {
    for (const e of entries) if (e.kw === kw && alive(e)) return e;
  }
  for (const e of entries) if (hay.includes(e.kw) && alive(e)) return e;
  return null;
}

/** P12 反馈联动：词表推荐的分类被用户改掉 → 扣分，扣穿即失效（dismissed，不自动复活） */
function demote(ledgerId, merchant, categoryId) {
  try {
    const kw = String(merchant || '').trim().slice(0, 60);
    if (!kw) return;
    const list = load(ledgerId);
    const hit = list.find((e) => e.kw === kw && !e.dismissed && Number(e.category_id) === Number(categoryId));
    if (!hit) return;
    hit.hits -= 2;
    if (hit.hits < 1) hit.dismissed = 1;
    save(ledgerId, list);
  } catch (e) {
    console.error('[dict] 反馈扣分失败（不影响记账）:', e.message);
  }
}

/** 设置页展示：生效条目（带分类完整路径，可解释） */
function listActive(ledgerId) {
  return load(ledgerId)
    .filter((e) => !e.dismissed)
    .map((e) => {
      const c = get(
        `SELECT c.name AS cname, p.name AS parent FROM categories c
         LEFT JOIN categories p ON p.id = c.parent_id WHERE c.id = ?`,
        e.category_id
      );
      return { ...e, category_path: c ? (c.parent ? `${c.parent}/${c.cname}` : c.cname) : '（分类已删除）' };
    })
    .sort((a, b) => b.hits - a.hits);
}

/** 设置页删除：dismissed=1，永不自动复活（可遗忘） */
function dismiss(ledgerId, kw, kind) {
  const list = load(ledgerId);
  const hit = list.find((e) => e.kw === String(kw || '').slice(0, 60) && e.kind === kind && !e.dismissed);
  if (!hit) return false;
  hit.dismissed = 1;
  save(ledgerId, list);
  return true;
}

module.exports = { sediment, lookup, demote, listActive, dismiss, MIN_HITS };
