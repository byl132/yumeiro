// 聊天首页（参考 Cindy 的首页）：没有对话时，输入框直接放在页面中央、品牌标识下面，建议做成竖排列表；
// 工作区放进左侧栏（文件夹 + 最近的协作任务），点一下就进入。
(() => {
  const $ = s => document.querySelector(s);
  let hero = false, brand = null, composerWrap = null, main = null;

  // ---------- 1. 首页输入框居中 ----------
  function nameOfUser() { const t = ($('#userEmail')?.textContent || '').trim(); return (t.split('@')[0] || '').trim(); }
  function enterHero(welcome) {
    if (hero) return; hero = true;
    composerWrap = $('.composer-wrap'); main = $('.main'); if (!composerWrap || !main) { hero = false; return; }
    welcome.classList.add('home-hero'); document.body.classList.add('home-hero-on');
    brand = document.createElement('div'); brand.className = 'hero-brand';
    const mark = document.createElement('img'); mark.src = '/mascot.png'; mark.alt = ''; mark.onerror = () => { const m = document.createElement('div'); m.className = 'brand-mark'; m.textContent = 'Y'; mark.replaceWith(m); };
    const word = document.createElement('span'); word.className = 'hero-word'; word.textContent = 'Yumeiro';
    brand.append(mark, word);
    const sug = welcome.querySelector('.suggestions');
    welcome.insertBefore(brand, welcome.firstChild);
    welcome.insertBefore(composerWrap, sug || null);
    const ta = $('#prompt'); if (ta) { ta.dataset.oldPlaceholder = ta.placeholder; const n = nameOfUser(); ta.placeholder = '你好' + (n ? '，' + n : '') + '！今天想一起处理什么？'; }
  }
  function leaveHero() {
    if (!hero) return; hero = false;
    document.body.classList.remove('home-hero-on'); $('#welcome')?.classList.remove('home-hero');
    brand?.remove(); brand = null;
    if (composerWrap && main) main.append(composerWrap);
    const ta = $('#prompt'); if (ta && ta.dataset.oldPlaceholder) ta.placeholder = ta.dataset.oldPlaceholder;
  }
  function syncHero() { const w = $('#welcome'); if (!w || $('#app')?.hidden) return; w.hidden ? leaveHero() : enterHero(w); }
  function watchWelcome() {
    const w = $('#welcome'); if (!w) return false;
    new MutationObserver(syncHero).observe(w, { attributes: true, attributeFilter: ['hidden'] });
    new MutationObserver(syncHero).observe($('#app'), { attributes: true, attributeFilter: ['hidden'] });
    syncHero(); return true;
  }

  // ---------- 2. 左侧栏：工作区（文件夹 + 最近任务）----------
  const ago = at => { const m = Math.max(0, Math.round((Date.now() - at) / 60000)); return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟' : m < 1440 ? Math.round(m / 60) + ' 小时' : Math.round(m / 1440) + ' 天'; };
  let box = null, list = null, openIds = new Set(JSON.parse(localStorage.getItem('ym.sbOpen') || '[]'));
  const saveOpen = () => { try { localStorage.setItem('ym.sbOpen', JSON.stringify([...openIds])); } catch { /* 忽略 */ } };
  function mountSidebar() {
    if (box) return true;
    const chatList = $('#chatList'); if (!chatList) return false;
    box = document.createElement('div'); box.className = 'sb-ws';
    const head = document.createElement('div'); head.className = 'sb-ws-head';
    const label = document.createElement('span'); label.className = 'label'; label.textContent = '工作区';
    const add = document.createElement('button'); add.type = 'button'; add.className = 'sb-ws-add'; add.title = '新建工作区'; add.setAttribute('aria-label', '新建工作区'); add.textContent = '＋';
    add.addEventListener('click', () => window.YumeiroWS?.create(() => loadWorkspaces(true)));
    head.append(label, add);
    list = document.createElement('div'); list.className = 'sb-ws-list';
    box.append(head, list);
    chatList.after(box); return true;
  }
  let lastLoad = 0;
  async function loadWorkspaces(force) {
    if ($('#app')?.hidden || !mountSidebar()) return;
    if (force !== true && Date.now() - lastLoad < 15000) return; lastLoad = Date.now();
    let data; try { const r = await fetch('/api/workspaces', { credentials: 'same-origin' }); if (!r.ok) return; data = await r.json(); } catch { return; }
    const items = (data.workspaces || []).sort((a, b) => ((b.recent?.[0]?.createdAt) || b.createdAt) - ((a.recent?.[0]?.createdAt) || a.createdAt)).slice(0, 8);
    list.replaceChildren();
    if (!items.length) { const e = document.createElement('button'); e.type = 'button'; e.className = 'sb-ws-empty sb-link'; e.textContent = '＋ 新建一个工作区'; e.addEventListener('click', () => window.YumeiroWS?.create(() => loadWorkspaces(true))); list.append(e); return; }
    for (const w of items) {
      const open = openIds.has(w.id), runs = w.recent || [];
      const row = document.createElement('button'); row.type = 'button'; row.className = 'sb-ws-row' + (open ? ' open' : '');
      const caret = document.createElement('span'); caret.className = 'sb-caret'; caret.textContent = open ? '▾' : '▸';
      const ico = document.createElement('span'); ico.textContent = open ? '📂' : '📁';
      const name = document.createElement('span'); name.className = 'sb-ws-name'; name.textContent = w.name; name.title = w.name;
      const gear = document.createElement('span'); gear.className = 'sb-gear'; gear.title = '工作区设置'; gear.setAttribute('role', 'button'); gear.setAttribute('aria-label', '工作区设置'); gear.textContent = '⚙';
      gear.addEventListener('click', e => { e.stopPropagation(); window.YumeiroWS?.settings(w, () => loadWorkspaces(true)); });
      row.append(caret, ico, name, gear);
      row.addEventListener('click', () => { open ? openIds.delete(w.id) : openIds.add(w.id); saveOpen(); loadWorkspaces(true); });
      row.addEventListener('dblclick', () => window.YumeiroWS?.open(w, data.runner));
      list.append(row);
      if (open) {
        const sub = document.createElement('div'); sub.className = 'sb-runs';
        const enter = document.createElement('button'); enter.type = 'button'; enter.className = 'sb-run sb-enter'; enter.textContent = '打开工作区 ›'; enter.addEventListener('click', () => window.YumeiroWS?.open(w, data.runner));
        sub.append(enter);
        for (const r of runs.slice(0, 3)) {
          const a = document.createElement('button'); a.type = 'button'; a.className = 'sb-run'; a.addEventListener('click', () => window.YumeiroWS?.open(w, data.runner, 'tasks'));
          const t = document.createElement('span'); t.className = 'sb-run-t'; t.textContent = r.task;
          const tm = document.createElement('span'); tm.className = 'sb-run-time'; tm.textContent = ago(r.createdAt);
          a.append(t, tm); sub.append(a);
        }
        if (!runs.length) { const e = document.createElement('div'); e.className = 'sb-ws-empty'; e.textContent = '还没有协作任务'; sub.append(e); }
        list.append(sub);
      }
    }
  }

  let tries = 0;
  const timer = setInterval(() => { const ok = watchWelcome(); mountSidebar(); if (ok || ++tries > 200) clearInterval(timer); }, 400);
  new MutationObserver(() => { if (!$('#app')?.hidden) loadWorkspaces(); }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['hidden'] });
  setInterval(() => { if (!document.hidden) loadWorkspaces(); }, 60000);
  addEventListener('focus', loadWorkspaces);
  window.addEventListener('yumeiro:reply-done', loadWorkspaces);
  window.addEventListener('yumeiro:workspaces-changed', () => loadWorkspaces(true));
  // 账号菜单里的“工作区”：打开侧栏（手机上是抽屉）并展开工作区区块
  window.addEventListener('yumeiro:open-workspaces', () => { $('#app')?.classList.add('menu-open'); loadWorkspaces(true); box?.scrollIntoView({ block: 'nearest' }); });
})();
