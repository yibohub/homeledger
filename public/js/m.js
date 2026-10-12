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
  var scale0 = 1; // 基准对应的本页干净态 scale（ArkWeb 常态 0.96 且页面间漂移，捏合判定用相对值不用魔数）
  var open = false;
  var pend = 0; // 高度稳定去抖句柄
  var stillCount = 0, lastH = -1; // 高度连续稳定采样计数（向下修正用）

  // 键盘高度变化有两种上报形态：resizes-visual 只改 vv.height、resizes-content 连
  // innerHeight 一起改（个别内核只改 innerHeight）——取两者最小值，两种形态都检测得到
  function vh() {
    return Math.min(vv.height, window.innerHeight || vv.height);
  }
  function editableFocused() {
    var ae = document.activeElement;
    return !!(ae && /^(TEXTAREA|INPUT)$/.test(ae.tagName));
  }
  function apply() {
    var h = vh();
    // 缩掉 >25% 视为键盘弹出。捏合放大在任何内核上都只有视觉视口缩（vv≪ih）且 scale
    // 相对本页干净态明显变大——双条件排除；键盘则按内核形态二选一：resizes-content
    // （ArkWeb/安卓系）ih 一起缩 → ratio≈1；resizes-visual（iOS）ih 不变 → ratio 小但
    // scale 不变（≤干净态 ×1.05）。地址栏收展只有 ~8% 不误触。不绑 focus/blur：点
    // 「识别」时焦点转移先关键盘，布局抖动可能吞掉这次点击
    var ratio = vv.height / (window.innerHeight || vv.height);
    var now = base > 0 && h < base * 0.75
      && (ratio > 0.85 || (vv.scale || 1) <= scale0 * 1.05);
    if (h > base) {
      base = h; // 干净高度（不小于现基线）随时可学；键盘开着的载入学小了，收起即自愈
      scale0 = vv.scale || scale0 || 1;
    }
    // 向下修正：键盘必伴随输入焦点——焦点不在输入框且高度连续稳定时，小高度不是键盘
    // 而是屏高估计偏差（分屏/浮窗下 screen 报全屏物理高），base 允许落回实测值
    // （monotonic-up 只能向上修，估计偏大时无此修正会整会话常开——评审 P2）
    if (h === lastH) stillCount++; else stillCount = 0;
    lastH = h;
    if (!editableFocused() && h < base && stillCount >= 3) base = h;
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
  // 真机排查浮窗（kb-diag 页一键开关，localStorage 跨页面跟随）：
  // 实时显示 h/base/open/scale，页面间对比即可定位「哪一页基准学歪了」
  if (function () { try { return localStorage.getItem('kb_debug') === '1'; } catch { return false; } }()) {
    var chip = document.createElement('div');
    chip.style.cssText = 'position:fixed;top:2px;right:2px;z-index:9999;background:rgba(0,0,0,.72);color:#0f0;font:10px/1.4 monospace;padding:2px 5px;border-radius:4px;pointer-events:none;white-space:pre';
    document.body.appendChild(chip);
    setInterval(function () {
      chip.textContent = 'path ' + location.pathname.slice(0, 12) + '\nh ' + Math.round(vh()) + ' base ' + Math.round(base) + '\nopen ' + (open ? 1 : 0) + ' scale ' + (vv.scale || 1).toFixed(2);
    }, 300);
  }
  // 旋转：基线换方向重学（matchMedia 事件替代已废弃的 orientationchange）。
  // 焦点在输入框才用屏高上界（键盘大概率还开着）；否则置 0 学实测高度——横屏 chrome
  // 占比高（三星 Internet 类），无条件屏高上界会让判定线高于干净高度、整会话常开（评审 P2）
  var omq = mq('(orientation: portrait)');
  var screenH = (window.screen && Number(window.screen.height)) || 0;
  var onTurn = function () { base = (editableFocused() && screenH) ? Math.round(window.screen.height * 0.9) : 0; };
  if (omq.addEventListener) omq.addEventListener('change', onTurn);
  else if (omq.addListener) omq.addListener(onTurn);
  // 初始基线：载入时焦点已在输入框（浏览器跨页保留键盘/刷新后键盘还在）→ 当前高度
  // 就是键盘态，学进来整会话避让失效（真机浮窗实锤 h=base=308=open0）——改用屏高 90%
  // 做安全上界：键盘态（308/368）必然低于其 75% 判定线（654×0.75≈490）即开即判，
  // 收起后的真实全高（579）高于判定线不误判；无焦点则用当前高度。
  // 屏高上界的偏差方向是「常开」：分屏/浮窗下 screen 报全屏物理高、判定线可能高于
  // 真实窗口高度——由上方向下修正落回实测（monotonic-up 只管向上，不覆盖此向）
  base = (editableFocused() && screenH) ? Math.round(window.screen.height * 0.9) : vh();
  apply();
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
  // 点输入框开始新一轮输入即清掉问账回答卡（维护者反馈 2026-10-12：连续问账后卡堆
  // 撑高捕获区，键盘弹出居中被顶出视口，看不到正在输入的文本）——输入时视野干净，
  // 堆积也不会发生（每次提问必先点输入框）；草稿卡 .m-draft 是待确认数据，绝不清
  textEl.addEventListener('focus', () => {
    draftsEl.querySelectorAll('.m-answer').forEach((c) => c.remove());
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
        say('warn', '没有识别到内容，试试「午饭 35 元」或拍一张账单'
          + (Array.isArray(data.warnings) && data.warnings.length ? '（' + data.warnings.join('；') + '）' : ''));
      } else {
        // 警示（如敏感分流的「未发送至模型服务」）必须让草稿卡带着：say 会持续到下一次
        // 识别（clearSay 在提交时才清），草稿停在页面上多久提示就在多久
        if (Array.isArray(data.warnings) && data.warnings.length) {
          say('warn', '⚠ ' + data.warnings.join('；'));
        }
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

  // 草稿卡可编辑字段（对齐桌面卡，维护者反馈：只有账户可改不够，备注还不展示）。
  // 分类候选由服务端注入 mCats（id/path/kind），归属人候选 mFamily（datalist）
  function fieldRow(labelText, inputEl) {
    const row = document.createElement('div');
    row.className = 'm-draft-acc-row';
    const label = document.createElement('span');
    label.textContent = labelText;
    row.appendChild(label);
    row.appendChild(inputEl);
    return row;
  }
  function draftCard(it, idx, total) {
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
    // 多笔识别时标序号/总数（数字标签嵌在头行，不占独立行；单笔不显示）。
    // insertBefore 的参照节点必须已在 head 内：先 append amt 再插 cnt（修「not a child of this node」）
    if (total > 1) {
      const cnt = document.createElement('span');
      cnt.className = 'm-draft-count';
      cnt.textContent = (idx + 1) + '/' + total;
      cnt.title = '共 ' + total + ' 笔草稿，逐张确认';
      head.insertBefore(cnt, amt);
    }
    card.appendChild(head);

    // 金额（可改）：数字键盘
    const amountIn = document.createElement('input');
    amountIn.type = 'number';
    amountIn.inputMode = 'decimal';
    amountIn.step = '0.01';
    amountIn.min = '0';
    amountIn.className = 'm-draft-acc';
    amountIn.value = (it.amount_cents / 100).toFixed(2);
    card.appendChild(fieldRow('金额', amountIn));

    // 日期（可改）
    const dateIn = document.createElement('input');
    dateIn.type = 'date';
    dateIn.className = 'm-draft-acc';
    dateIn.value = it.txn_date || '';
    card.appendChild(fieldRow('日期', dateIn));

    // 分类（可改下拉）：候选按收支类型过滤；推荐分类不在清单时补原生选项
    const cats = (() => { try { return JSON.parse((document.getElementById('mCats') || {}).textContent || '[]'); } catch { return []; } })();
    let catSel = null;
    if (cats.length) {
      catSel = document.createElement('select');
      catSel.className = 'm-draft-acc';
      const kind = income ? 'income' : 'expense';
      const options = cats.filter((c) => c.kind === kind).slice();
      if (it.category_id && !options.some((c) => Number(c.id) === Number(it.category_id))) {
        options.unshift({ id: it.category_id, path: it.category_path || '分类 #' + it.category_id });
      }
      for (const c of options) {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = c.path;
        if (it.category_id && Number(c.id) === Number(it.category_id)) o.selected = true;
        catSel.appendChild(o);
      }
      const catRow = fieldRow('分类' + (it.category_recommended ? '（推荐）' : ''), catSel);
      card.appendChild(catRow);
    }

    // 账户（可改下拉）：默认选中习惯推荐/识别出的账户，没有则第一项——
    // 只读地显示「（按习惯推荐）」而不给名字与改法，用户没法判断该不该确认（维护者反馈）
    const accs = (() => { try { return JSON.parse((document.getElementById('mAccounts') || {}).textContent || '[]'); } catch { return []; } })();
    let accountSel = null;
    if (accs.length) {
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
      const accRow = fieldRow('账户' + (it.account_recommended ? '（推荐）' : ''), accountSel);
      if (it.account_recommended) {
        const hint = document.createElement('span');
        hint.className = 'm-draft-hint';
        // 紧凑「习惯」标签：完整说明放 title（维护者反馈 2026-10-12：长文案挤压账户下拉框）
        hint.textContent = '习惯';
        hint.title = '按习惯推荐，可改';
        hint.style.padding = '1px 6px';
        hint.style.border = '1px solid currentColor';
        hint.style.borderRadius = '8px';
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

    // 商户（可改）：默认标题的来源，现在可以改
    const merchIn = document.createElement('input');
    merchIn.type = 'text';
    merchIn.className = 'm-draft-acc';
    merchIn.placeholder = '商家';
    merchIn.value = it.merchant || '';
    card.appendChild(fieldRow('商家', merchIn));

    // 备注（可改，必展示）：生产数据显示备注常是语义主体（「给红霞买社保」），不可见等于半透明确认
    const noteIn = document.createElement('input');
    noteIn.type = 'text';
    noteIn.className = 'm-draft-acc';
    noteIn.placeholder = '备注';
    noteIn.value = it.note || '';
    card.appendChild(fieldRow('备注', noteIn));

    // 归属人（P11，可改）：datalist 给候选（手动名单+沉淀），可输新名字
    const family = (window.__HL_FAMILY__ || []).slice();
    if (it.owner_label && !family.includes(it.owner_label)) family.unshift(it.owner_label);
    const ownerIn = document.createElement('input');
    ownerIn.type = 'text';
    ownerIn.className = 'm-draft-acc';
    ownerIn.setAttribute('list', 'm-owner-list-' + (it.draft_id || Math.random().toString(36).slice(2)));
    ownerIn.placeholder = '为谁花（可留空）';
    ownerIn.value = it.owner_label || '';
    const ownerRow = fieldRow('归属人' + (it.owner_recommended ? '（推荐）' : ''), ownerIn);
    const dl = document.createElement('datalist');
    dl.id = ownerIn.getAttribute('list');
    for (const name of family) {
      const o = document.createElement('option');
      o.value = name;
      dl.appendChild(o);
    }
    card.appendChild(dl);
    card.appendChild(ownerRow);

    // 一次性大额（P7 修订）：仅服务端判定为大额（no_rhythm_suggested=1）时才渲染，
    // 小额不出现、减少视觉噪音（维护者反馈 2026-10-12）；未渲染 = 不标记，统计层照常自动判
    let lumpyIn = null;
    if (it.no_rhythm_suggested) {
      const lumpyWrap = document.createElement('label');
      lumpyWrap.className = 'm-draft-sub';
      lumpyWrap.style.display = 'flex';
      lumpyWrap.style.alignItems = 'center';
      lumpyWrap.style.gap = '6px';
      lumpyIn = document.createElement('input');
      lumpyIn.type = 'checkbox';
      lumpyIn.className = 'm-lumpy';
      lumpyIn.checked = true;
      if (income || it.type === 'transfer') lumpyIn.disabled = true; // 收入/转账无节奏外推口径，勾选无意义
      lumpyIn.addEventListener('change', () => { it.__lumpyTouched = true; }); // 用户改过勾选，确认时不再按金额重算
      lumpyWrap.appendChild(lumpyIn);
      lumpyWrap.appendChild(document.createTextNode('一次性大额'));
      // 完整口径挪到悬停说明（维护者反馈 2026-10-12：括号内容太多，草稿卡要简单）
      lumpyWrap.title = '不计入月末预测节奏（按统计预勾）';
      card.appendChild(lumpyWrap);
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

    no.addEventListener('click', () => {
      card.remove(); advanceTop();
      if (!draftsEl.querySelector('.m-draft:not(.done)')) say('ok', '草稿已清空'); // 与确认路径对称（审查 P3-1）
    }); // 放弃同样推进到下一张
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      ok.textContent = '入库中…';
      try {
        const item = { ...it };
        // P12：先留一份识别时的推荐快照（在应用下面的编辑之前），确认时供服务端比对「推荐是否被改掉」
        item.rec_snapshot = { category_id: it.category_id, account_id: it.account_id, owner_label: it.owner_label || null, type: it.type };
        item.amount_cents = Math.round(Math.max(0, parseFloat(amountIn.value || '0') || 0) * 100);
        if (dateIn.value) item.txn_date = dateIn.value;
        if (catSel && catSel.value) item.category_id = Number(catSel.value);
        if (accountSel) item.account_id = Number(accountSel.value);
        item.merchant = merchIn.value.trim();
        item.note = noteIn.value.trim();
        item.owner_label = ownerIn.value.trim() || null;
        // 预勾与确认前改金额脱钩：没手动改过勾选时按当前金额重算（¥6000 改 ¥30 不该带着标记入库）
        if (lumpyIn && !it.__lumpyTouched && !income && it.type !== 'transfer' && it.no_rhythm_threshold) {
          lumpyIn.checked = item.amount_cents >= it.no_rhythm_threshold;
        }
        item.no_rhythm = lumpyIn && lumpyIn.checked ? 1 : 0;
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
          done.textContent = '✓ 已入账';
          ops.appendChild(done);
          // 逐卡确认不整页刷新（维护者定案 2026-10-12，修「确认一张冲走其余未确认卡」）：
          // 就地停留半秒给反馈 → 移除该卡 → 下一张自动居中；队列清空给完成提示，
          // 并条件性整页刷新让「最近 5 笔/本月收支」跟上——此刻已无未确认卡，无冲卡之虞
          setTimeout(() => {
            card.remove();
            const left = advanceTop();
            if (left > 0) {
              say('ok', '已入账，待确认 ' + left + ' 笔');
            } else {
              say('ok', '已全部入账，正在刷新…');
              setTimeout(() => location.reload(), 600);
            }
          }, 500);
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
    // 归属人候选（P11）：服务端 family 下发，存全局供草稿卡 datalist 用（不覆盖已存值）
    if (Array.isArray(data.family)) {
      window.__HL_FAMILY__ = Array.from(new Set([].concat(window.__HL_FAMILY__ || [], data.family)));
    }
    // 附件按「数量一致一一对应」的既有约定挂到对应草稿；数量不一致时只有第一张卡携带，
    // 其余不带——服务端约定是全挂第一笔，多卡都带会让后确认的把附件抢走
    // 正序组装后整组插到栈顶（维护者定案：首卡=第一条记录，与原文阅读顺序一致；
    // 旧 insertBefore 循环会把最后一条顶到最上、与原文反序）
    const frag = document.createDocumentFragment();
    data.items.forEach((it, idx) => {
      const card = draftCard(it, idx, data.items.length);
      card._imageIds = data.items.length === (imageIds || []).length ? [imageIds[idx]].filter(Boolean) : (idx === 0 ? (imageIds || []).slice(0, 1) : []);
      frag.appendChild(card);
    });
    // 首卡引用必须在 insertBefore 之前取——DOM 规范会把 fragment 子节点全部移入文档并清空
    // fragment，插完再读 frag.firstChild 恒为 null（审查 P1-1 实证，居中特性曾静默失效）
    const topCard = frag.firstChild;
    draftsEl.insertBefore(frag, draftsEl.firstChild);
    // 草稿卡生成在屏幕外（维护者反馈 2026-10-12）：渲染后自动居中首卡（第一条记录），
    // 一眼看到卡与「确认入库」、无需滚动
    if (topCard) requestAnimationFrame(() => topCard.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }

  // 确认/放弃移除一张卡后，自动把下一张未确认的顶到屏幕中央（维护者定案：逐卡确认自动推进）；
  // 返回剩余未确认张数（0 = 队列已清空）
  function advanceTop() {
    const rest = draftsEl.querySelectorAll('.m-draft:not(.done)');
    if (rest[0]) requestAnimationFrame(() => rest[0].scrollIntoView({ behavior: 'smooth', block: 'center' }));
    return rest.length;
  }
})();
