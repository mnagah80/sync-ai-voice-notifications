// Unit tests for the Stop/SessionStart hook without Claude: node --test tests/
'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const http = require('http'); const { spawnSync } = require('child_process');
const HOOK = path.join(__dirname, '..', 'plugin', 'sync-notify', 'bin', 'sync_hook.js');

function project(files = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-t-'));
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  return d;
}
function claim(d, c) { fs.mkdirSync(path.join(d, '.sync'), { recursive: true }); fs.writeFileSync(path.join(d, '.sync', 'complete.json'), JSON.stringify(c)); }
function hook(mode, d, inp, env = {}) {
  const r = spawnSync('node', [HOOK, mode], { input: JSON.stringify({ cwd: d, ...inp }), encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: d, SYNC_NOTIFY_HOME: path.join(d, '.home'), ...env } });
  return r;
}
function logOf(d) { return fs.readFileSync(path.join(d, '.sync', 'events.log'), 'utf8').trim().split('\n').map(JSON.parse); }
const last = (d) => logOf(d).at(-1);
const PASS = { 'test_x.py': 'import unittest\nclass T(unittest.TestCase):\n    def test_ok(self): pass\n' };
const FAIL = { 'test_x.py': 'import unittest\nclass T(unittest.TestCase):\n    def test_bad(self): self.fail()\n' };

test('session-start injects the protocol with the session id', () => {
  const d = project(); const o = JSON.parse(hook('session-start', d, { session_id: 'S1' }).stdout);
  assert.match(o.hookSpecificOutput.additionalContext, /"session_id": "S1"/);
});
test('no claim -> nothing sent (stopping is not success)', () => {
  const d = project(PASS); hook('stop', d, { session_id: 'S1' });
  assert.match(last(d).stop, /no completion claim/);
});
test('code + auto-detected tests pass -> task_succeeded', () => {
  const d = project(PASS); claim(d, { session_id: 'S1', status: 'success', kind: 'code', summary: 'done' });
  hook('stop', d, { session_id: 'S1' });
  const e = last(d); assert.equal(e.type, 'task_succeeded'); assert.equal(e.verification, 'check_passed');
  assert.match(e.check.command, /unittest/);
});
test('code + tests fail -> blocked once, then task_failed', () => {
  const d = project(FAIL); claim(d, { session_id: 'S1', status: 'success', kind: 'code', summary: 'x' });
  const r = hook('stop', d, { session_id: 'S1' }); assert.equal(JSON.parse(r.stdout).decision, 'block');
  hook('stop', d, { session_id: 'S1', stop_hook_active: true });
  assert.equal(last(d).type, 'task_failed');
});
test('code without any test -> task_completed_unverified, never succeeded', () => {
  const d = project({ 'a.py': 'x=1\n' }); claim(d, { session_id: 'S1', status: 'success', kind: 'code', summary: 'x' });
  hook('stop', d, { session_id: 'S1' }); assert.equal(last(d).type, 'task_completed_unverified');
});
test('npm test is detected from package.json', () => {
  const d = project({ 'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }) });
  claim(d, { session_id: 'S1', status: 'success', kind: 'code', summary: 'x' }); hook('stop', d, { session_id: 'S1' });
  assert.equal(last(d).check.command, 'npm test --silent'); assert.equal(last(d).type, 'task_succeeded');
});
test('other + deliverables exist -> task_completed_unverified (deliverables_exist)', () => {
  const d = project({ 'report.md': '# r\n', ...PASS });
  claim(d, { session_id: 'S1', status: 'success', kind: 'other', summary: 'r', deliverables: ['report.md'] });
  hook('stop', d, { session_id: 'S1' });
  const e = last(d); assert.equal(e.type, 'task_completed_unverified'); assert.equal(e.verification, 'deliverables_exist');
});
test('other + missing deliverable -> blocked once, then task_failed', () => {
  const d = project(); claim(d, { session_id: 'S1', status: 'success', kind: 'other', summary: 'r', deliverables: ['nope.md'] });
  assert.equal(JSON.parse(hook('stop', d, { session_id: 'S1' }).stdout).decision, 'block');
  hook('stop', d, { session_id: 'S1', stop_hook_active: true }); assert.equal(last(d).type, 'task_failed');
});
test('claimed failed -> task_failed; claim of another session ignored', () => {
  const d = project(PASS); claim(d, { session_id: 'S1', status: 'failed', summary: 'no' });
  hook('stop', d, { session_id: 'S1' }); assert.equal(last(d).type, 'task_failed');
  claim(d, { session_id: 'OTHER', status: 'success', summary: 'x' }); hook('stop', d, { session_id: 'S1' });
  assert.match(last(d).stop, /another session/);
});
// --- plugin <-> local prototype service (mock calls), real HTTP on 127.0.0.1 ---
async function startServer(env = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000); const state = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-srv-'));
  const p = require('child_process').spawn('node', [path.join(__dirname, '..', 'server', 'main.js')],
    { env: { ...process.env, PORT: String(port), SYNC_STATE_DIR: state, SYNC_TICK_MS: '200', SYNC_QUIET_HOURS: 'off', ...env }, stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(url + '/healthz')).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  return { url, stop: () => p.kill() };
}
const run = (args, env, input) => new Promise((res) => {
  const p = require('child_process').spawn('node', [HOOK, ...args], { env: { ...process.env, ...env } }); let out = '';
  p.stdout.on('data', (c) => (out += c)); if (input !== undefined) p.stdin.end(input); else p.stdin.end(); p.on('exit', () => res(out));
});
async function phoneConfirms(url, code, phone) {   // what the customer does on the phone page
  const post = (u, b) => fetch(url + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  await post('/link/start', { code, phone, consent: true });
  const calls = (await (await fetch(`${url}/mock/calls?to=${encodeURIComponent(phone)}`)).json()).calls;
  const otp = calls.filter((c) => c.purpose === 'verify').at(-1).message.match(/(\d) (\d) (\d) (\d)/).slice(1).join('');
  return post('/link/verify', { code, otp });
}

test('link -> phone confirms -> status collects the token (0600); events queued before linking are delivered', async () => {
  const srv = await startServer({ SYNC_GROUP_WINDOW_SEC: '0', SYNC_MIN_INTERVAL_SEC: '0' });
  try {
    const d = project(PASS); const home = path.join(d, '.home'); const env = { SYNC_NOTIFY_HOME: home, SYNC_SERVER: srv.url, CLAUDE_PROJECT_DIR: d };
    claim(d, { session_id: 'S1', status: 'success', kind: 'code', summary: 'before link' });
    await run(['stop'], env, JSON.stringify({ session_id: 'S1' }));
    assert.match(last(d).sent, /queued \(not_linked\)/);
    const out = await run(['link'], env); const code = out.match(/Linking code: ([A-Z2-9]{3}-[A-Z2-9]{3})/)[1];
    assert.match(out, new RegExp(`/link\\?code=${code}`));
    assert.match(await run(['status'], env), /Waiting for you to confirm/);
    assert.equal((await phoneConfirms(srv.url, code, '+12025550142')).message, 'تم الربط');
    const st = await run(['status'], env);
    assert.match(st, /Linked to phone \+1202•••42/); assert.match(st, /task_succeeded 1/); assert.match(st, /outbox: 0/);
    const cfg = path.join(home, 'config.json'); assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);
    assert.doesNotMatch(st + out, new RegExp(JSON.parse(fs.readFileSync(cfg)).token));   // the key is never printed
    await new Promise((r) => setTimeout(r, 600));
    const calls = (await (await fetch(`${srv.url}/mock/calls?to=%2B12025550142`)).json()).calls.filter((c) => c.purpose === 'notify');
    assert.equal(calls.length, 1); assert.match(calls[0].message, /اكتملت مهمة بنجاح وتم التحقق منها/);
    assert.match(await run(['pause'], env), /paused/); assert.match(await run(['status'], env), /PAUSED/);
    assert.match(await run(['resume'], env), /resumed/);
    assert.match(await run(['unlink'], env), /Unlinked/); assert.match(await run(['status'], env), /Not linked/);
  } finally { srv.stop(); }
});

test('service down: the event stays in the outbox and is delivered later, once', async () => {
  const d = project(PASS); const home = path.join(d, '.home');
  fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ server: 'http://127.0.0.1:1', token: 'x'.repeat(43) }));
  claim(d, { session_id: 'S1', status: 'success', kind: 'code', summary: 'offline' });
  await run(['stop'], { SYNC_NOTIFY_HOME: home, CLAUDE_PROJECT_DIR: d }, JSON.stringify({ session_id: 'S1' }));
  assert.match(last(d).sent, /queued \(offline\)/);
  assert.equal(fs.readdirSync(path.join(home, 'outbox')).length, 1);
});

test('pre-tool approves only a JSON Write to .sync/complete.json', () => {
  const d = project(); const dec = (ti, tool = 'Write') => { const o = hook('pre-tool', d, { tool_name: tool, tool_input: ti }).stdout;
    return o ? JSON.parse(o).hookSpecificOutput.permissionDecision : 'none'; };
  const ok = JSON.stringify({ session_id: 'S', status: 'success' });
  assert.equal(dec({ file_path: path.join(d, '.sync', 'complete.json'), content: ok }), 'allow');
  assert.equal(dec({ file_path: '.sync/complete.json', content: ok }), 'allow');
  assert.equal(dec({ file_path: path.join(d, '.sync', 'config.json'), content: ok }), 'none');
  assert.equal(dec({ file_path: path.join(d, 'x', '..', '..', 'complete.json'), content: ok }), 'none');
  assert.equal(dec({ file_path: path.join(d, '.sync', 'complete.json'), content: 'rm -rf /' }), 'none');
  assert.equal(dec({ file_path: path.join(d, '.sync', 'complete.json'), content: ok }, 'Bash'), 'none');
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'evil-')); fs.symlinkSync(evil, path.join(d, '.sync'));
  assert.equal(dec({ file_path: path.join(d, '.sync', 'complete.json'), content: ok }), 'none');
});
