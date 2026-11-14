// 远程控制（自己的 Windows / Mac 电脑）：配对码、输入事件校验。纯函数，便于测试。
import { randomInt } from 'node:crypto';

export const REMOTE_LIMITS = { pairTtlMs: 10 * 60 * 1000, maxDevices: 10, maxEventsPerBatch: 40, maxTextChars: 200, frameMaxBytes: 4 * 1048576, viewerIdleMs: 20000, offlineMs: 45000, queueMax: 200, eventsPerSecond: 120 };
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉容易看错的 I O 0 1
export function newPairCode() { let out = ''; for (let i = 0; i < 8; i++) out += ALPHABET[randomInt(ALPHABET.length)]; return out.slice(0, 4) + '-' + out.slice(4); }
export const normalizePairCode = input => { const raw = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return raw.length === 8 ? raw.slice(0, 4) + '-' + raw.slice(4) : ''; };

const BUTTONS = new Set(['left', 'right', 'middle']);
const MODS = ['ctrl', 'alt', 'shift', 'meta'];
const NAMED_KEYS = new Set(['enter', 'escape', 'tab', 'backspace', 'delete', 'space', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'insert', 'capslock', 'meta', ...Array.from({ length: 12 }, (_, i) => 'f' + (i + 1))]);
const unit = value => { const n = Number(value); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null; };
const fail = message => Object.assign(new Error(message), { status: 400 });

// 把浏览器发来的事件整理成统一格式；任何不认识的内容都直接拒绝
export function cleanInputEvents(events, { max = REMOTE_LIMITS.maxEventsPerBatch } = {}) {
  if (!Array.isArray(events) || !events.length) throw fail('没有操作');
  if (events.length > max) throw fail('一次最多 ' + max + ' 个操作');
  return events.map(event => {
    const type = String(event?.type || '');
    if (type === 'move') { const x = unit(event.x), y = unit(event.y); if (x === null || y === null) throw fail('坐标不合法'); return { type, x, y }; }
    if (type === 'down' || type === 'up' || type === 'click') {
      const button = BUTTONS.has(event.button) ? event.button : 'left', x = unit(event.x), y = unit(event.y);
      if ((type === 'click' && (x === null || y === null)) || (event.x !== undefined && x === null) || (event.y !== undefined && y === null)) throw fail('坐标不合法');
      return { type, button, ...(x !== null ? { x, y } : {}), ...(type === 'click' ? { count: event.count === 2 ? 2 : 1 } : {}) };
    }
    if (type === 'wheel') { const dy = Math.max(-20, Math.min(20, Math.trunc(Number(event.dy) || 0))), dx = Math.max(-20, Math.min(20, Math.trunc(Number(event.dx) || 0))); return { type, dx, dy }; }
    if (type === 'key') {
      const key = String(event.key || ''), name = key.length === 1 ? key : key.toLowerCase();
      if (!(NAMED_KEYS.has(name) || (key.length === 1 && /^[\x20-\x7e]$/.test(key)))) throw fail('不支持的按键：' + key.slice(0, 20));
      const action = event.action === 'down' || event.action === 'up' ? event.action : 'press';
      return { type, key: key.length === 1 ? key : name, action, mods: MODS.filter(mod => Array.isArray(event.mods) && event.mods.includes(mod)) };
    }
    if (type === 'text') {
      const text = String(event.text ?? '');
      if (!text || text.length > REMOTE_LIMITS.maxTextChars || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw fail('文字为空、太长或含控制字符');
      return { type, text };
    }
    throw fail('不支持的操作类型');
  });
}
export const countEvents = events => ({ events: events.length, keys: events.filter(e => e.type === 'key').length, textChars: events.filter(e => e.type === 'text').reduce((sum, e) => sum + e.text.length, 0), clicks: events.filter(e => e.type === 'click' || e.type === 'down').length });

export const isJpeg = buffer => Buffer.isBuffer(buffer) && buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
export const OS_LABELS = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
export const cleanDeviceName = value => String(value || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);

// 要显示给用户的被控端安装命令
export function agentCommands(origin, code, { control = true } = {}) {
  const flag = control ? ' --allow-control' : ' --view-only';
  return {
    windows: `# 在要被控制的 Windows 电脑上，打开 PowerShell（需先安装 Node.js 18+）\niwr ${origin}/remote/agent.mjs -OutFile agent.mjs\nnode agent.mjs --server ${origin} --code ${code}${flag}`,
    mac: `# 在要被控制的 Mac 上，打开“终端”（需先安装 Node.js 18+）\ncurl -fsSLO ${origin}/remote/agent.mjs\nnode agent.mjs --server ${origin} --code ${code}${flag}`
  };
}
