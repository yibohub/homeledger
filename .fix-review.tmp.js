'use strict';
const fs = require('fs');
let n = 0;
function patch(file, from, to) {
  let s = fs.readFileSync(file, 'utf8');
  if (!s.includes(from)) { console.error('MISS ' + file + ' :: ' + from.slice(0, 60)); process.exit(1); }
  s = s.replace(from, to);
  fs.writeFileSync(file, s);
  n++;
  console.log('ok ' + n + ' ' + file);
}

// P1-1: admin.js 名单分隔正则（\s 被 bash 吃成 s）
patch('src/routes/admin.js',
  ".split(/[、,，;；s]+/)",
  ".split(/[、,，;；\\s]+/)");

// P1-2: importers 归属人清洗复用 ai.cleanOwnerLabel（四处规则归一）
patch('src/lib/importers.js',
  "const { classifyByKeywords, guessAccountName, resolveCategoryId, resolveAccountId } = require('./ai');",
  "const { classifyByKeywords, guessAccountName, resolveCategoryId, resolveAccountId, cleanOwnerLabel } = require('./ai');");
patch('src/lib/importers.js',
  /owner_label: String\(ownerText \|\| ''\)\.replace[^,]+, ''\)\.trim\(\)\.slice\(0, 20\) \|\| null,/,
  "owner_label: cleanOwnerLabel(ownerText),");

// P1-3: openapi 部分更新沿用旧归属人（?? 链：显式空串仍可清除）
patch('src/routes/openapi.js',
  "    owner_label: body.owner_label || body.for_member || null,",
  "    owner_label: body.owner_label ?? body.for_member ?? null,");

// P3-9: 陈旧注释（第十六列 → 第十七列）
patch('src/lib/importers.js',
  /第十六列 type_key[^']*'/,
  "第十七列 type_key（含归属人列）'");

console.log('all applied');
