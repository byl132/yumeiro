// 沙箱执行：在断网的“沙箱”容器里运行命令 / 代码，供网页「运行代码」按钮和智能体的 exec 模式使用。
// 这里只有纯逻辑和进程控制，没有 HTTP；由 runner.mjs 的 /exec 接口调用。
import { spawn } from 'node:child_process';
import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { mkdir, writeFile, rm, readdir, lstat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 语言 → 解释器与脚本文件名。只列出这几种；要加语言就在这里加并确保镜像里装了解释器。
export const LANGUAGES = {
  python: { cmd: ['python3'], file: 'main.py', label: 'Python' },
  node: { cmd: ['node'], file: 'main.mjs', label: 'Node.js' },
  bash: { cmd: ['bash'], file: 'main.sh', label: 'Bash' }
};
export const LANGUAGE_ALIASES = { py: 'python', python3: 'python', js: 'node', javascript: 'node', mjs: 'node', nodejs: 'node', sh: 'bash', shell: 'bash', zsh: 'bash' };
export const normalizeLanguage = value => {
  const key = String(value || '').trim().toLowerCase();
  const name = LANGUAGE_ALIASES[key] || key;
  return LANGUAGES[name] ? name : null;
};

// ---- 短期令牌：运行器给智能体的 MCP 进程发一个只能在“某个工作区”里调用 /exec 的令牌，到期自动失效 ----
// 格式 exec.<工作区>.<到期时间(秒)>.<签名>；签名用运行器令牌做 HMAC。令牌不能用来访问文件接口或启动智能体。
const sign = (secret, workspace, exp) => createHmac('sha256', secret).update(`exec\n${workspace}\n${exp}`).digest('base64url');
export function mintExecToken(secret, workspace, ttlSec = 900, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttlSec;
  return `exec.${workspace}.${exp}.${sign(secret, workspace, exp)}`;
}
// 通过返回 { workspace }；不通过返回 null
export function verifyExecToken(secret, token, now = Date.now()) {
  const match = /^exec\.([a-z0-9][a-z0-9-]{0,63})\.(\d{9,12})\.([A-Za-z0-9_-]{20,64})$/.exec(String(token || ''));
  if (!match) return null;
  const [, workspace, exp, given] = match;
  if (Number(exp) * 1000 < now) return null;
  const want = Buffer.from(sign(secret, workspace, exp)), got = Buffer.from(given);
  return want.length === got.length && timingSafeEqual(want, got) ? { workspace } : null;
}

export const SANDBOX_LIMITS = { timeoutSec: 30, maxTimeoutSec: 120, maxOutputBytes: 64 * 1024, maxCodeBytes: 200 * 1024, cpuSec: 60, fileKB: 20480, openFiles: 256 };

const clip = (text, max) => {
  const buffer = Buffer.from(text, 'utf8');
  return buffer.length <= max ? { text, truncated: false } : { text: buffer.subarray(0, max).toString('utf8') + '\n…（输出过长，已截断）', truncated: true };
};

// 运行一段代码或一条命令。cwd 是工作区目录；代码文件放在系统临时目录里，不会弄脏工作区。
// 返回 { exitCode, signal, timedOut, stdout, stderr, truncated, durationMs }
export async function execSandboxed({ cwd, language, code, command, timeoutSec, maxOutputBytes, env = process.env, limits = SANDBOX_LIMITS }) {
  const timeoutMs = Math.min(Math.max(Number(timeoutSec) || limits.timeoutSec, 1), limits.maxTimeoutSec) * 1000;
  const outputCap = Math.min(Number(maxOutputBytes) || limits.maxOutputBytes, 1024 * 1024);
  let argv, scratch = '';
  if (command !== undefined && command !== null && String(command).trim()) {
    if (String(command).length > 20000) throw Object.assign(new Error('命令过长'), { status: 400 });
    argv = ['bash', '-c', String(command)];
  } else {
    const name = normalizeLanguage(language);
    if (!name) throw Object.assign(new Error('不支持的语言：' + language + '（支持 ' + Object.keys(LANGUAGES).join(' / ') + '）'), { status: 400 });
    const text = String(code ?? '');
    if (!text.trim()) throw Object.assign(new Error('代码为空'), { status: 400 });
    if (Buffer.byteLength(text) > limits.maxCodeBytes) throw Object.assign(new Error('代码过长'), { status: 400 });
    scratch = path.join(os.tmpdir(), 'sbx-' + randomBytes(8).toString('hex'));
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const spec = LANGUAGES[name], file = path.join(scratch, spec.file);
    await writeFile(file, text, { mode: 0o600 });
    argv = [...spec.cmd, file];
  }
  // ulimit：CPU 秒数、单个文件大小、打开文件数。内存和进程数由容器的 mem_limit / pids_limit 兜底。
  const guard = `ulimit -t ${limits.cpuSec}; ulimit -f ${limits.fileKB}; ulimit -n ${limits.openFiles}; exec "$@"`;
  const childEnv = { PATH: env.PATH, HOME: scratch || os.tmpdir(), LANG: 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' };
  const started = Date.now();
  return await new Promise(resolve => {
    const child = spawn('sh', ['-c', guard, 'sh', ...argv], { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '', stderr = '', total = 0, timedOut = false, over = false, done = false;
    const killTree = signal => { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* 已退出 */ } } };
    const timer = setTimeout(() => { timedOut = true; killTree('SIGKILL'); setTimeout(() => finish(null, 'SIGKILL'), 2000).unref(); }, timeoutMs); // 杀不掉（或管道被孙进程占着）时 2 秒后不再等
    const take = which => chunk => {
      total += chunk.length;
      if (total > outputCap * 4) { over = true; killTree('SIGKILL'); return; } // 疯狂刷屏：直接杀掉
      if (which === 'out' ? stdout.length < outputCap * 2 : stderr.length < outputCap * 2) { if (which === 'out') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8'); }
    };
    child.stdout.on('data', take('out'));
    child.stderr.on('data', take('err'));
    const finish = async (exitCode, signal, extraErr = '') => {
      if (done) return; done = true; clearTimeout(timer);
      killTree('SIGKILL'); // 把可能残留的子进程一并清掉
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
      const out = clip(stdout, outputCap), err = clip(stderr + extraErr, outputCap);
      resolve({ exitCode, signal: signal || null, timedOut, stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated || over, durationMs: Date.now() - started });
    };
    child.on('error', error => finish(null, null, '无法启动：' + error.message));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

// ---- 带文件的执行：沙箱容器不挂载任何卷，工作区文件由运行器通过请求送进来，改动再随结果送回去 ----
// 这样沙箱里的代码最多只能看到“这一个工作区的文件副本”，碰不到别的工作区、备份和密钥。

export const SYNC_LIMITS = { maxFiles: 2000, maxTotalBytes: 20 * 1024 * 1024 };
const sha1 = data => createHash('sha1').update(data).digest('hex');
const SAFE_REL = rel => typeof rel === 'string' && rel.length > 0 && rel.length < 400 && !rel.includes('\0') && !rel.startsWith('/') && !rel.includes('\\') && !rel.split('/').some(part => part === '' || part === '..' || part === '.');

async function listTree(base) {
  const out = [];
  async function walk(dir, prefix) {
    for (const name of await readdir(dir)) {
      const full = path.join(dir, name), info = await lstat(full).catch(() => null);
      if (!info) continue;
      const rel = prefix ? prefix + '/' + name : name;
      if (info.isDirectory()) await walk(full, rel);
      else if (info.isFile()) out.push({ path: rel, full, size: info.size });
      if (out.length > 20000) return;
    }
  }
  await walk(base, '');
  return out;
}

// files: [{path, data(base64)}]。返回 execSandboxed 的结果 + { written: [{path, data}], deleted: [path], changesTruncated }
export async function runWithFiles({ files = [], language, code, command, timeoutSec, maxOutputBytes, env = process.env, limits = SANDBOX_LIMITS, sync = SYNC_LIMITS }) {
  if (!Array.isArray(files) || files.length > sync.maxFiles) throw Object.assign(new Error('文件数量过多'), { status: 413 });
  const top = path.join(os.tmpdir(), 'sbxw-' + randomBytes(8).toString('hex')), ws = path.join(top, 'ws');
  await mkdir(ws, { recursive: true, mode: 0o700 });
  try {
    const before = new Map(); let total = 0;
    for (const file of files) {
      if (!SAFE_REL(file?.path)) throw Object.assign(new Error('文件路径无效'), { status: 400 });
      const data = Buffer.from(String(file.data || ''), 'base64');
      total += data.length;
      if (total > sync.maxTotalBytes) throw Object.assign(new Error('工作区文件太大，沙箱最多接收 ' + Math.round(sync.maxTotalBytes / 1048576) + ' MB'), { status: 413 });
      const target = path.join(ws, ...file.path.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data);
      before.set(file.path, sha1(data));
    }
    const result = await execSandboxed({ cwd: ws, language, code, command, timeoutSec, maxOutputBytes, env, limits });
    const written = [], deleted = []; let outBytes = 0, truncated = false;
    const after = await listTree(ws), seen = new Set();
    for (const item of after) {
      seen.add(item.path);
      if (item.size > sync.maxTotalBytes) { truncated = true; continue; }
      const data = await readFile(item.full);
      if (before.get(item.path) === sha1(data)) continue;
      outBytes += data.length;
      if (outBytes > sync.maxTotalBytes || written.length >= sync.maxFiles) { truncated = true; continue; }
      written.push({ path: item.path, data: data.toString('base64') });
    }
    for (const rel of before.keys()) if (!seen.has(rel)) deleted.push(rel);
    return { ...result, written, deleted, changesTruncated: truncated };
  } finally { await rm(top, { recursive: true, force: true }).catch(() => {}); }
}
