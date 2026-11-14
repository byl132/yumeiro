// 登录入口：同一个页面按地址分成两个入口 —— “/” 成员登录，“/admin” 管理员登录。
// 外观、文案和提示都不同；服务器会校验账号角色和入口是否匹配（管理员不能从成员入口登录，成员也进不了管理入口）。
(() => {
  const $ = s => document.querySelector(s);
  const form = $('#loginForm');
  if (!form) return;
  const admin = /^\/admin(\/|$)/.test(location.pathname);
  document.body.dataset.portal = admin ? 'admin' : 'member';

  const el = (tag, props = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'class') node.className = v; else if (k === 'on') for (const [e, fn] of Object.entries(v)) node.addEventListener(e, fn); else if (v !== undefined && v !== null) node[k] = v; }
    node.append(...kids.flat().filter(x => x !== null && x !== undefined && x !== false));
    return node;
  };

  const style = el('style', {});
  style.textContent = `
    /* ---------- 通用 ---------- */
    .login-shell{position:relative;overflow:hidden}
    .login-card{position:relative;z-index:1}
    .portal-switch{display:flex;justify-content:space-between;gap:10px;margin-top:18px;font-size:12px}
    .portal-switch a{color:var(--muted);text-decoration:none}.portal-switch a:hover{color:var(--accent)}
    .portal-pw{position:relative}.portal-pw input{padding-right:48px;width:100%}
    .portal-eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);height:32px;padding:0 10px;border:0;background:none;color:var(--muted);font-size:12px}
    .portal-caps{min-height:16px;margin-top:6px;font-size:11px;color:#b87a00}
    .portal-notice{margin:0 0 18px;padding:10px 12px;border-radius:10px;font-size:12px;line-height:1.6}
    .portal-foot{margin-top:18px;font-size:11px;line-height:1.6}
    /* ---------- 成员入口：明亮、友好 ---------- */
    body[data-portal=member] .login-shell{background:radial-gradient(60% 50% at 15% 10%,#ffe3e8 0,transparent 70%),radial-gradient(55% 45% at 90% 85%,#e4e8ff 0,transparent 70%),#f7f7fa}
    body[data-portal=member] .login-card{width:min(440px,100%);padding:38px 36px;border-radius:24px;box-shadow:0 24px 70px #2b2f4a1c}
    body[data-portal=member] .portal-team{display:inline-block;margin-bottom:14px;padding:3px 11px;border-radius:99px;background:var(--accent-soft);color:var(--accent);font-size:11px;font-weight:650}
    body[data-portal=member] .portal-notice{background:#eef3ff;color:#34508a;border:1px solid #d9e4ff}
    body[data-portal=member] .portal-foot{color:#989ba4}
    /* ---------- 管理员入口：深色、克制、强调安全 ---------- */
    body[data-portal=admin] .login-shell{background:linear-gradient(#0e1016e6,#0e1016e6),repeating-linear-gradient(0deg,#ffffff08 0 1px,transparent 1px 38px),repeating-linear-gradient(90deg,#ffffff08 0 1px,transparent 1px 38px),#0e1016}
    body[data-portal=admin] .login-card{width:min(420px,100%);padding:34px;border-radius:16px;background:#161922;border:1px solid #2a2f3d;box-shadow:0 24px 80px #0008;color:#e8eaf0}
    body[data-portal=admin] .login-card h1,body[data-portal=admin] .brand-name{color:#fff}
    body[data-portal=admin] .sub,body[data-portal=admin] .portal-switch a,body[data-portal=admin] .portal-eye,body[data-portal=admin] .portal-foot{color:#8a90a2}
    body[data-portal=admin] .field label{color:#c9cdd8}
    body[data-portal=admin] .field input{background:#0f1218;border-color:#2a2f3d;color:#fff}
    body[data-portal=admin] .field input:focus{border-color:var(--accent);outline:none}
    body[data-portal=admin] .portal-shield{display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:#2a1519;color:#ff6b7d;border:1px solid #4a2128}
    body[data-portal=admin] .portal-warning{display:flex;gap:8px;margin:0 0 20px;padding:10px 12px;border-radius:10px;background:#2a1f10;border:1px solid #4d3a1b;color:#f0c987;font-size:12px;line-height:1.55}
    body[data-portal=admin] .portal-notice{background:#14213a;color:#9bb7ee;border:1px solid #22345a}
    body[data-portal=admin] .login-error{color:#ff7b8a}
    body[data-portal=admin] .security-note{display:none}
    @media(max-width:480px){body[data-portal=member] .login-card,body[data-portal=admin] .login-card{padding:26px 22px}}
  `;
  document.head.append(style);

  // ---- 文案与结构 ----
  const brand = $('.login-brand'), title = $('.login-card h1'), sub = $('.login-card .sub');
  const emailLabel = $('label[for=email]'), passwordInput = $('#password'), button = $('#loginButton');
  const note = $('.security-note');
  passwordInput.removeAttribute('minlength'); // 成员密码至少 12 位，管理员至少 16 位，长度由服务器校验，不在浏览器里卡
  passwordInput.placeholder = admin ? '管理员密码' : '你的密码';
  $('#email').placeholder = admin ? 'admin@example.com' : 'name@company.com';
  emailLabel.textContent = admin ? '管理员邮箱' : '邮箱';
  button.textContent = admin ? '登录管理后台' : '登录';

  const switchLink = el('div', { class: 'portal-switch' },
    admin ? el('a', { href: '/', textContent: '← 返回成员登录' }) : el('a', { href: '/admin', textContent: '管理员入口 →' }),
    admin ? el('span') : el('span', { style: 'color:#b0b3bd', textContent: '忘记密码？请联系管理员重置' }));

  // 标题只在登录页显示“登录”；登录进入工作空间后恢复成站点名（否则标签页会一直写着“管理员登录”）
  let siteName = '';
  const appRoot = $('#app');
  const loggedIn = () => Boolean(appRoot) && !appRoot.hidden;
  const workTitle = () => (siteName || 'Yumeiro') + ' · 私有工作空间';
  const setLoginTitle = text => { if (!loggedIn()) document.title = text; };
  if (appRoot) new MutationObserver(() => { if (loggedIn()) document.title = workTitle(); }).observe(appRoot, { attributes: true, attributeFilter: ['hidden'] });
  if (admin) {
    setLoginTitle('管理员登录 · Yumeiro');
    brand.replaceChildren(el('div', { class: 'portal-shield', innerHTML: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/></svg>' }), el('div', { class: 'brand-name', textContent: 'Yumeiro 管理后台' }));
    title.textContent = '管理员登录';
    sub.textContent = '成员与额度、AI 接入、智能体引擎、安全策略';
    form.insertBefore(el('div', { class: 'portal-warning' }, el('span', { textContent: '⚠' }), el('span', { id: 'portalWarning', textContent: '这是管理入口。所有登录尝试都会被记录，连续失败会被临时锁定。' })), $('.field'));
    if (note) note.remove();
  } else {
    title.textContent = '欢迎回来';
    sub.textContent = '登录后继续使用团队的 AI 工作空间';
    brand.after(el('span', { class: 'portal-team', id: 'portalTeam', textContent: '团队空间' }));
    if (note) { note.className = 'portal-foot'; note.textContent = '在网页里，你的对话只有你本人能看到。账号由团队管理员创建，暂不支持自助注册。'; }
  }
  const noticeBox = el('div', { class: 'portal-notice', hidden: true });
  form.insertBefore(noticeBox, admin ? form.querySelector('.portal-warning') : $('.field'));

  // 密码显示/隐藏 + 大写锁定提示
  const wrap = el('div', { class: 'portal-pw' });
  passwordInput.replaceWith(wrap); wrap.append(passwordInput);
  const eye = el('button', { type: 'button', class: 'portal-eye', textContent: '显示', on: { click: () => { const show = passwordInput.type === 'password'; passwordInput.type = show ? 'text' : 'password'; eye.textContent = show ? '隐藏' : '显示'; } } });
  const caps = el('div', { class: 'portal-caps' });
  wrap.append(eye); wrap.after(caps);
  passwordInput.addEventListener('keyup', e => { caps.textContent = e.getModifierState && e.getModifierState('CapsLock') ? '大写锁定已开启' : ''; });
  passwordInput.addEventListener('blur', () => { caps.textContent = ''; });
  $('#loginError').after(switchLink);

  // ---- 站点名称与公告（管理员在“站点设置”里配置；未登录也能读取）----
  fetch('/api/site', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null).then(site => {
    if (!site) return;
    const name = site.name || 'Yumeiro';
    siteName = site.name || '';
    if (loggedIn()) document.title = workTitle();
    if (!admin) {
      setLoginTitle(name + ' · 登录');
      const mark = $('.brand-name'); if (mark) mark.textContent = name;
      const team = $('#portalTeam'); if (team) team.textContent = site.name ? '团队空间' : '私有工作空间';
      sub.textContent = '登录后继续使用' + (site.name ? name + '的' : '团队的') + ' AI 工作空间';
    }
    if (site.notice) { noticeBox.textContent = site.notice; noticeBox.hidden = false; }
    if (admin && site.adminRestricted) { const w = $('#portalWarning'); if (w) w.textContent = '这是管理入口：登录受 IP 白名单限制，所有尝试都会被记录，连续失败会被临时锁定。'; }
  }).catch(() => {});
})();
