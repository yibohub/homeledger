/* ============================================================
   家账簿 · 手机极简模式（P10）—— 布局适配 + Tab1 捕获区
   ① 软键盘适配（所有极简页面）：键盘弹出会把固定底栏顶到输入区上方，
      盖住捕获区的输入框/识别按钮——键盘打开时隐藏底栏，收起自动恢复
   ② 捕获区：语音 / 拍账单 / 文字 → 草稿卡片 → 确认入库；
      问句自动转查账（阶段 2）→ 回答卡片。只读成员只有问账（无拍单按钮）
   ============================================================ */
'use strict';

/* --------------------------- 软键盘适配（底栏避让） --------------------------- */
(function () {
  // 仅触屏设备：桌面显式开极简（hl_simple=1）时拖窗口/开 DevTools 的高度骤变不参与
  var mq = window.matchMedia;
  if (!mq || !mq('(pointer: coarse)').matches || !window.visualViewport) return;
  var vv = window.visualViewport;
  var base = 0; // 键盘收起时的可视全高基线：只在「干净高度」（不小于现基线且判定为收起）上学，
  // 键盘开着时的载入/中间高度学不进来，学小了也会在收起时自愈
  var open = false;
  var pend = 0; // 高度稳定去抖句柄

  // 键盘高度变化有两种上报形态：resizes-visual 只改 vv.height、resizes-content 连
  // innerHeight 一起改（个别内核只改 innerHeight）——取两者最小值，两种形态都检测得到
  function vh() {
    return Math.min(vv.height, window.innerHeight || vv.height);
  }
  function apply() {
    var h = vh();
    // 缩掉 >25% 视为键盘弹出；scale>1.01 的捏合缩放排除（放大态下键盘判定失效是已知接受面，
    // 精确区分需 VirtualKeyboard API，需要时再上）；地址栏收展只有 ~8% 不误触。
    // 不绑 focus/blur 判键盘：点「识别」时焦点转移先关键盘，布局抖动可能吞掉这次点击
    var now = base > 0 && (!vv.scale || vv.scale <= 1.01) && h < base * 0.75;
    if (h > base) base = h; // 干净高度（不小于现基线）随时可学；键盘开着的载入学小了，收起即自愈
    if (now === open) return;
    open = now;
    document.body.classList.toggle('kb-open', open);
    if (open) {
      // 高度已稳定（去抖）再居中捕获区——输入框和整行按钮都露出，不用先收键盘
      var el = document.activeElement;
      var cap = el && el.closest && el.closest('.m-capture');
      if (cap) cap.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
  // 键盘弹出/收起与旋转都会连续触发 resize：等高度稳定 250ms 再判定，
  // 否则旋转动画的中间高度会被学进基线，把 kb-open 误锁一整个横屏会话
  // window resize 一并监听：个别内核只改 innerHeight（vv 不动），收起方向也要有采样点（评审 P2）
  function schedule(delay) {
    if (pend) clearTimeout(pend);
    pend = setTimeout(function () { pend = 0; apply(); }, delay);
  }
  vv.addEventListener('resize', function () { schedule(250); });
  window.addEventListener('resize', function () { schedule(250); });
  // 兜底：个别内核 resize 事件缺失或在去抖窗口内被吞——聚焦输入后 400ms 再核一次
  document.addEventListener('focusin', function () { schedule(400); });
  // 500ms 轮询兜底（实测：m.js 初始化时键盘已占屏/事件丢失，基准会学小且永不自愈，
  // 底栏从此不藏——事件在 OEM 内核上不可靠，轮询读高度是无事件内核的唯一可靠来源）。
  // 复用 schedule 去抖：轮询不得绕过 250ms 静默窗口，否则旋转动画的中间高度会被
  // base=0 的首采样学进基线，横屏末态最小、monotonic-up 无法自愈（评审 P1）
  setInterval(function () { schedule(250); }, 500);
  // 旋转：基线换方向重学（matchMedia 事件替代已废弃的 orientationchange）
  var omq = mq('(orientation: portrait)');
  var onTurn = function () { base = 0; };
  if (omq.addEventListener) omq.addEventListener('change', onTurn);
  else if (omq.addListener) omq.addListener(onTurn);
  apply(); // 初次学基线。若此时键盘已占屏（浏览器跨页保留键盘）会学到小高度，
  // 本会话避让失效——轮询保证键盘收起后的首个采样把基线修回全高（自愈）
})();

/* ------------------------------ Tab1 捕获区 ------------------------------ */
(function () {
  const cap = document.getElementById('mCapture');
  if (!cap) return;

  const $ = (id) => document.getElementById(id);
  const textEl = $('mText');
  const micBtn = $('mMic');
  const camBtn = $('mCam');
  const goBtn = $('mGo');
  const fileEl = $('mFile');
  const thumbsEl = $('mThumbs');
  const draftsEl = $('mDrafts');
  const msgEl = $('mMsg');
  const csrf = (document.querySelector('meta[name="csrf"]') || {}).content || '';

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }
  const fmt = (cents) => '¥' + (Number(cents || 0) / 100).toFixed(2);

  function say(type, text) {
    msgEl.textContent = text;
    msgEl.className = 'm-capture-msg ' + type;
  }
  function clearSay() {
    msgEl.className = 'm-capture-msg hidden';
  }

  /* --------------------------- 图片选择与预览 --------------------------- */
  const pendingImages = [];
  // 拍单按钮按可写权限渲染，只读视图（P10 阶段 2）没有它——监听前判空，别让整个捕获区挂掉
  if (camBtn) camBtn.addEventListener('click', () => fileEl.click());
  fileEl.addEventListener('change', async () => {
    for (const f of Array.from(fileEl.files || [])) {
      if (pendingImages.length >= 6) break;
      const dataUrl = await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => resolve('');
        fr.readAsDataURL(f);
      });
      if (dataUrl) pendingImages.push({ dataUrl, name: f.name });
    }
    fileEl.value = '';
    renderThumbs();
  });
  function renderThumbs() {
    thumbsEl.innerHTML = '';
    thumbsEl.classList.toggle('hidden', !pendingImages.length);
    pendingImages.forEach((p, i) => {
      const d = document.createElement('div');
      d.className = 't';
      const img = document.createElement('img');
      img.src = p.dataUrl;
      img.alt = '';
      d.appendChild(img);
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '✕';
      b.addEventListener('click', () => { pendingImages.splice(i, 1); renderThumbs(); });
      d.appendChild(b);
      thumbsEl.appendChild(d);
    });
  }

  /* --------------------------- 语音（与悬浮球 assistant.js 同规则；改一处记得同步另一处） --------------------------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  // 同 assistant.js：非安全上下文（HTTP 访问 NAS）下 Web Speech 只会报 not-allowed，不亮按钮
  if (micBtn && SR && window.isSecureContext) {
    micBtn.hidden = false;
    let rec = null;
    let listening = false;
    micBtn.addEventListener('click', () => {
      if (listening) { try { rec.stop(); } catch { /* ignore */ } return; }
      rec = new SR();
      rec.lang = 'zh-CN';
      rec.interimResults = true;
      rec.continuous = false;
      const base = textEl.value.trim();
      textEl.readOnly = true;
      rec.onresult = (e) => {
        let s = '';
        for (let i = 0; i < e.results.length; i++) s += e.results[i][0].transcript;
        textEl.value = base ? base + '，' + s : s;
        textEl.dispatchEvent(new Event('input'));
      };
      rec.onend = () => { listening = false; textEl.readOnly = false; micBtn.classList.remove('listening'); };
      rec.onerror = (e) => {
        textEl.readOnly = false;
        if (e.error !== 'no-speech' && e.error !== 'aborted') {
          say('warn', e.error === 'not-allowed'
            ? '麦克风被浏览器拒绝（需 HTTPS 访问并授权），可以直接输入或用系统键盘听写'
            : '语音识别失败（' + e.error + '），可以直接输入');
        }
      };
      listening = true;
      micBtn.classList.add('listening');
      try { rec.start(); } catch { listening = false; micBtn.classList.remove('listening'); }
    });
  }
  textEl.addEventListener('input', () => {
    textEl.style.height = 'auto';
    textEl.style.height = Math.min(textEl.scrollHeight, 90) + 'px';
  });
  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); recognize(); }
  });
  goBtn.addEventListener('click', recognize);

  /* --------------------------- 识别 → 草稿卡片 --------------------------- */
  let busy = false;
  // 识别按钮的文案（可写视图「识别」/只读视图「提问」）——busy 结束后还原
  const goSpan = goBtn.querySelector('span');
  const goLabel = goSpan ? goSpan.textContent : '';
  async function recognize() {
    if (busy) return;
    const text = textEl.value.trim();
    if (!text && !pendingImages.length) return;
    busy = true;
    goBtn.disabled = true;
    // AI 返回要几秒：图标转起来 + 文案变「识别中…」，别让用户以为卡死
    goBtn.classList.add('busy');
    goBtn.setAttribute('aria-busy', 'true'); // 读屏用户同样感知进行中状态
    if (goSpan) goSpan.textContent = '识别中…';
    clearSay();
    try {
      const isPhoto = pendingImages.length > 0;
      const res = await fetch(isPhoto ? '/api/ai/scan' : '/api/ai/text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, Accept: 'application/json' },
        body: JSON.stringify(isPhoto ? { images: pendingImages, text } : { text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        say('warn', (data && data.error) || '识别失败，请稍后重试');
      } else if (data.mode === 'answer' || data.mode === 'clarify') {
        // 问句走查账（P10 阶段 2）：服务端已分流，直接出回答卡，不进草稿管线
        renderAnswer(data);
        textEl.value = '';
        textEl.style.height = 'auto';
      } else if (!data.items || !data.items.length) {
        say('warn', '没有识别到内容，试试「午饭 35 元」或拍一张账单');
      } else {
        renderDrafts(data, (data.images || []).map((s) => s.id));
        textEl.value = '';
        textEl.style.height = 'auto';
        pendingImages.splice(0);
        renderThumbs();
      }
    } catch (e) {
      say('warn', '网络异常：' + e.message);
    } finally {
      busy = false;
      goBtn.disabled = false;
      goBtn.classList.remove('busy');
      goBtn.removeAttribute('aria-busy');
      if (goSpan) goSpan.textContent = goLabel;
    }
  }

  /* --------------------------- 问账回答卡（P10 阶段 2） --------------------------- */
  // mode=answer 直出统计结论，mode=clarify 反问引导；插到草稿流顶部，内容全走 textContent；
  // 带 ✕ 可关（多次提问会堆积，与草稿卡的「放弃」对齐）
  function renderAnswer(data) {
    const card = document.createElement('div');
    card.className = 'm-answer';
    const tag = document.createElement('div');
    tag.className = 'm-answer-tag';
    tag.textContent = (data.engine === 'llm' ? 'AI 问账' : '问账 · 本地规则') + (data.mode === 'clarify' ? '（请补充）' : '');
    card.appendChild(tag);
    const body = document.createElement('div');
    body.className = 'm-answer-body';
    body.textContent = data.text || '';
    card.appendChild(body);
    if (Array.isArray(data.warnings) && data.warnings.length) {
      const w = document.createElement('div');
      w.className = 'm-answer-warn';
      w.textContent = '⚠ ' + data.warnings.join('；');
      card.appendChild(w);
    }
    const meta = document.createElement('div');
    meta.className = 'm-answer-meta';
    const rpt = document.createElement('a');
    rpt.href = '/reports';
    rpt.textContent = '看报表 →';
    meta.appendChild(rpt);
    card.appendChild(meta);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'm-answer-x';
    close.setAttribute('aria-label', '关闭');
    close.textContent = '✕';
    close.addEventListener('click', () => card.remove());
    card.appendChild(close);
    draftsEl.insertBefore(card, draftsEl.firstChild);
  }

  function draftCard(it) {
    const income = it.type === 'income';
    const card = document.createElement('div');
    card.className = 'm-draft';
    const head = document.createElement('div');
    head.className = 'm-draft-head';
    const title = document.createElement('b');
    title.textContent = it.merchant || it.note || (income ? '一笔收入' : '一笔支出');
    const amt = document.createElement('span');
    amt.className = 'amt ' + (income ? 'income' : 'expense');
    amt.textContent = (income ? '+' : '−') + fmt(it.amount_cents);
    head.appendChild(title);
    head.appendChild(amt);
    card.appendChild(head);

    const sub = document.createElement('div');
    sub.className = 'm-draft-sub';
    sub.textContent = [
      it.category_path || '未分类',
      it.txn_date || '',
    ].filter(Boolean).join(' · ');
    card.appendChild(sub);

    // 账户一律用下拉（可改）：默认选中习惯推荐/识别出的账户，没有则第一项——
    // 只读地显示「（按习惯推荐）」而不给名字与改法，用户没法判断该不该确认（维护者反馈）
    const accs = (() => { try { return JSON.parse((document.getElementById('mAccounts') || {}).textContent || '[]'); } catch { return []; } })();
    let accountSel = null;
    if (accs.length) {
      const accRow = document.createElement('div');
      accRow.className = 'm-draft-acc-row';
      const label = document.createElement('span');
      label.textContent = '账户';
      accRow.appendChild(label);
      accountSel = document.createElement('select');
      accountSel.className = 'm-draft-acc';
      // 推荐的账户不在可选清单（如已归档）时补一个原生选项，推荐值不被静默换掉
      const options = accs.slice();
      if (it.account_id && !options.some((a) => Number(a.id) === Number(it.account_id))) {
        options.unshift({ id: it.account_id, name: it.account_name_resolved || '账户 #' + it.account_id });
      }
      for (const a of options) {
        const o = document.createElement('option');
        o.value = a.id;
        o.textContent = (a.icon ? a.icon + ' ' : '') + a.name;
        if (it.account_id && Number(a.id) === Number(it.account_id)) o.selected = true;
        accountSel.appendChild(o);
      }
      accRow.appendChild(accountSel);
      if (it.account_recommended) {
        const hint = document.createElement('span');
        hint.className = 'm-draft-hint';
        hint.textContent = '按习惯推荐，可改';
        accRow.appendChild(hint);
      }
      card.appendChild(accRow);
    } else {
      // 账本没有可用账户：静态行如实显示（确认时服务端必填校验会拦）
      const accLine = document.createElement('div');
      accLine.className = 'm-draft-sub';
      accLine.textContent = '账户：' + (it.account_name_resolved || '未指定');
      card.appendChild(accLine);
    }

    const ops = document.createElement('div');
    ops.className = 'm-draft-ops';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn btn-sm btn-primary';
    ok.textContent = '确认入库';
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'btn btn-sm btn-ghost';
    no.textContent = '放弃';
    ops.appendChild(ok);
    ops.appendChild(no);
    card.appendChild(ops);

    no.addEventListener('click', () => card.remove());
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      ok.textContent = '入库中…';
      try {
        const item = { ...it };
        if (accountSel) item.account_id = Number(accountSel.value);
        const res = await fetch('/api/ai/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, Accept: 'application/json' },
          body: JSON.stringify({
            items: [item],
            image_ids: card._imageIds || [],
            source: 'ai_screenshot',
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok && data.created > 0) {
          card.className = 'm-draft done';
          ops.innerHTML = '';
          const done = document.createElement('span');
          done.className = 'm-draft-done';
          done.textContent = '✓ 已入账，即将刷新';
          ops.appendChild(done);
          setTimeout(() => location.reload(), 700);
        } else {
          ok.disabled = false;
          ok.textContent = '重试';
          say('warn', (data && (data.errors || [])[0]) || '入库失败，请重试');
        }
      } catch (e) {
        ok.disabled = false;
        ok.textContent = '重试';
        say('warn', '网络异常：' + e.message);
      }
    });
    return card;
  }

  function renderDrafts(data, imageIds) {
    // 附件按「数量一致一一对应」的既有约定挂到对应草稿；数量不一致时只有第一张卡携带，
    // 其余不带——服务端约定是全挂第一笔，多卡都带会让后确认的把附件抢走
    data.items.forEach((it, idx) => {
      const card = draftCard(it);
      card._imageIds = data.items.length === (imageIds || []).length ? [imageIds[idx]].filter(Boolean) : (idx === 0 ? (imageIds || []).slice(0, 1) : []);
      draftsEl.insertBefore(card, draftsEl.firstChild);
    });
  }
})();
