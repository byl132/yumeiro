// 登录页的“管理员忘记密码”：用恢复密钥，或用已登录的手机确认，来登录并改密码。
(() => {
  const el = (tag, props = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'on') for (const [e, f] of Object.entries(v)) node.addEventListener(e, f); else if (k === 'style') node.style.cssText = v; else if (k in node) node[k] = v; else node.setAttribute(k, v); }
    node.append(...kids.flat().filter(x => x != null && x !== false));
    return node;
  };
  const style = el('style', {}, `
    #ymRecover{position:fixed;inset:0;z-index:90;background:#000a;display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto}
    #ymRecover .box{width:min(460px,100%);background:#171a23;color:#e8e9ee;border:1px solid #2c2f3d;border-radius:18px;padding:20px;box-shadow:0 20px 60px #000a;font:14px/1.65 system-ui,"PingFang SC","Microsoft YaHei",sans-serif}
    #ymRecover h2{margin:0 0 4px;font-size:18px}#ymRecover .sub{color:#9a9eab;font-size:12.5px;margin-bottom:12px}
    #ymRecover .tabs{display:flex;gap:6px;margin:10px 0}#ymRecover .tabs button{flex:1;padding:8px;border-radius:10px;border:1px solid #2c2f3d;background:none;color:inherit;cursor:pointer;font:inherit}#ymRecover .tabs button.on{border-color:#e95164;color:#ff8a9a}
    #ymRecover label{display:block;margin:10px 0 4px;font-weight:600;font-size:13px}
    #ymRecover input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid #2c2f3d;background:#0f1117;color:inherit;font:inherit}
    #ymRecover .go{width:100%;margin-top:14px;padding:11px;border:0;border-radius:10px;background:#e95164;color:#fff;font:inherit;cursor:pointer}#ymRecover .go:disabled{opacity:.5}
    #ymRecover .ghost{background:none;border:1px solid #2c2f3d;color:inherit;border-radius:10px;padding:8px 12px;cursor:pointer;font:inherit}
    #ymRecover .err{color:#ff8a8a;min-height:1.3em;margin-top:8px;font-size:13px}#ymRecover .ok{color:#6fd6a6;margin-top:8px}
    #ymRecover .code{font:700 38px/1.2 ui-monospace,Consolas,monospace;letter-spacing:6px;text-align:center;color:#ff8a9a;margin:10px 0}
    #ymRecover .keybox{font:600 15px/1.7 ui-monospace,Consolas,monospace;background:#0f1117;border:1px dashed #e95164;border-radius:10px;padding:12px;word-break:break-all;margin:8px 0;user-select:all}
    #ymRecover ol{padding-left:20px;margin:8px 0;color:#c5c8d4}#ymRecoverLink{color:#ff8a9a;cursor:pointer;background:none;border:0;font:inherit;padding:0;text-decoration:underline}`);
  document.head.append(style);
  const api = async (path, options = {}) => {
    const response = await fetch(path, { ...options, headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '请求失败：' + response.status);
    return data;
  };
  const copy = async text => { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } };
  let layer = null, timer = 0;
  function close() { clearInterval(timer); layer?.remove(); layer = null; }
  function open() {
    close();
    const body = el('div'), tabKey = el('button', { type: 'button', class: 'on', textContent: '🔑 恢复密钥 Recovery key' }), tabPhone = el('button', { type: 'button', textContent: '📱 手机确认 Phone' });
    const show = which => { tabKey.classList.toggle('on', which === 'key'); tabPhone.classList.toggle('on', which === 'phone'); clearInterval(timer); body.replaceChildren(which === 'key' ? keyPane() : phonePane()); };
    tabKey.addEventListener('click', () => show('key')); tabPhone.addEventListener('click', () => show('phone'));
    layer = el('div', { id: 'ymRecover', role: 'dialog', 'aria-label': '管理员忘记密码', on: { click: e => { if (e.target === layer) close(); } } },
      el('div', { class: 'box' }, el('h2', { textContent: '管理员忘记密码 Forgot password' }), el('div', { class: 'sub', textContent: '只适用于管理员账号。成员忘记密码请联系管理员重置。' }), el('div', { class: 'tabs' }, tabKey, tabPhone), body,
        el('div', { style: 'margin-top:12px;text-align:right' }, el('button', { type: 'button', class: 'ghost', textContent: '关闭 Close', on: { click: close } }))));
    document.body.append(layer); show('key');
  }
  function passwordFields() {
    const p1 = el('input', { type: 'password', autocomplete: 'new-password', placeholder: '至少 16 个字符 / at least 16 characters' }), p2 = el('input', { type: 'password', autocomplete: 'new-password', placeholder: '再输入一次 / repeat' });
    return { p1, p2, nodes: [el('label', { textContent: '新密码 New password' }), p1, el('label', { textContent: '确认新密码 Confirm' }), p2], read() { if (p1.value !== p2.value) throw new Error('两次输入的密码不一致'); return p1.value; } };
  }
  function keyPane() {
    const email = el('input', { type: 'email', autocomplete: 'username', placeholder: 'admin@example.com' }), key = el('input', { type: 'text', autocomplete: 'off', placeholder: 'YMR-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX', spellcheck: false });
    const pw = passwordFields(), err = el('div', { class: 'err' }), out = el('div');
    const go = el('button', { type: 'button', class: 'go', textContent: '重置密码并登录 Reset & sign in', on: { click: async () => {
      err.textContent = ''; go.disabled = true;
      try {
        const r = await api('/api/auth/recover/key', { method: 'POST', body: JSON.stringify({ email: email.value, key: key.value, newPassword: pw.read() }) });
        out.replaceChildren(el('div', { class: 'ok', textContent: '✅ 密码已重置，已登录。旧的恢复密钥已作废，请保存下面这把新的（只显示这一次）：' }), el('div', { class: 'keybox', textContent: r.newRecoveryKey }),
          el('div', { style: 'display:flex;gap:8px' }, el('button', { type: 'button', class: 'ghost', textContent: '复制 Copy', on: { click: async e => { e.target.textContent = (await copy(r.newRecoveryKey)) ? '已复制 Copied' : '请手动复制'; } } }), el('button', { type: 'button', class: 'go', style: 'margin:0', textContent: '我已保存，进入 Continue', on: { click: () => { location.href = '/admin/settings?tab=security'; } } })));
        go.hidden = true;
      } catch (e) { err.textContent = e.message; go.disabled = false; }
    } } });
    return el('div', {}, el('div', { class: 'sub', textContent: '输入你在“管理设置 → 账号安全”里保存的恢复密钥，设置新密码。' }), el('label', { textContent: '管理员邮箱 Email' }), email, el('label', { textContent: '恢复密钥 Recovery key' }), key, ...pw.nodes, go, err, out);
  }
  function phonePane() {
    const email = el('input', { type: 'email', autocomplete: 'username', placeholder: 'admin@example.com' }), err = el('div', { class: 'err' }), area = el('div');
    const start = el('button', { type: 'button', class: 'go', textContent: '发起手机确认 Start', on: { click: async () => {
      err.textContent = ''; start.disabled = true;
      try { const r = await api('/api/auth/recover/phone/start', { method: 'POST', body: JSON.stringify({ email: email.value }) }); waitApproval(r); start.hidden = true; }
      catch (e) { err.textContent = e.message; start.disabled = false; }
    } } });
    function waitApproval(r) {
      const left = el('div', { class: 'sub', style: 'text-align:center' }), status = el('div', { class: 'sub', style: 'text-align:center', textContent: '等待手机批准… Waiting for approval…' });
      area.replaceChildren(el('div', { class: 'code', textContent: r.code.slice(0, 3) + ' ' + r.code.slice(3) }), left, status,
        el('ol', {}, el('li', { textContent: '在已登录管理员账号的手机（网页 / 安卓客户端）上打开：管理设置 → 账号安全 Security。' }), el('li', { textContent: '输入上面的 6 位验证码，点“批准 Approve”。' }), el('li', { textContent: '这台电脑会自动继续。' })));
      const end = r.expiresAt;
      timer = setInterval(async () => {
        const s = Math.max(0, Math.round((end - Date.now()) / 1000)); left.textContent = s ? '有效期还剩 ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : '已过期';
        try {
          const st = await api('/api/auth/recover/phone/status?id=' + encodeURIComponent(r.id));
          if (st.status === 'approved') { clearInterval(timer); approved(r.id); }
          else if (st.status === 'denied') { clearInterval(timer); status.textContent = '手机上拒绝了这次请求。'; status.style.color = '#ff8a8a'; start.hidden = false; start.disabled = false; }
          else if (st.status === 'expired' || st.status === 'unknown') { clearInterval(timer); status.textContent = '请求已过期，请重新发起。'; status.style.color = '#ff8a8a'; start.hidden = false; start.disabled = false; }
        } catch { /* 网络抖动，下一轮再试 */ }
      }, 2000);
    }
    function approved(id) {
      const pw = passwordFields(), e2 = el('div', { class: 'err' });
      const finish = async withPassword => {
        e2.textContent = '';
        try { await api('/api/auth/recover/phone/finish', { method: 'POST', body: JSON.stringify({ id, ...(withPassword ? { newPassword: pw.read() } : {}) }) }); location.href = '/admin/settings?tab=security'; }
        catch (e) { e2.textContent = e.message; }
      };
      area.replaceChildren(el('div', { class: 'ok', textContent: '✅ 手机已批准 Approved' }), el('button', { type: 'button', class: 'go', textContent: '直接登录 Sign in', on: { click: () => finish(false) } }),
        el('div', { class: 'sub', style: 'margin-top:14px', textContent: '或者顺便改密码 Or set a new password:' }), ...pw.nodes, el('button', { type: 'button', class: 'go', textContent: '改密码并登录 Change & sign in', on: { click: () => finish(true) } }), e2);
    }
    return el('div', {}, el('div', { class: 'sub', textContent: '如果你的手机还保持着管理员登录，可以用它确认“是我本人”，不需要记住密码或恢复密钥。' }), el('label', { textContent: '管理员邮箱 Email' }), email, start, err, area);
  }
  function mount() {
    const card = document.querySelector('.login-card');
    if (!card || card.querySelector('#ymRecoverLink')) return;
    const anchor = [...card.querySelectorAll('*')].reverse().find(node => node.children.length === 0 && /忘记密码/.test(node.textContent));
    const link = el('button', { id: 'ymRecoverLink', type: 'button', textContent: '管理员忘记密码？Admin forgot password?', on: { click: open } });
    const wrap = el('div', { style: 'margin-top:10px;text-align:center;font-size:13px' }, link);
    if (anchor && anchor.parentElement) anchor.parentElement.after(wrap); else card.append(wrap);
  }
  // 登录卡片是首页静态结构，脚本加载时已经存在；不监听整个 document，避免与其他模块的 DOM 观察器互相触发导致页面卡死。
  mount();
})();
