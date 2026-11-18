import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRunner } from '../runner/runner.mjs';
import { runPmTeam } from '../collab.mjs';
import { mintExecToken, verifyExecToken, normalizeLanguage } from '../runner/sandbox.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = { email: 'owner@example.com', password: 'a-very-long-test-password' };
const TOKEN = 'runner-token-abcdefghij', SBX_TOKEN = 'sandbox-token-0123456789';
let dir, modelServer, sandboxServer, runnerServer, bareRunner, app, base, runnerBase, bareBase, auth;
const prompts = [];
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test.before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cindy-sbx-'));
  const keyFile = path.join(dir, 'k'), adminFile = path.join(dir, 'admin'), tokenFile = path.join(dir, 'rt');
  await writeFile(keyFile, randomBytes(32).toString('base64')); await writeFile(adminFile, ADMIN.password); await writeFile(tokenFile, TOKEN);
  modelServer = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c);
    req.on('end', () => {
      const body = JSON.parse(raw), last = body.messages.at(-1).content, system = body.messages.find(m => m.role === 'system')?.content || '';
      prompts.push({ last, system });
      const who = /你的名字是“([^”]+)”/.exec(system)?.[1] || /你的名称：(\S+)/.exec(last)?.[1] || '?';
      if (last.includes('你是团队的产品经理')) {
        const worked = last.includes('【乙】\n');
        const pmReply = worked ? '{"say":"","final":"汇总：' + (/【乙】\n(\S+)/.exec(last)?.[1] || '') + '"}'
          : last.includes('只做一件事') ? '{"say":"这个交给乙","assign":[{"to":"乙","task":"写文案"},{"to":"不存在","task":"x"}]}' : '{"say":"","final":"直接答复：好的"}';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: pmReply } }] }) + '\n\n');
        return res.end('data: [DONE]\n\n');
      }
      const reply = who === '甲' && !last.includes('@乙') && last.includes('请乙') ? '我觉得 @乙 你来补充' : '来自' + who;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  const modelPort = await listen(modelServer);
  // 沙箱容器：不挂载工作区，只收文件副本；运行器：带 SANDBOX_URL；bareRunner：没配沙箱
  sandboxServer = createRunner({ token: SBX_TOKEN, root: path.join(dir, 'unused'), env: { ...process.env, SANDBOX_ONLY: '1', MODEL_SECRET: 'must-not-leak' } });
  const sandboxPort = await listen(sandboxServer);
  runnerServer = createRunner({ token: TOKEN, sandboxToken: SBX_TOKEN, root: path.join(dir, 'ws'), env: { ...process.env, SANDBOX_URL: `http://127.0.0.1:${sandboxPort}` } });
  const runnerPort = await listen(runnerServer);
  bareRunner = createRunner({ token: TOKEN, root: path.join(dir, 'ws2'), env: { ...process.env } });
  const barePort = await listen(bareRunner);
  runnerBase = `http://127.0.0.1:${runnerPort}`; bareBase = `http://127.0.0.1:${barePort}`;
  const port = 20000 + Math.floor(Math.random() * 20000);
  base = 'http://127.0.0.1:' + port;
  app = spawn(process.execPath, ['server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, COOKIE_SECURE: 'false', TRUST_PROXY: 'false', STORE_ENCRYPTION_KEY_FILE: keyFile, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD_FILE: adminFile, MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, MODEL_NAME: 'test-model', MODEL_API_KEY: 'k', RUNNER_URL: runnerBase, RUNNER_TOKEN_FILE: tokenFile } });
  await new Promise((resolve, reject) => { app.on('exit', code => reject(new Error('server exited ' + code))); app.stdout.on('data', c => { if (String(c).includes('listening')) resolve(); }); });
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(ADMIN) });
  const data = await response.json();
  auth = { cookie: response.headers.get('set-cookie').split(';')[0], csrf: data.csrfToken };
});
test.after(async () => {
  app?.removeAllListeners('exit'); app?.kill(); modelServer?.close();
  for (const s of [sandboxServer, runnerServer, bareRunner]) { s?.close(); s?.closeAllConnections?.(); }
  await new Promise(r => setTimeout(r, 300)); await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const call = async (p, method = 'GET', body) => {
  const response = await fetch(base + p, { method, headers: { Origin: base, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json().catch(() => ({})) };
};
async function sse(p, body) {
  const response = await fetch(base + p, { method: 'POST', headers: { Origin: base, Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) return { status: response.status, data: await response.json() };
  const text = await response.text();
  return { status: 200, events: [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map(m => ({ type: m[1], ...JSON.parse(m[2]) })) };
}
const exec = (b, body, headers = {}) => fetch(b + '/exec', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, data: await r.json() }));

test('短期令牌：只对指定工作区有效，过期、被篡改都不行', () => {
  const token = mintExecToken(TOKEN, 'ws-1', 60, 1_000_000_000_000);
  assert.deepEqual(verifyExecToken(TOKEN, token, 1_000_000_000_000 + 1000), { workspace: 'ws-1' });
  assert.equal(verifyExecToken(TOKEN, token, 1_000_000_000_000 + 61_000), null);
  assert.equal(verifyExecToken(TOKEN, token.replace('ws-1', 'ws-2'), 1_000_000_000_000), null);
  assert.equal(verifyExecToken('other-secret-123456', token, 1_000_000_000_000), null);
  assert.equal(normalizeLanguage('JS'), 'node'); assert.equal(normalizeLanguage('ruby'), null);
});

test('沙箱：代码在沙箱容器里跑，文件改动写回工作区，沙箱看不到密钥', async () => {
  await fetch(runnerBase + '/files?workspace=ws-a&path=in.txt', { method: 'PUT', headers: { Authorization: 'Bearer ' + TOKEN }, body: 'hello' });
  const out = await exec(runnerBase, { workspace: 'ws-a', language: 'node', code: "import fs from 'node:fs';console.log(fs.readFileSync('in.txt','utf8')+'!'+(process.env.MODEL_SECRET||'none'));fs.writeFileSync('out.txt','done');fs.unlinkSync('in.txt')" });
  assert.equal(out.status, 200);
  assert.equal(out.data.exitCode, 0);
  assert.equal(out.data.stdout.trim(), 'hello!none');
  assert.deepEqual(out.data.changed, ['out.txt']); assert.deepEqual(out.data.removed, ['in.txt']);
  assert.equal(await readFile(path.join(dir, 'ws', 'ws-a', 'out.txt'), 'utf8'), 'done');
  const shell = await exec(runnerBase, { workspace: 'ws-a', command: 'echo err 1>&2; exit 3' });
  assert.equal(shell.data.exitCode, 3); assert.match(shell.data.stderr, /err/);
});

test('沙箱：超时被杀、输出被截断、坏请求被拒', async () => {
  const slow = await exec(runnerBase, { workspace: 'ws-a', language: 'node', code: 'setTimeout(()=>{},5000)', timeoutSec: 1 });
  assert.equal(slow.data.timedOut, true); assert.ok(slow.data.durationMs < 5000);
  const big = await exec(runnerBase, { workspace: 'ws-a', language: 'node', code: "console.log('x'.repeat(300000))" });
  assert.equal(big.data.truncated, true); assert.ok(big.data.stdout.length < 100000);
  assert.equal((await exec(runnerBase, { workspace: 'ws-a', language: 'ruby', code: 'puts 1' })).status, 400);
  assert.equal((await exec(runnerBase, { workspace: '../x', language: 'node', code: '1' })).status, 400);
});

test('沙箱：令牌权限与未配置时的拒绝', async () => {
  const scoped = mintExecToken(TOKEN, 'ws-a', 60);
  const headers = { Authorization: 'Bearer ' + scoped };
  assert.equal((await exec(runnerBase, { workspace: 'ws-a', language: 'node', code: 'console.log(1)' }, headers)).data.exitCode, 0);
  assert.equal((await exec(runnerBase, { workspace: 'ws-b', language: 'node', code: 'console.log(1)' }, headers)).status, 403);
  const files = await fetch(runnerBase + '/files?workspace=ws-a', { headers }); assert.equal(files.status, 401, '短期令牌不能访问文件接口');
  assert.equal((await exec(bareBase, { workspace: 'ws-a', language: 'node', code: '1' })).status, 403);
  assert.equal((await fetch(sandboxServer ? `http://127.0.0.1:${sandboxServer.address().port}/files?workspace=x` : '', { headers: { Authorization: 'Bearer ' + SBX_TOKEN } })).status, 404, '沙箱容器不提供文件接口');
  const withRunnerToken = await fetch(`http://127.0.0.1:${sandboxServer.address().port}/health`, { headers: { Authorization: 'Bearer ' + TOKEN } });
  assert.equal(withRunnerToken.status, 401, '沙箱不认运行器令牌；沙箱令牌也进不了运行器');
  assert.equal((await fetch(runnerBase + '/health', { headers: { Authorization: 'Bearer ' + SBX_TOKEN } })).status, 401);
});

test('应用接口：默认关闭，管理员打开后可运行', async () => {
  assert.equal((await call('/api/sandbox/run', 'POST', { language: 'node', code: 'console.log(1)' })).status, 403);
  assert.equal((await call('/api/sandbox')).data.available, false);
  assert.equal((await call('/api/admin/sandbox', 'PUT', { enabled: true, membersAllowed: false, timeoutSec: 10 })).status, 200);
  assert.equal((await call('/api/sandbox')).data.available, true);
  const run = await call('/api/sandbox/run', 'POST', { language: 'js', code: 'console.log(6*7)' });
  assert.equal(run.status, 200); assert.equal(run.data.stdout.trim(), '42');
  assert.equal((await call('/api/sandbox/run', 'POST', {})).status, 400);
});

test('群聊：@ 点名只让被点名的回复；回复里 @ 到别人会接力；整段历史保存', async () => {
  const members = [{ label: '甲', role: '组织者' }, { label: '乙', role: '补充者' }, { label: '丙' }];
  assert.equal((await call('/api/groups', 'POST', { mode: 'chat', members: [{ label: '有 空格' }] })).status, 400);
  assert.equal((await call('/api/groups', 'POST', { mode: 'chat', members: [{ label: '甲' }, { label: '甲' }] })).status, 400);
  const group = (await call('/api/groups', 'POST', { title: '讨论', mode: 'chat', members })).data.group;
  assert.equal(group.members.length, 3);

  const all = await sse(`/api/groups/${group.id}/send`, { message: '大家好' });
  assert.deepEqual(all.events.filter(e => e.type === 'turn_start').map(e => e.label), ['甲', '乙', '丙']);
  assert.equal(all.events.at(-1).type, 'done');

  const only = await sse(`/api/groups/${group.id}/send`, { message: '@丙 你说说' });
  assert.deepEqual(only.events.filter(e => e.type === 'turn_start').map(e => e.label), ['丙']);
  assert.match(prompts.at(-1).last, /【用户】\n大家好/, '后面的发言能看到前面的记录');
  assert.match(prompts.at(-1).last, /【甲】\n来自甲/);

  const relay = await sse(`/api/groups/${group.id}/send`, { message: '@甲 请乙补充' });
  assert.deepEqual(relay.events.filter(e => e.type === 'turn_start').map(e => e.label), ['甲', '乙']);

  const saved = (await call('/api/groups/' + group.id)).data;
  assert.equal(saved.messages.filter(m => m.role === 'user').length, 3);
  assert.deepEqual(saved.messages.filter(m => m.role === 'agent').map(m => m.label), ['甲', '乙', '丙', '丙', '甲', '乙']);
  assert.equal((await call('/api/groups')).data.groups[0].count, 9);
});

test('群聊：圆桌方式在群里跑完整讨论；改设置、删除', async () => {
  const group = (await call('/api/groups', 'POST', { title: '圆桌', mode: 'roundtable', rounds: 1, members: [{ label: '甲' }, { label: '乙' }] })).data.group;
  const run = await sse(`/api/groups/${group.id}/send`, { message: '讨论一下方案' });
  assert.equal(run.events.filter(e => e.type === 'turn_start').length, 3, '1 轮 × 2 人 + 总结');
  assert.equal((await call('/api/groups/' + group.id)).data.messages.filter(m => m.role === 'agent').length, 3);
  assert.equal((await call('/api/groups/' + group.id, 'PATCH', { mode: 'supervisor', members: [{ label: '甲' }] })).status, 400);
  assert.equal((await call('/api/groups/' + group.id, 'PATCH', { title: '新名字' })).data.group.title, '新名字');
  assert.equal((await call('/api/groups/' + group.id, 'DELETE')).status, 200);
  assert.equal((await call('/api/groups/' + group.id)).status, 404);
});

test('产品经理带队：按擅长分配任务，成员交付后由产品经理汇总；简单问题直接答复', async () => {
  const group = (await call('/api/groups', 'POST', { title: '团队', members: [
    { label: '代码手', role: '后端工程师', strengths: '写代码、排错' }, { label: '乙', role: '文案', strengths: '写作、文案' }] })).data.group;
  assert.equal(group.mode, 'pm'); assert.equal(group.pm.label, '产品经理'); assert.equal(group.members[1].strengths, '写作、文案');
  assert.equal((await call('/api/groups', 'POST', { members: [{ label: '产品经理' }] })).status, 400, '成员不能和产品经理重名');

  const simple = await sse(`/api/groups/${group.id}/send`, { message: '你好' });
  assert.deepEqual(simple.events.filter(e => e.type === 'turn_start').map(e => e.label), ['产品经理']);
  assert.match(prompts.at(-1).last, /代码手（身份：后端工程师）｜擅长：写代码、排错/, '名单里带身份和擅长');

  const work = await sse(`/api/groups/${group.id}/send`, { message: '只做一件事：帮我写文案' });
  const order = work.events.filter(e => e.type === 'turn_start').map(e => e.label);
  assert.deepEqual(order, ['产品经理', '乙', '产品经理'], '先说明分工，乙交付，最后汇总（不存在的成员被忽略）');
  const saved = (await call('/api/groups/' + group.id)).data.messages.filter(m => m.role === 'agent');
  assert.match(saved.at(-1).content, /^汇总：来自乙/);
  assert.equal(saved.at(-1).label, '产品经理');
});

test('沙箱：没有指定工作区时在空目录里跑，不读不写工作区', async () => {
  const run = await exec(runnerBase, { workspace: 'sbx-ephemeral', ephemeral: true, language: 'node', code: "import fs from 'node:fs';fs.writeFileSync('leak.txt','x');console.log(fs.readdirSync('.').join(','))" });
  assert.equal(run.data.exitCode, 0); assert.equal(run.data.stdout.trim(), 'leak.txt');
  assert.deepEqual(run.data.changed, []);
  await assert.rejects(readFile(path.join(dir, 'ws', 'sbx-ephemeral', 'leak.txt')));
});

test('群聊：@GPT2 不会同时点到 GPT', async () => {
  const group = (await call('/api/groups', 'POST', { title: '前缀', mode: 'chat', members: [{ label: 'GPT' }, { label: 'GPT2' }] })).data.group;
  const run = await sse(`/api/groups/${group.id}/send`, { message: '@GPT2 你好' });
  assert.deepEqual(run.events.filter(e => e.type === 'turn_start').map(e => e.label), ['GPT2']);
});

test('产品经理带队：一位成员出错不拖垮整轮，其余成员的成果照常汇总', async () => {
  const pm = { label: '产品经理' }, members = [{ label: '甲' }, { label: '乙' }];
  const events = []; let pmCalls = 0;
  const call = async ({ participant, prompt }) => {
    if (participant === pm) { pmCalls++; return { text: pmCalls === 1 ? '{"say":"分工","assign":[{"to":"甲","task":"a"},{"to":"乙","task":"b"}]}' : '{"say":"","final":"汇总：' + (prompt.includes('执行失败') ? '甲失败' : '全成功') + '，' + (prompt.includes('来自乙') ? '乙在' : '乙缺') + '"}' }; }
    if (participant.label === '甲') throw new Error('429 限流');
    return { text: '来自乙' };
  };
  await runPmTeam({ message: 'x', pm, members, call, emit: e => events.push(e) });
  assert.match(events.filter(e => e.type === 'turn_end').at(-1).text, /汇总：甲失败，乙在/);
  assert.ok(events.some(e => e.type === 'turn_end' && e.failed && e.label === '甲'));
});
