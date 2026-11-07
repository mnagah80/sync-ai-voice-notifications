#!/usr/bin/env node
// Sync notify hooks (prototype 0.4). Node >= 18, no npm dependencies.
// Claude Code itself is a Node program, so a machine that runs Claude Code can run this file.
//
// session-start : injects the completion protocol into Claude's context (the user never has to ask).
// stop          : runs when Claude stops. Stopping is NEVER treated as success by itself:
//   no claim (.sync/complete.json for THIS session)  -> nothing is sent (question, chat, unfinished work)
//   claim status "failed"                            -> task_failed
//   kind "code":  the project's own check is run BY THIS HOOK (configured, or auto-detected tests)
//       check passed                                 -> task_succeeded   (verification: "check_passed")
//       check failed                                 -> block the stop once so Claude can fix it, then task_failed
//       no check exists                              -> task_completed_unverified (never "succeeded")
//   kind "other" (document, research, design ...): there is no objective test, so it is never "succeeded":
//       every listed deliverable exists and is non-empty -> task_completed_unverified (verification: "deliverables_exist")
//       a listed deliverable is missing              -> block once, then task_failed
// pre-tool      : auto-approves Claude's Write of .sync/complete.json (and nothing else)
// Customer commands (run by the plugin's slash commands, no keys to copy):
//   link    : starts pairing, prints a link + temporary code; the phone page finishes it, the plugin
//             collects its device token automatically (status/stop/session-start) -> ~/.config/sync-notify (0600)
//   status | pause | resume | unlink
// Every event goes to a local outbox first and leaves it only when the service accepted it (no event is lost
// when offline, not yet linked or rate-limited); the service de-duplicates by event_id.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PROTOCOL =
  'Sync notifications are installed. Completion protocol (do this yourself, the user will not ask):\n' +
  'When you finish a task the user gave you, create .sync/complete.json in the project root using the Write tool ' +
  '(not Bash, not Edit; this one Write is pre-approved, so it never asks the user) with ' +
  '{"session_id": "<SESSION>", "status": "success" or "failed", "kind": "code" or "other", ' +
  '"summary": "<one short line>", "deliverables": ["<relative paths of files you produced>"]}. ' +
  'kind "code" = you changed source code; "other" = documents, research, designs, data, etc. ' +
  'Use "success" only when the task is really done; use "failed" if you could not complete it. ' +
  'Do not write it for questions, chat or unfinished work. A separate check decides what notification is sent.';

const USER_DIR = process.env.SYNC_NOTIFY_HOME || path.join(os.homedir(), '.config', 'sync-notify');
const CFG_FILE = path.join(USER_DIR, 'config.json');
const OUTBOX = path.join(USER_DIR, 'outbox');
// Stage A: there is no public Sync service yet; SYNC_SERVER points at the local prototype service.
const DEFAULT_SERVER = null;

function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function sh(cmd, cwd, timeoutMs) {
  const r = spawnSync(cmd, { shell: true, cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status === null ? -1 : r.status, out: ((r.stdout || '') + (r.stderr || '')).slice(-300) };
}
function has(cmd) { return spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0; }

function settings(root) {   // user-level link (one per machine) + optional per-project overrides
  return Object.assign({}, readJSON(path.join(USER_DIR, 'config.json')) || {}, readJSON(path.join(root, '.sync', 'config.json')) || {});
}

// The project's own test command, so non-technical users do not have to configure anything.
function detectCheck(root) {
  const pkg = readJSON(path.join(root, 'package.json'));
  const t = pkg && pkg.scripts && pkg.scripts.test;
  if (t && !/no test specified/.test(t)) return 'npm test --silent';
  const ex = (f) => fs.existsSync(path.join(root, f));
  const py = has('python3') ? 'python3' : (has('python') ? 'python' : null);
  if (py) {
    const pytestCfg = ex('pytest.ini') || ex('conftest.py') ||
      ['pyproject.toml', 'setup.cfg', 'tox.ini'].some((f) => ex(f) && /pytest/.test(fs.readFileSync(path.join(root, f), 'utf8')));
    if (pytestCfg && spawnSync(py, ['-c', 'import pytest'], { stdio: 'ignore' }).status === 0) return `${py} -m pytest -q`;
    const hasPyTests = (d) => { try { return fs.readdirSync(d).some((f) => /^test_.*\.py$|_test\.py$/.test(f)); } catch { return false; } };
    if (hasPyTests(root)) return `${py} -m unittest -q`;
    if (hasPyTests(path.join(root, 'tests'))) return `${py} -m unittest discover -s tests -q`;
  }
  if (ex('Cargo.toml') && has('cargo')) return 'cargo test --quiet';
  if (ex('go.mod') && has('go')) return 'go test ./...';
  if (ex('Makefile') && /^test:/m.test(fs.readFileSync(path.join(root, 'Makefile'), 'utf8')) && has('make')) return 'make test';
  return null;
}

function log(root, rec) {
  fs.mkdirSync(path.join(root, '.sync'), { recursive: true });
  const gi = path.join(root, '.sync', '.gitignore');   // keep Sync's local files out of the customer's git
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  fs.appendFileSync(path.join(root, '.sync', 'events.log'), JSON.stringify({ t: new Date().toISOString(), ...rec }) + '\n');
}

function userCfg() { return readJSON(CFG_FILE) || {}; }
function saveUserCfg(c) {
  fs.mkdirSync(USER_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2), { mode: 0o600 }); fs.chmodSync(CFG_FILE, 0o600);
}
function serverOf(c) { return process.env.SYNC_SERVER || c.server || DEFAULT_SERVER; }
async function api(server, method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body && body.event_id) headers['Idempotency-Key'] = body.event_id;
  const r = await fetch(server + p, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  let d = {}; try { d = await r.json(); } catch {}
  return { status: r.status, d };
}

// Collects the device token once the customer confirmed the phone on the pairing page.
async function completePairing(c) {
  if (c.token || !c.pending) return c;
  if (c.pending.expires_at < Date.now() / 1000) { delete c.pending; saveUserCfg(c); return c; }
  try {
    const r = await api(c.pending.server, 'POST', '/v1/pair/poll', { device_code: c.pending.device_code });
    if (r.d.status === 'approved') { c = { server: c.pending.server, token: r.d.token, phone_masked: r.d.phone_masked, linked_at: Date.now() }; saveUserCfg(c); }
    else if (r.status === 400) { delete c.pending; saveUserCfg(c); }
  } catch { /* offline: try again later */ }
  return c;
}

async function flushOutbox() {
  let c = await completePairing(userCfg());
  let files = []; try { files = fs.readdirSync(OUTBOX).filter((f) => f.endsWith('.json')).sort(); } catch {}
  if (!files.length) return { sent: 0, queued: 0 };
  if (!c.token) return { sent: 0, queued: files.length, reason: 'not_linked' };
  let sent = 0;
  for (const f of files) {
    const fp = path.join(OUTBOX, f); const ev = readJSON(fp);
    if (!ev) { fs.rmSync(fp, { force: true }); continue; }
    let r; try { r = await api(serverOf(c), 'POST', '/v1/events', ev, c.token); } catch (e) { return { sent, queued: files.length - sent, reason: 'offline' }; }
    if (r.status >= 200 && r.status < 300) { fs.rmSync(fp, { force: true }); sent++; }   // accepted or duplicate
    else if (r.status === 400) { fs.renameSync(fp, fp + '.rejected'); }                    // malformed: keep for inspection
    else return { sent, queued: files.length - sent, reason: `http ${r.status}` };          // 401/429/5xx: keep, retry later
  }
  return { sent, queued: files.length - sent };
}

async function send(root, cfg, event) {
  fs.mkdirSync(OUTBOX, { recursive: true, mode: 0o700 });
  const f = path.join(OUTBOX, `${String(Date.now()).padStart(14, '0')}-${event.event_id}.json`);
  if (fs.readdirSync(OUTBOX).some((x) => x.includes(event.event_id))) { log(root, { skip: 'duplicate', ...event }); return; }
  fs.writeFileSync(f, JSON.stringify(event), { mode: 0o600 });
  const r = await flushOutbox();
  log(root, { sent: r.reason ? `queued (${r.reason})` : 'delivered', outbox_left: r.queued, ...event });
}

// PreToolUse: approve ONLY Claude's own completion claim, so the customer is never asked for permission
// for it. Anything else (other files, a symlinked .sync, non-JSON or oversized content) gets no decision
// from us and follows the user's normal permission settings.
function preTool(inp, root) {
  if (inp.tool_name !== 'Write') return;
  const ti = inp.tool_input || {};
  const want = path.join(root, '.sync', 'complete.json');
  if (!ti.file_path || path.resolve(root, ti.file_path) !== want) return;
  const content = String(ti.content || '');
  if (content.length > 4096) return;
  try { const c = JSON.parse(content); if (!c || typeof c !== 'object' || Array.isArray(c)) return; } catch { return; }
  const dir = path.join(root, '.sync');
  try {
    if (fs.lstatSync(dir).isSymbolicLink() || fs.realpathSync(dir) !== path.join(fs.realpathSync(root), '.sync')) return;
    if (fs.existsSync(want) && fs.lstatSync(want).isSymbolicLink()) return;
  } catch { /* .sync does not exist yet: Write creates it inside the project */ }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
    permissionDecision: 'allow', permissionDecisionReason: 'Sync completion claim (.sync/complete.json only)' } }));
}

function block(reason) { process.stdout.write(JSON.stringify({ decision: 'block', reason })); }

async function stop(inp, root) {
  const sid = inp.session_id || '';
  const claimFile = path.join(root, '.sync', 'complete.json');
  const claim = readJSON(claimFile);
  if (!claim) { log(root, { stop: 'no completion claim -> nothing sent', session_id: sid }); return; }
  if (claim.session_id && claim.session_id !== sid) { log(root, { stop: 'claim belongs to another session -> ignored', session_id: sid }); return; }
  const cfg = settings(root);
  const claimedOk = claim.status === 'success';
  const kind = claim.kind === 'other' ? 'other' : 'code';
  let verification = 'none'; let check = null; let problem = null;

  if (claimedOk && kind === 'code') {
    const cmd = cfg.verify === false ? null : (cfg.verify || detectCheck(root));
    if (cmd) {
      const r = sh(cmd, root, 540000);
      check = { command: cmd, passed: r.code === 0, exit: r.code };
      verification = check.passed ? 'check_passed' : 'check_failed';
      if (!check.passed) problem = `Sync check failed (${cmd}, exit ${r.code}).`;
    }
  } else if (claimedOk) {
    const list = Array.isArray(claim.deliverables) ? claim.deliverables.map(String) : [];
    const missing = list.filter((p) => { try { return !(fs.statSync(path.resolve(root, p)).size > 0); } catch { return true; } });
    verification = list.length ? (missing.length ? 'deliverables_missing' : 'deliverables_exist') : 'none';
    if (missing.length) problem = `Sync check: listed deliverables are missing or empty: ${missing.join(', ')}.`;
  }
  if (problem && !inp.stop_hook_active) {   // one chance to fix it instead of announcing anything
    log(root, { stop: 'claimed success but verification failed -> blocked once', session_id: sid, verification });
    block(`${problem} Fix it, or set status to "failed" in .sync/complete.json if it cannot be done.`);
    return;
  }
  let type;
  if (!claimedOk || problem) type = 'task_failed';
  else if (verification === 'check_passed') type = 'task_succeeded';
  else type = 'task_completed_unverified';

  const mtime = fs.statSync(claimFile).mtimeMs;
  const eventId = crypto.createHash('sha256').update(`${sid}|${mtime}|${claim.summary || ''}`).digest('hex').slice(0, 16);
  const event = {
    event_id: eventId, type, kind, verification, session_id: sid,
    summary: String(claim.summary || '').slice(0, 200),
    check: check ? { command: check.command, passed: check.passed } : null,
    project: path.basename(root), at: Math.floor(Date.now() / 1000), v: 2,
  };
  await send(root, cfg, event);
  fs.rmSync(claimFile, { force: true });   // the next task needs a new claim
}

async function command(mode) {
  let c = userCfg();
  if (mode === 'link') {
    const server = serverOf(c);
    if (!server) { console.log('Sync service is not available yet (prototype). Nothing was changed.'); return; }
    if (c.token) { console.log(`Already linked to ${c.phone_masked}. To change the phone run /sync-notify:unlink first.`); return; }
    const r = await api(server, 'POST', '/v1/pair/start', { device_name: os.hostname().slice(0, 40) });
    if (r.status !== 200) { console.log(`Could not start linking (http ${r.status}). Try again in a few minutes.`); return; }
    c.pending = { server, device_code: r.d.device_code, user_code: r.d.user_code, expires_at: Math.floor(Date.now() / 1000) + r.d.expires_in };
    saveUserCfg(c);
    console.log(['Open this link on your phone to link it to Sync call notifications:', '', `   ${r.d.verification_uri_complete}`, '',
      `Linking code: ${r.d.user_code}  (valid ${Math.round(r.d.expires_in / 60)} minutes)`,
      'Enter your phone number there and the 4-digit code from the verification call. Linking then completes by itself;',
      'nothing else to do here. Check any time with /sync-notify:status.'].join('\n'));
    return;
  }
  c = await completePairing(c);
  if (!c.token) {
    console.log(c.pending ? `Waiting for you to confirm your phone on the linking page (code ${c.pending.user_code}).` : 'Not linked. Run /sync-notify:link to link your phone.');
    return;
  }
  const server = serverOf(c);
  if (mode === 'status') {
    const f = await flushOutbox();
    const r = await api(server, 'GET', '/v1/device/status', null, c.token);
    if (r.status === 401) { console.log('This link was removed. Run /sync-notify:link to link again.'); return; }
    const by = {}; for (const e of r.d.events || []) by[e.type] = (by[e.type] || 0) + e.n;
    console.log([`Linked to phone ${r.d.phone_masked}${r.d.mock ? ' (TEST service, mock calls)' : ''}.`,
      `Notifications: ${r.d.paused ? 'PAUSED (run /sync-notify:resume)' : 'on'}.`,
      `Events received: ${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}; notification calls: ${r.d.notification_calls}.`,
      `Waiting in local outbox: ${f.queued}.`].join('\n'));
  } else if (mode === 'pause' || mode === 'resume') {
    const r = await api(server, 'POST', `/v1/device/${mode}`, null, c.token);
    console.log(r.status === 200 ? (mode === 'pause' ? 'Call notifications paused. Task events are still recorded.' : 'Call notifications resumed.') : `Failed (http ${r.status}).`);
  } else if (mode === 'unlink') {
    const r = await api(server, 'POST', '/v1/device/unlink', null, c.token);
    if (r.status === 200 || r.status === 401) {
      saveUserCfg({}); fs.rmSync(OUTBOX, { recursive: true, force: true });
      console.log('Unlinked. This computer can no longer send notifications; its key was revoked and deleted.');
    } else console.log(`Unlink failed (http ${r.status}). Nothing was deleted; try again.`);
  }
}

async function main() {
  const mode = process.argv[2] || '';
  const isCommand = ['link', 'status', 'pause', 'resume', 'unlink'].includes(mode);
  let raw = ''; if (!isCommand) { try { raw = fs.readFileSync(0, 'utf8'); } catch {} }
  // Node's built-in fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 (Node >= 22.21 / 24).
  // Behind a proxy (corporate networks, Claude cloud sessions) re-run once with it set.
  const proxied = process.env.HTTPS_PROXY || process.env.https_proxy;
  if ((mode === 'stop' || isCommand) && proxied && !process.env.NODE_USE_ENV_PROXY) {
    const r = spawnSync(process.execPath, process.argv.slice(1), { input: raw, stdio: ['pipe', 'inherit', 'inherit'],
      env: { ...process.env, NODE_USE_ENV_PROXY: '1' } });
    process.exit(r.status === null ? 0 : r.status);
  }
  if (isCommand) return command(mode);
  let inp = {}; try { inp = JSON.parse(raw || '{}'); } catch {}
  const root = process.env.CLAUDE_PROJECT_DIR || inp.cwd || process.cwd();
  if (mode === 'session-start') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart',
      additionalContext: PROTOCOL.replace('<SESSION>', inp.session_id || '') } }));
  } else if (mode === 'pre-tool') {
    preTool(inp, root);
  } else if (mode === 'stop') {
    await stop(inp, root);
  }
}

main().catch((e) => { try { process.stderr.write(`sync-notify: ${e.message}\n`); } catch {} process.exit(0); });
