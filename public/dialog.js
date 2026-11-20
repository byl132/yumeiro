// 页面内弹窗：代替浏览器自带的 alert / confirm / prompt（样式跟随主题、手机上更好点、不会被浏览器拦截）。
//   await ymConfirm('确定删除？', { danger: true, okText: '删除' })      → true / false
//   await ymPrompt('新密码', '', { type: 'password' })                    → 字符串；取消返回 null
//   await ymForm('额度', [{ name: 'daily', label: '每日调用', type: 'number', value: 0 }])  → { daily: '0' } 或 null
  //   ymAlert('保存失败')                                                   → 点“知道了”后 resolve（可以不等待）
(() => {
  if (window.ymConfirm) return;
  const css = document.createElement('style');
  css.textContent = `
  .ymd-back{position:fixed;inset:0;z-index:2147483200;background:#10121a88;display:grid;place-items:center;padding:16px;animation:ymd-in .12s ease-out}
  .ymd-box{width:min(420px,100%);max-height:88vh;overflow:auto;background:var(--ym-card,#fff);color:var(--ink,#252832);border:1px solid var(--line,#e7e8ec);border-radius:16px;padding:20px 20px 16px;box-shadow:0 20px 60px #0006;font:14px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .ymd-title{font-size:16px;font-weight:650;margin:0 0 8px}
  .ymd-msg{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink,#252832)}
  .ymd-input{display:block;width:100%;box-sizing:border-box;margin-top:12px;height:42px;padding:0 12px;border:1px solid var(--line,#e7e8ec);border-radius:10px;background:transparent;color:inherit;font:inherit;font-size:16px}
  .ymd-input:focus{outline:3px solid #e951642e;border-color:#df9ca4}
  .ymd-field{display:grid;gap:4px;margin-top:12px}.ymd-field label{font-size:13px;font-weight:650}.ymd-field small{font-size:12px;color:var(--muted,#777b86)}
  .ymd-field .ymd-input{margin-top:0}.ymd-row2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .ymd-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
  .ymd-actions button{min-width:84px;min-height:40px;padding:0 16px;border-radius:10px;border:1px solid var(--line,#e7e8ec);background:transparent;color:inherit;font:inherit;cursor:pointer}
  .ymd-actions button.ok{background:var(--accent,#e95164);border-color:var(--accent,#e95164);color:#fff;font-weight:650}
  .ymd-actions button.danger{background:#d33a4a;border-color:#d33a4a}
  @keyframes ymd-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  @media(max-width:560px){.ymd-back{align-items:end;padding:10px}.ymd-box{border-radius:16px}.ymd-actions{flex-direction:column-reverse}.ymd-actions button{width:100%}}
  @media(prefers-reduced-motion:reduce){.ymd-back{animation:none}}`;
  document.head.append(css);
  const queue = []; let showing = false;
  function show(opts) { return new Promise(resolve => { queue.push({ opts, resolve }); if (!showing) next(); }); }
  function next() {
    const item = queue.shift(); if (!item) { showing = false; return; }
    showing = true;
    const { opts, resolve } = item, previous = document.activeElement;
    const back = document.createElement('div'); back.className = 'ymd-back';
    const box = document.createElement('div'); box.className = 'ymd-box'; box.setAttribute('role', opts.input ? 'dialog' : 'alertdialog'); box.setAttribute('aria-modal', 'true');
    const title = document.createElement('div'); title.className = 'ymd-title'; title.textContent = opts.title || (opts.input ? '请输入' : opts.cancel ? '请确认' : '提示'); box.setAttribute('aria-label', title.textContent);
    const msg = document.createElement('div'); msg.className = 'ymd-msg'; msg.textContent = String(opts.message ?? '');
    if (!msg.textContent) msg.style.display = 'none';
    box.append(title, msg);
    let input = null; const inputs = {};
    if (opts.fields) {
      let row = null;
      for (const f of opts.fields) {
        const wrap = document.createElement('div'); wrap.className = 'ymd-field';
        const label = document.createElement('label'); label.textContent = f.label;
        const el = document.createElement('input'); el.className = 'ymd-input'; el.type = f.type || 'text'; el.value = f.value ?? ''; el.autocomplete = 'off'; el.setAttribute('aria-label', f.label);
        if (f.min !== undefined) el.min = f.min; if (f.max !== undefined) el.max = f.max; if (f.step !== undefined) el.step = f.step; if (f.placeholder) el.placeholder = f.placeholder; if (f.type === 'number') el.inputMode = 'numeric';
        wrap.append(label, el); if (f.hint) { const h = document.createElement('small'); h.textContent = f.hint; wrap.append(h); }
        inputs[f.name] = el;
        if (f.half) { if (!row) { row = document.createElement('div'); row.className = 'ymd-row2'; box.append(row); } row.append(wrap); if (row.children.length === 2) row = null; } else { row = null; box.append(wrap); }
      }
      input = Object.values(inputs)[0];
    }
    if (opts.input) { input = document.createElement('input'); input.className = 'ymd-input'; input.type = opts.type || 'text'; input.value = opts.value ?? ''; input.autocomplete = 'off'; if (opts.placeholder) input.placeholder = opts.placeholder; box.append(input); }
    const actions = document.createElement('div'); actions.className = 'ymd-actions';
    const okBtn = document.createElement('button'); okBtn.type = 'button'; okBtn.className = 'ok' + (opts.danger ? ' danger' : ''); okBtn.textContent = opts.okText || (opts.cancel ? '确定' : '知道了');
    let cancelBtn = null;
    let extraBtn = null;
    if (opts.extra) { extraBtn = document.createElement('button'); extraBtn.type = 'button'; extraBtn.textContent = opts.extra.text; extraBtn.style.marginRight = 'auto'; actions.append(extraBtn); }
    if (opts.cancel) { cancelBtn = document.createElement('button'); cancelBtn.type = 'button'; cancelBtn.textContent = opts.cancelText || '取消'; actions.append(cancelBtn); }
    actions.append(okBtn); box.append(actions); back.append(box); document.body.append(back);
    let done = false;
    const finish = value => { if (done) return; done = true; back.remove(); removeEventListener('keydown', onKey, true); try { previous?.focus?.(); } catch { /* 忽略 */ } resolve(value); next(); };
    const collect = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
    const accept = () => { if (opts.fields) { const bad = (opts.fields.find(f => f.required && !String(inputs[f.name].value).trim())); if (bad) { inputs[bad.name].focus(); return; } return finish(collect()); } finish(opts.input ? input.value : true); }, reject = () => finish(opts.input || opts.fields ? null : false);
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); opts.cancel ? reject() : accept(); }
      else if (e.key === 'Enter' && !e.isComposing && (opts.input || opts.fields || document.activeElement === okBtn || document.activeElement === document.body)) { e.preventDefault(); e.stopPropagation(); accept(); }
      else if (e.key === 'Tab') { const f = [...box.querySelectorAll('input,button')]; const i = f.indexOf(document.activeElement); const to = e.shiftKey ? f[(i <= 0 ? f.length : i) - 1] : f[(i + 1) % f.length]; e.preventDefault(); to?.focus(); }
    }
    addEventListener('keydown', onKey, true);
    okBtn.addEventListener('click', accept); cancelBtn?.addEventListener('click', reject); extraBtn?.addEventListener('click', () => finish({ __extra: true }));
    back.addEventListener('pointerdown', e => { if (e.target === back && opts.cancel) reject(); });
    (input || (opts.danger && cancelBtn) || okBtn).focus(); input?.select?.();
  }
  window.ymConfirm = (message, o = {}) => show({ message, cancel: true, ...o });
  window.ymPrompt = (message, value = '', o = {}) => show({ message, input: true, cancel: true, value, ...o });
  // 多字段表单：fields = [{ name, label, type, value, min, hint, half, required }]；返回 { name: 字符串 }，取消返回 null；extra = { text } 的按钮返回 { __extra: true }
  window.ymForm = (title, fields, o = {}) => show({ title, message: o.message || '', fields, cancel: true, ...o });
  window.ymAlert = (message, o = {}) => show({ message, cancel: false, ...o });
})();
