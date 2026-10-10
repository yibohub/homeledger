'use strict';
/**
 * 回归：生产配置 fail-fast（启动守卫）
 *
 * 纯 spawn 驱动：每个用例起独立 node server.js（独立端口 + 独立 DATA_DIR），不依赖 8099。
 * 覆盖：
 *   - NODE_ENV=production 下 SESSION_SECRET 未设 / compose 占位符 / 代码默认值 → 拒绝启动，
 *     且 SESSION_SECRET 拒启发生在建库前（无数据目录副作用）
 *   - production 首次建号仍用默认密码 admin888（显式或 compose 缺省路径）→ 拒绝启动
 *   - production + 全随机配置 + 空库 → 正常启动（不误伤）
 *   - 开发模式（无 NODE_ENV）+ 零配置 → 正常启动（现状兼容，本地体验不变）
 *   - production + 已有用户的库 + 未设 ADMIN_PASSWORD → 正常启动（compose 总是传该变量、
 *     已有部署重启不消费它，守卫不得炸掉升级重启）
 *
 * 运行：node test/verify-startup.js
 */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}

const randHex = () => crypto.randomBytes(16).toString('hex');
// 用完即清的隔离数据目录（含清理上次残留）
const DIRS = [];
function caseDir(n) {
  const d = path.join(ROOT, `data-verify-startup-${n}`);
  DIRS.push(d);
  fs.rmSync(d, { recursive: true, force: true });
  return d;
}
// 去掉 run-all 注入的 NODE_ENV/DATA_DIR，由每个用例显式给值
const baseEnv = (() => { const { NODE_ENV, DATA_DIR, ...rest } = process.env; return rest; })();

function startServer(env) {
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  return { child, out: () => out };
}
function waitExit(child, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } resolve({ code: null, timedOut: true }); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, timedOut: false }); });
  });
}
function healthz(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    (function probe() {
      const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 2000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('timeout', () => { req.destroy(); retry(); });
      req.on('error', retry);
      function retry() {
        if (Date.now() > deadline) return resolve(false);
        setTimeout(probe, 300);
      }
    })();
  });
}
const prodEnv = (n, extra = {}) => ({
  ...baseEnv, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(18110 + n),
  DATA_DIR: caseDir(n), SESSION_SECRET: randHex(), ADMIN_PASSWORD: randHex(), ...extra,
});

(async () => {
  console.log('\n=== 生产配置 fail-fast（启动守卫，进程 spawn）===\n');

  /* SESSION_SECRET：未设 / compose 占位符 / 代码默认值，三种都拒 */
  {
    const env = prodEnv(1);
    delete env.SESSION_SECRET; // 真「未设」，而非空串
    const s = startServer(env);
    const r = await waitExit(s.child);
    check('production 未设 SESSION_SECRET → 拒启', !r.timedOut && r.code !== 0, `exit=${r.code}`);
    check('拒启信息指明修复方法（openssl rand）', s.out().includes('openssl rand'));
    check('SESSION_SECRET 拒启发生在建库前（无库文件残留）', !fs.existsSync(path.join(ROOT, 'data-verify-startup-1', 'homeledger.db')));
  }
  {
    const s = startServer(prodEnv(2, { SESSION_SECRET: 'please-change-this-session-secret' }));
    const r = await waitExit(s.child);
    check('production 传 compose 占位符 SESSION_SECRET → 拒启', !r.timedOut && r.code !== 0, `exit=${r.code}`);
  }
  {
    const s = startServer(prodEnv(3, { SESSION_SECRET: 'homeledger-dev-secret-please-change' }));
    const r = await waitExit(s.child);
    check('production 传代码默认值 SESSION_SECRET → 拒启', !r.timedOut && r.code !== 0, `exit=${r.code}`);
  }

  /* ADMIN_PASSWORD：只在首次建号时消费——默认密码两种到达路径都拒 */
  {
    const s = startServer(prodEnv(4, { ADMIN_PASSWORD: 'admin888' }));
    const r = await waitExit(s.child);
    check('production 首次建号用显式 admin888 → 拒启', !r.timedOut && r.code !== 0 && s.out().includes('admin888'), `exit=${r.code}`);
  }
  {
    const s = startServer(prodEnv(5, { ADMIN_PASSWORD: '' }));
    const r = await waitExit(s.child);
    check('production 首次建号未设 ADMIN_PASSWORD（compose 缺省路径）→ 拒启', !r.timedOut && r.code !== 0, `exit=${r.code}`);
  }

  /* 全随机配置 + 空库：正常启动，不误伤 */
  {
    const s = startServer(prodEnv(6));
    const okUp = await healthz(18116);
    check('production 随机 SESSION_SECRET + 随机 ADMIN_PASSWORD → 正常启动', okUp);
    s.child.kill();
    await waitExit(s.child);
  }

  /* 开发模式零配置：现状兼容 */
  {
    const env = { ...baseEnv, HOST: '127.0.0.1', PORT: '18117', DATA_DIR: caseDir(7) };
    delete env.NODE_ENV; delete env.SESSION_SECRET; delete env.ADMIN_PASSWORD;
    const s = startServer(env);
    const okUp = await healthz(18117);
    check('开发模式（无 NODE_ENV）零配置 → 正常启动（本地体验不变）', okUp);
    s.child.kill();
    await waitExit(s.child);
  }

  /* 已有用户的库 + production + 未设 ADMIN_PASSWORD：升级重启不得被炸 */
  {
    const dir = caseDir(8);
    const devEnv = { ...baseEnv, HOST: '127.0.0.1', PORT: '18118', DATA_DIR: dir };
    delete devEnv.NODE_ENV; delete devEnv.SESSION_SECRET; delete devEnv.ADMIN_PASSWORD;
    const boot = startServer(devEnv); // 开发模式先建号（bootstrap admin）
    check('前置：开发模式首次启动完成建号', await healthz(18118));
    boot.child.kill();
    await waitExit(boot.child);

    const s = startServer({
      ...baseEnv, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '18118',
      DATA_DIR: dir, SESSION_SECRET: randHex(), ADMIN_PASSWORD: '', // 同库切生产重启；不能用 prodEnv（其 caseDir 会清库）
    });
    const okUp = await healthz(18118);
    check('已有用户库 production 重启未设 ADMIN_PASSWORD → 正常启动（不破坏升级）', okUp,
      okUp ? '' : `服务输出：${s.out().slice(-160)}`);
    s.child.kill();
    await waitExit(s.child);
  }

  for (const d of DIRS) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('套件异常：', e); process.exit(1); });
