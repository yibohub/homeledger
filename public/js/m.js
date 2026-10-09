/* ============================================================
   家账簿 · 手机极简模式（P10 阶段 1）—— Tab1 捕获区
   悬浮球的全屏形态：语音 / 拍账单 / 文字 → 草稿卡片 → 确认入库。
   依赖 layout-m.ejs 的 #mCapture 结构与 meta[name=csrf]。
   ============================================================ */
'use strict';
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
  camBtn.addEventListener('click', () => fileEl.click());
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
  if (micBtn && SR) {
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
        if (e.error !== 'no-speech' && e.error !== 'aborted') say('warn', '语音识别失败（' + e.error + '），可以直接输入');
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
  async function recognize() {
    if (busy) return;
    const text = textEl.value.trim();
    if (!text && !pendingImages.length) return;
    busy = true;
    goBtn.disabled = true;
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
    }
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

    // 草稿没带账户（规则引擎常见）→ 账户下拉默认第一项，绝不能让「确认入库」卡死
    let accountSel = null;
    if (!it.account_id) {
      const accs = (() => { try { return JSON.parse((document.getElementById('mAccounts') || {}).textContent || '[]'); } catch { return []; } })();
      if (accs.length) {
        accountSel = document.createElement('select');
        accountSel.className = 'm-draft-acc';
        for (const a of accs) {
          const o = document.createElement('option');
          o.value = a.id;
          o.textContent = (a.icon || '') + ' ' + a.name;
          accountSel.appendChild(o);
        }
        card.appendChild(accountSel);
      }
    } else {
      const accLine = document.createElement('div');
      accLine.className = 'm-draft-sub';
      accLine.textContent = '账户：' + (it.account_name_resolved || '') + (it.account_recommended ? '（按习惯推荐）' : '');
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
