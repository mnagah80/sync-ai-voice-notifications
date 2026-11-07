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
    env: { ...process.env, CLAUDE_PROJECT_DIR: d, SYNC_NOTIFY_HOME: path.join(d, '.home'), SYNC_RECEIVER_URL: '', ...env } });
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
test('link stores the token with mode 600 and status never prints it', () => {
  const d = project(); const env = { ...process.env, SYNC_NOTIFY_HOME: path.join(d, '.home') };
  spawnSync('node', [HOOK, 'link', 'https://example.invalid/e', 'tok-SECRET'], { env });
  const f = path.join(d, '.home', 'config.json'); assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  const s = spawnSync('node', [HOOK, 'status'], { env, encoding: 'utf8' }).stdout;
  assert.doesNotMatch(s, /SECRET/); assert.match(s, /token set/);
  assert.notEqual(spawnSync('node', [HOOK, 'link', 'http://example.com/e', 't'], { env }).status, 0);
});
test('POSTs once with Bearer token + idempotency key; duplicate not resent', async () => {
  const got = [];
  const srv = http.createServer((q, s) => { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { got.push({ h: q.headers, b: JSON.parse(b) }); s.writeHead(204).end(); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/e`;
  const d = project(PASS); claim(d, { session_id: 'S1', status: 'success', kind: 'code', summary: 'ok' });
  const run = () => new Promise((res) => { const p = require('child_process').spawn('node', [HOOK, 'stop'], { env: { ...process.env, CLAUDE_PROJECT_DIR: d, SYNC_NOTIFY_HOME: path.join(d, '.home'), SYNC_RECEIVER_URL: url, SYNC_TOKEN: 'T1' } }); p.stdin.end(JSON.stringify({ session_id: 'S1' })); p.on('exit', res); });
  await run(); srv.close();
  assert.equal(got.length, 1); assert.equal(got[0].h.authorization, 'Bearer T1');
  assert.equal(got[0].h['idempotency-key'], got[0].b.event_id); assert.equal(got[0].b.type, 'task_succeeded');
  assert.equal(last(d).sent, 'http 204');
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
