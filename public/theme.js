// 主题切换：自动（跟随系统）/ 浅色 / 深色。选择保存在浏览器本地，各页面共用。
(() => {
  const KEY = 'yumeiro.theme', MODES = ['auto', 'light', 'dark'], ICON = { auto: '◐', light: '☀', dark: '☾' }, NAME = { auto: '跟随系统', light: '浅色', dark: '深色' };
  const media = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  const get = () => { try { const v = localStorage.getItem(KEY); return MODES.includes(v) ? v : 'auto'; } catch { return 'auto'; } };
  const resolved = mode => mode === 'auto' ? (media && media.matches ? 'dark' : 'light') : mode;
  function apply(mode = get()) {
    document.documentElement.setAttribute('data-theme', resolved(mode));
    document.dispatchEvent(new CustomEvent('yumeiro-theme', { detail: { mode, theme: resolved(mode) } }));
    const button = document.getElementById('themeButton');
    if (button) { button.textContent = ICON[mode]; button.title = '主题：' + NAME[mode] + '（点击切换）'; button.setAttribute('aria-label', button.title); }
  }
  function set(mode) { try { localStorage.setItem(KEY, mode); } catch { /* 无痕模式 */ } apply(mode); }
  const next = () => MODES[(MODES.indexOf(get()) + 1) % MODES.length];
  if (media) media.addEventListener('change', () => { if (get() === 'auto') apply('auto'); });
  window.yumeiroTheme = { get, set, next, resolved: () => resolved(get()) };
  apply();

  function mount() {
    if (document.getElementById('themeButton')) return true;
    const anchor = document.getElementById('settings');
    if (!anchor) return false;
    const button = document.createElement('button');
    button.id = 'themeButton'; button.type = 'button'; button.className = 'icon-button';
    button.addEventListener('click', () => set(next()));
    anchor.before(button); apply();
    return true;
  }
  let tries = 0;
  const timer = setInterval(() => { if (mount() || ++tries > 100) clearInterval(timer); }, 400);
})();
