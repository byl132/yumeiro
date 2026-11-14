// 环境检测与封号风险评估：只做“检测、提示、在风险发生前拒绝”，不做任何规避平台风控的事。
// 纯函数 + 可注入 fetch，便于测试。
export const TARGETS = [
  { id: 'anthropic-api', vendor: 'claude', label: 'Claude API', url: 'https://api.anthropic.com/' },
  { id: 'claude-web', vendor: 'claude', label: 'claude.ai', url: 'https://claude.ai/' },
  { id: 'openai-api', vendor: 'codex', label: 'OpenAI API', url: 'https://api.openai.com/v1/models' },
  { id: 'chatgpt-web', vendor: 'codex', label: 'ChatGPT / Codex', url: 'https://chatgpt.com/' },
  { id: 'gemini-api', vendor: 'gemini', label: 'Gemini API', url: 'https://generativelanguage.googleapis.com/' },
  { id: 'gemini-web', vendor: 'gemini', label: 'Gemini 网页', url: 'https://gemini.google.com/' },
  { id: 'deepseek-api', vendor: 'deepseek', label: 'DeepSeek API', url: 'https://api.deepseek.com/' },
  { id: 'deepseek-web', vendor: 'deepseek', label: 'DeepSeek 网页', url: 'https://chat.deepseek.com/' }
];
// 每家服务商的检测规则：
//   regions  出口所在地区要在官方“支持的国家和地区”里（受限地区清单对它生效）
//   rate     订阅账号型引擎（Claude Code / Codex）：按小时调用量和并发限频，并提示多人共用账号的风险
//   account  出口是数据中心 IP 时给出“订阅账号登录可能被风控”的提醒
//   proxy    发往它的请求可以走“出口代理”。DeepSeek 是国内服务，不走代理（直连探测才反映真实可达性）
export const VENDORS = {
  claude: { name: 'Claude', regions: true, rate: true, account: true, proxy: true },
  codex: { name: 'Codex / ChatGPT', regions: true, rate: true, account: true, proxy: true },
  gemini: { name: 'Gemini', regions: true, rate: false, account: false, proxy: true },
  deepseek: { name: 'DeepSeek', regions: false, rate: false, account: false, proxy: false }
};
export const VENDOR_NAMES = Object.fromEntries(Object.entries(VENDORS).map(([id, v]) => [id, v.name]));
export const VENDOR_HOSTS = {
  claude: ['anthropic.com', 'claude.ai', 'claude.com'], codex: ['openai.com', 'chatgpt.com'],
  gemini: ['generativelanguage.googleapis.com', 'gemini.google.com', 'aistudio.google.com'], deepseek: ['deepseek.com']
};
export const usesProxy = vendor => Boolean(vendor && VENDORS[vendor]?.proxy);
// 参考清单（以各家官方“支持的国家和地区”页面为准，管理员可在页面里修改）
export const DEFAULT_RESTRICTED = ['CN', 'HK', 'MO', 'RU', 'BY', 'IR', 'KP', 'SY', 'CU'];
export const DEFAULT_GUARD = { enabled: true, restricted: DEFAULT_RESTRICTED, hourlyLimit: 40, maxConcurrent: 3, proxyUrl: '' };

export const vendorOfUrl = url => {
  let host = ''; try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  for (const [vendor, hosts] of Object.entries(VENDOR_HOSTS)) if (hosts.some(h => host === h || host.endsWith('.' + h))) return vendor;
  return null;
};
export const vendorOfEngine = engine => engine === 'claude' ? 'claude' : engine === 'codex' ? 'codex' : null;

export function normalizeGuard(input = {}) {
  const base = { ...DEFAULT_GUARD, ...input };
  const restricted = (Array.isArray(base.restricted) ? base.restricted : String(base.restricted || '').split(/[,\s，]+/))
    .map(code => String(code).trim().toUpperCase()).filter(code => /^[A-Z]{2}$/.test(code)).slice(0, 60);
  return {
    enabled: base.enabled !== false, restricted,
    hourlyLimit: Math.min(10000, Math.max(1, Math.floor(Number(base.hourlyLimit)) || DEFAULT_GUARD.hourlyLimit)),
    maxConcurrent: Math.min(50, Math.max(1, Math.floor(Number(base.maxConcurrent)) || DEFAULT_GUARD.maxConcurrent)),
    proxyUrl: validProxyUrl(base.proxyUrl) ? String(base.proxyUrl).trim() : ''
  };
}
export function validProxyUrl(value) {
  if (!value) return false;
  try { const url = new URL(String(value).trim()); return url.protocol === 'http:' || url.protocol === 'https:'; } catch { return false; }
}
export const maskProxy = value => { try { const url = new URL(value); if (url.username || url.password) { url.username = '***'; url.password = ''; } return url.toString(); } catch { return ''; } };

export function parseTrace(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) { const i = line.indexOf('='); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return { ip: out.ip || '', country: (out.loc || '').toUpperCase(), colo: out.colo || '' };
}

// 单个目标探测。任何 HTTP 响应都说明网络是通的；403/429 带拦截特征视为“被挑战/限流”。
export async function probeTarget(target, { fetchFn = fetch, timeoutMs = 8000 } = {}) {
  const started = Date.now();
  try {
    const response = await fetchFn(target.url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'Mozilla/5.0 (yumeiro-env-check)', Accept: '*/*' } });
    const ms = Date.now() - started, status = response.status;
    try { await response.body?.cancel(); } catch { /* 忽略 */ }
    const challenged = (status === 403 || status === 429) && (response.headers.get('cf-mitigated') === 'challenge' || /cloudflare/i.test(response.headers.get('server') || ''));
    return { id: target.id, vendor: target.vendor, label: target.label, reachable: true, status, ms, challenged: status === 429 || challenged, error: '' };
  } catch (error) {
    return { id: target.id, vendor: target.vendor, label: target.label, reachable: false, status: 0, ms: Date.now() - started, challenged: false, error: error?.cause?.code || error?.name === 'TimeoutError' ? (error?.cause?.code || '连接超时') : (error?.message || '失败') };
  }
}

export async function detectEgress({ fetchFn = fetch, timeoutMs = 6000, extended = true } = {}) {
  const result = { ip: '', country: '', colo: '', isp: '', hosting: null, proxy: null, error: '' };
  try {
    const response = await fetchFn('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(timeoutMs) });
    Object.assign(result, parseTrace(await response.text()));
  } catch (error) { result.error = error?.message || '无法获取出口信息'; }
  if (extended) try { // 补充运营商/是否数据中心（第三方免费接口 ip-api.com，会把服务器出口 IP 发给它；ENV_CHECK_EXTENDED=false 可关闭）
    const response = await fetchFn('http://ip-api.com/json/' + (result.ip || '') + '?fields=status,countryCode,isp,hosting,proxy', { signal: AbortSignal.timeout(timeoutMs) });
    const data = await response.json();
    if (data.status === 'success') { result.isp = data.isp || ''; result.hosting = Boolean(data.hosting); result.proxy = Boolean(data.proxy); if (!result.country) result.country = String(data.countryCode || '').toUpperCase(); }
  } catch { /* 忽略 */ }
  return result;
}

const rank = { ok: 0, warn: 1, danger: 2 };
const worst = (a, b) => rank[b] > rank[a] ? b : a;

// 综合评估。input: {egress, probes, guard, usage:{claude:{lastHour,concurrent,users24h}, codex:{...}}, regionHistory:[country...]}
export function evaluate({ egress, probes, guard, usage = {}, regionHistory = [] }) {
  const vendors = {};
  for (const vendor of Object.keys(VENDORS)) {
    const cfg = VENDORS[vendor], reasons = [], advice = []; let level = 'ok', block = false;
    const add = (lvl, reason, tip, blocking = false) => { level = worst(level, lvl); reasons.push({ level: lvl, text: reason }); if (tip) advice.push(tip); if (blocking) block = true; };
    const mine = probes.filter(p => p.vendor === vendor);
    const country = egress?.country || '';
    if (!cfg.regions) { /* 不受地区限制（如 DeepSeek） */ } else if (!country) add('warn', '无法确定出口所在地区', '检查服务器是否能访问 www.cloudflare.com；无法确认地区时请自行核对出口 IP。');
    else if (guard.restricted.includes(country)) add('danger', `出口 IP 位于 ${country}，该地区在“受限地区”清单中`, `${VENDOR_NAMES[vendor]} 官方不向该地区提供服务，继续使用可能导致账号被限制或封禁。请改用位于受支持地区的服务器/合规网络出口，或改用该地区合法可用的其他模型服务商。`, true);
    if (mine.length && mine.every(p => !p.reachable)) add('warn', `${VENDOR_NAMES[vendor]} 的所有端点都连不上（${mine[0].error || '超时'}）`, '先检查服务器网络、DNS 和防火墙；如果配置了出口代理，确认代理可用。');
    else for (const p of mine) {
      if (p.reachable && p.challenged) add('warn', `${p.label} 返回了风控挑战/限流（HTTP ${p.status}）`, '出口 IP 信誉可能偏低（如共享的数据中心 IP）。降低调用频率，换用稳定、独享的合规出口。');
      else if (p.reachable && p.ms > 2500) add('warn', `${p.label} 延迟较高（${p.ms} ms）`, '延迟高会让长任务超时，可考虑更近的服务器节点。');
    }
    if (cfg.account && egress?.hosting === true) add('warn', `出口是数据中心/托管 IP（${egress.isp || '未知运营商'}）`, '使用 API Key 通常没问题；若用 Claude Code / Codex 的“订阅账号登录”，数据中心 IP 更容易触发风控，建议登录与使用保持在同一稳定出口。');
    if (cfg.regions && egress?.proxy === true) add('warn', '出口被识别为代理/VPN', '共享代理 IP 信誉不稳定，建议使用独享、固定的出口。');
    const distinct = new Set(regionHistory.filter(Boolean));
    if (cfg.regions && distinct.size >= 3) add('warn', `过去 24 小时出口地区变化了 ${distinct.size} 个（${[...distinct].join('、')}）`, '频繁更换出口地区是常见的风控信号。请固定出口，不要来回切换。');
    const u = usage[vendor] || {};
    if (cfg.rate && u.users24h >= 2) add('warn', `过去 24 小时有 ${u.users24h} 个账号通过本站使用 ${VENDOR_NAMES[vendor]} 引擎`, '多人共用同一个个人订阅账号通常违反服务条款，被封风险高。建议每人使用自己的账号，团队使用请改用官方 API Key。');
    const limit = guard.hourlyLimit;
    if (!cfg.rate) { /* 只有订阅账号型引擎才按小时限频 */ } else if (u.lastHour >= limit) add('danger', `最近 1 小时已调用 ${u.lastHour} 次，达到上限 ${limit}`, '短时间大量调用容易触发限流或风控。已暂时拒绝新请求，等调用量回落后自动恢复；也可在“环境检测”里调高上限。', true);
    else if (u.lastHour >= limit * 0.7) add('warn', `最近 1 小时已调用 ${u.lastHour} 次，接近上限 ${limit}`, '放慢节奏，或把批量任务错开。');
    if (cfg.rate && u.concurrent >= guard.maxConcurrent) add('warn', `当前并发 ${u.concurrent}，已达并发上限 ${guard.maxConcurrent}`, '并发过高容易触发限流，超出的请求会排队/被拒绝。');
    if (level === 'ok') reasons.push({ level: 'ok', text: '未发现风险信号' });
    vendors[vendor] = { name: VENDOR_NAMES[vendor], engine: cfg.rate, level, block: guard.enabled && block, reasons, advice: [...new Set(advice)], probes: mine };
  }
  const level = Object.values(vendors).reduce((acc, v) => worst(acc, v.level), 'ok');
  return { at: Date.now(), level, egress, vendors };
}
