'use strict';
// Sync notify service core: pairing by temporary code, verified task events, grouping into calls, limits.
// Transport-neutral: handle(req) -> {status, headers, body}. main.js adapts node:http; a Worker adapter can follow.
const crypto = require('crypto');
const pages = require('./pages');

const DEFAULT_SETTINGS = {
  group_window_sec: 120,      // wait this long after the first pending event so several tasks become ONE call
  min_interval_sec: 300,      // at least this long between two notification calls
  max_calls_per_day: 10,      // calls per local day; events beyond it wait for the next allowed call (never dropped)
  quiet_start_hour: 23,       // no calls from 23:00 ...
  quiet_end_hour: 8,          // ... to 08:00 (customer's local time); events wait, never dropped
  tz_offset_min: 0,           // customer's UTC offset in minutes
  call_on_failed: true,       // task_failed -> call
  call_on_unverified: false,  // task_completed_unverified -> stored, no call unless the customer turns it on
};
const SETTING_BOUNDS = {
  group_window_sec: [0, 3600], min_interval_sec: [0, 86400], max_calls_per_day: [0, 50],
  quiet_start_hour: [0, 23], quiet_end_hour: [0, 23], tz_offset_min: [-720, 840],
};
const PAIR_TTL = 600, OTP_TTL = 300, OTP_ATTEMPTS = 5, VERIFY_CALLS_PER_PAIRING = 3;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I/L

function createCore({ db, provider, secret, now = () => Math.floor(Date.now() / 1000), baseUrl, mock = true,
                      testNumbersOnly = true, defaults = {} }) {
  if (!secret || secret.length < 32) throw new Error('server secret (>= 32 bytes) required');
  const key = crypto.createHash('sha256').update('sync-data|' + secret).digest();
  const hmac = (s) => crypto.createHmac('sha256', key).update(s).digest('hex');
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const rnd = (n) => crypto.randomBytes(n).toString('base64url');
  const settingsDefaults = { ...DEFAULT_SETTINGS, ...defaults };

  function enc(plain) {
    const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
  }
  function dec(s) {
    const [iv, tag, ct] = s.split('.').map((x) => Buffer.from(x, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  }
  const mask = (p) => p.slice(0, 5) + '•••' + p.slice(-2);
  function normPhone(p) {
    const s = String(p || '').replace(/[\s\-().]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(s)) return null;
    if (testNumbersOnly && !/^\+1\d{3}55501\d{2}$/.test(s)) return 'NOT_TEST';
    return s;
  }
  function userCode() {
    let c = ''; for (const b of crypto.randomBytes(6)) c += CODE_ALPHABET[b % CODE_ALPHABET.length];
    return c.slice(0, 3) + '-' + c.slice(3);
  }
  const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{3})(.{3})$/, '$1-$2');

  // fixed-window rate limit; true = allowed
  async function rate(k, limit, windowSec) {
    const t = now(); const win = Math.floor(t / windowSec);
    const r = await db.first('SELECT win, count FROM rate WHERE key = ?', k);
    if (!r || r.win !== win) { await db.run('INSERT OR REPLACE INTO rate(key, win, count) VALUES (?, ?, 1)', k, win); return true; }
    if (r.count >= limit) return false;
    await db.run('UPDATE rate SET count = count + 1 WHERE key = ?', k); return true;
  }

  const json = (status, body, headers = {}) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }, body: JSON.stringify(body) });
  const html = (body) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'",
    'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' }, body });

  async function placeCall({ accountId, to, toMasked, purpose, message, eventCount = 0 }) {
    const id = 'call_' + rnd(9); let status = 'failed', ref = null;
    try { const r = await provider.place({ to, message }); status = r.status; ref = r.ref; } catch (e) { status = 'failed: ' + e.message.slice(0, 80); }
    await db.run('INSERT INTO calls(id, account_id, to_enc, to_masked, purpose, created_at, event_count, message, status, provider, provider_ref) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id, accountId, enc(to), toMasked, purpose, now(), eventCount, message, status, provider.name, ref);
    return { id, status };
  }

  async function deviceFrom(req) {
    const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '');
    if (!m) return null;
    const d = await db.first('SELECT d.*, a.paused, a.settings FROM devices d JOIN accounts a ON a.id = d.account_id WHERE d.token_hash = ? AND d.revoked_at IS NULL', sha(m[1]));
    if (d) await db.run('UPDATE devices SET last_seen = ? WHERE id = ?', now(), d.id);
    return d;
  }
  const settingsOf = (row) => ({ ...settingsDefaults, ...JSON.parse(row.settings || '{}') });

  // ---- pairing (RFC 8628 style: the device never sees the phone; the phone never sees a key) ----
  async function pairStart(req) {
    if (!(await rate('ip-pair:' + req.ip, 20, 3600))) return json(429, { error: 'rate_limited' });
    const deviceCode = rnd(32); let code;
    for (let i = 0; i < 5; i++) { code = userCode(); if (!(await db.first('SELECT 1 FROM pairings WHERE user_code = ?', code))) break; }
    const t = now();
    await db.run('INSERT INTO pairings(device_code_hash, user_code, device_name, created_at, expires_at, status) VALUES (?,?,?,?,?,?)',
      sha(deviceCode), code, String((req.body && req.body.device_name) || 'Claude').slice(0, 60), t, t + PAIR_TTL, 'pending');
    return json(200, { device_code: deviceCode, user_code: code, verification_uri: `${baseUrl}/link`,
      verification_uri_complete: `${baseUrl}/link?code=${encodeURIComponent(code)}`, expires_in: PAIR_TTL, interval: 5 });
  }
  async function pairingByCode(code) {
    const p = await db.first('SELECT * FROM pairings WHERE user_code = ?', normCode(code));
    if (!p) return null;
    if (p.expires_at <= now() && !['approved', 'consumed'].includes(p.status)) {
      await db.run("UPDATE pairings SET status = 'expired' WHERE device_code_hash = ?", p.device_code_hash); p.status = 'expired';
    }
    return p;
  }
  async function linkStart(req) {   // phone page: code + test number + consent -> verification call
    const b = req.body || {};
    if (!(await rate('ip-link:' + req.ip, 20, 3600))) return json(429, { error: 'rate_limited', message: 'محاولات كثيرة، حاول بعد قليل' });
    const p = await pairingByCode(b.code);
    if (!p || !['pending', 'verifying'].includes(p.status)) return json(400, { error: 'bad_code', message: 'الرمز غير صحيح أو انتهت صلاحيته' });
    if (b.consent !== true) return json(400, { error: 'consent_required', message: 'يجب الموافقة على استقبال المكالمات' });
    const phone = normPhone(b.phone);
    if (!phone) return json(400, { error: 'bad_phone', message: 'رقم غير صحيح' });
    if (phone === 'NOT_TEST') return json(400, { error: 'test_numbers_only', message: 'المرحلة التجريبية: استخدم رقمًا تجريبيًا من +1 202 555 0100 إلى +1 202 555 0199 فقط' });
    if (p.verify_calls >= VERIFY_CALLS_PER_PAIRING || !(await rate('phone-verify:' + hmac(phone), 3, 86400)))
      return json(429, { error: 'too_many_calls', message: 'تم الوصول لحد مكالمات التحقق' });
    const otp = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    await db.run("UPDATE pairings SET status = 'verifying', phone_lookup = ?, phone_enc = ?, phone_masked = ?, otp_hash = ?, otp_expires = ?, otp_attempts = 0, verify_calls = verify_calls + 1 WHERE device_code_hash = ?",
      hmac(phone), enc(phone), mask(phone), hmac('otp|' + p.device_code_hash + '|' + otp), now() + OTP_TTL, p.device_code_hash);
    const spoken = otp.split('').join(' ');
    await placeCall({ accountId: null, to: phone, toMasked: mask(phone), purpose: 'verify',
      message: `رمز ربط سينك هو ${spoken}. أكرر: ${spoken}.` });
    return json(200, { ok: true, phone_masked: mask(phone), mock });
  }
  async function linkVerify(req) {
    const b = req.body || {};
    const p = await pairingByCode(b.code);
    if (!p || p.status !== 'verifying') return json(400, { error: 'bad_code', message: 'الرمز غير صحيح أو انتهت صلاحيته' });
    if (p.otp_expires <= now() || p.otp_attempts >= OTP_ATTEMPTS) {
      await db.run("UPDATE pairings SET status = 'expired' WHERE device_code_hash = ?", p.device_code_hash);
      return json(400, { error: 'expired', message: 'انتهت صلاحية رمز التحقق، ابدأ من جديد في Claude' });
    }
    await db.run('UPDATE pairings SET otp_attempts = otp_attempts + 1 WHERE device_code_hash = ?', p.device_code_hash);
    const want = hmac('otp|' + p.device_code_hash + '|' + String(b.otp || '').replace(/\D/g, ''));
    if (!crypto.timingSafeEqual(Buffer.from(want), Buffer.from(p.otp_hash)))
      return json(400, { error: 'wrong_otp', message: `رمز التحقق غير صحيح (متبقٍ ${OTP_ATTEMPTS - p.otp_attempts - 1})` });
    const token = rnd(32); const t = now();
    await db.tx(async () => {
      let acc = await db.first('SELECT id FROM accounts WHERE phone_lookup = ?', p.phone_lookup);
      if (!acc) { acc = { id: 'acc_' + rnd(9) };
        await db.run('INSERT INTO accounts(id, phone_lookup, phone_enc, phone_masked, created_at) VALUES (?,?,?,?,?)', acc.id, p.phone_lookup, p.phone_enc, p.phone_masked, t); }
      const devId = 'dev_' + rnd(9);
      await db.run('INSERT INTO devices(id, account_id, token_hash, name, created_at) VALUES (?,?,?,?,?)', devId, acc.id, sha(token), p.device_name, t);
      // the token is handed to the polling device exactly once, then erased (see pairPoll)
      await db.run("UPDATE pairings SET status = 'approved', account_id = ?, device_id = ?, token_once = ?, otp_hash = NULL WHERE device_code_hash = ?",
        acc.id, devId, enc(token), p.device_code_hash);
    });
    return json(200, { ok: true, message: 'تم الربط', phone_masked: p.phone_masked });
  }
  async function pairPoll(req) {
    const dc = String((req.body && req.body.device_code) || '');
    if (!(await rate('poll:' + sha(dc), 200, 600))) return json(429, { error: 'slow_down' });
    const p = await db.first('SELECT * FROM pairings WHERE device_code_hash = ?', sha(dc));
    if (!p) return json(400, { error: 'invalid_grant' });
    if (p.status === 'approved') {
      await db.run("UPDATE pairings SET status = 'consumed', token_once = NULL WHERE device_code_hash = ?", p.device_code_hash);
      return json(200, { status: 'approved', token: dec(p.token_once), phone_masked: p.phone_masked });
    }
    if (p.status === 'consumed') return json(400, { error: 'already_used' });
    if (p.status === 'expired' || p.expires_at <= now()) return json(400, { error: 'expired_token' });
    return json(200, { status: 'authorization_pending' });
  }

  // ---- events from the plugin ----
  function classify(e) {   // the server re-checks: only a passed project check is a confirmed success
    if (e.type === 'task_succeeded' && e.verification === 'check_passed' && e.check && e.check.passed === true) return 'task_succeeded';
    if (e.type === 'task_failed') return 'task_failed';
    if (e.type === 'task_succeeded' || e.type === 'task_completed_unverified') return 'task_completed_unverified';
    return null;
  }
  async function postEvent(req, dev) {
    if (!(await rate('dev-events:' + dev.id, 120, 3600))) return json(429, { error: 'rate_limited', retry_after: 3600 });
    const e = req.body || {};
    const eid = String(e.event_id || req.headers['idempotency-key'] || '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(eid)) return json(400, { error: 'bad_event_id' });
    const type = classify(e); if (!type) return json(400, { error: 'bad_type' });
    const s = settingsOf(dev);
    const callable = type === 'task_succeeded' || (type === 'task_failed' && s.call_on_failed) || (type === 'task_completed_unverified' && s.call_on_unverified);
    const status = dev.paused ? 'paused' : (callable ? 'pending' : 'recorded');
    const r = await db.run('INSERT OR IGNORE INTO events(account_id, device_id, event_id, type, client_type, kind, verification, summary, project, received_at, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      dev.account_id, dev.id, eid, type, String(e.type).slice(0, 40), String(e.kind || '').slice(0, 20), String(e.verification || '').slice(0, 40),
      String(e.summary || '').slice(0, 200), String(e.project || '').slice(0, 80), now(), status);
    if (!r.changes) return json(200, { duplicate: true, event_id: eid });
    return json(202, { accepted: true, event_id: eid, type, status });
  }

  // ---- grouping + limits: decides WHEN to call, never whether an event is kept ----
  function localParts(t, s) { const d = new Date((t + s.tz_offset_min * 60) * 1000); return { hour: d.getUTCHours(), dayStart: t - ((t + s.tz_offset_min * 60) % 86400) }; }
  function inQuiet(t, s) {
    if (s.quiet_start_hour === s.quiet_end_hour) return false;
    const h = localParts(t, s).hour;
    return s.quiet_start_hour < s.quiet_end_hour ? (h >= s.quiet_start_hour && h < s.quiet_end_hour) : (h >= s.quiet_start_hour || h < s.quiet_end_hour);
  }
  // Arabic number agreement: 1 مهمة / 2 مهمتان / 3-10 مهام / 11+ مهمة
  function phrase(n, f) { return n === 1 ? f[0] : n === 2 ? f[1] : n <= 10 ? `${n} ${f[2]}` : `${n} ${f[3]}`; }
  function message(counts) {
    const n = (k) => counts[k] || 0; const parts = [];
    if (n('task_succeeded')) parts.push('اكتملت ' + phrase(n('task_succeeded'), ['مهمة بنجاح وتم التحقق منها', 'مهمتان بنجاح وتم التحقق منهما', 'مهام بنجاح وتم التحقق منها', 'مهمة بنجاح وتم التحقق منها']));
    if (n('task_failed')) parts.push(phrase(n('task_failed'), ['مهمة لم تكتمل وتحتاج مراجعتك', 'مهمتان لم تكتملا وتحتاجان مراجعتك', 'مهام لم تكتمل وتحتاج مراجعتك', 'مهمة لم تكتمل وتحتاج مراجعتك']));
    if (n('task_completed_unverified')) parts.push(phrase(n('task_completed_unverified'), ['مهمة انتهت بدون تحقق آلي', 'مهمتان انتهتا بدون تحقق آلي', 'مهام انتهت بدون تحقق آلي', 'مهمة انتهت بدون تحقق آلي']));
    return `معاك سينك. ${parts.join('، و')}. لإيقاف الإشعارات اضغط 9.`;
  }
  async function tick() {   // run every few seconds (main.js) or by a cron trigger
    const t = now(); const out = [];
    const accounts = await db.all("SELECT DISTINCT a.* FROM accounts a JOIN events e ON e.account_id = a.id WHERE e.status = 'pending' AND a.paused = 0");
    for (const a of accounts) {
      const s = settingsOf(a);
      const pending = await db.all("SELECT id, type, received_at FROM events WHERE account_id = ? AND status = 'pending' ORDER BY id", a.id);
      const oldest = pending[0].received_at;
      let wait = null;
      if (t - oldest < s.group_window_sec) wait = 'grouping';
      else if (inQuiet(t, s)) wait = 'quiet_hours';
      else {
        const last = await db.first("SELECT MAX(created_at) AS m FROM calls WHERE account_id = ? AND purpose = 'notify'", a.id);
        const today = await db.first("SELECT COUNT(*) AS c FROM calls WHERE account_id = ? AND purpose = 'notify' AND created_at >= ?", a.id, localParts(t, s).dayStart);
        if (last.m && t - last.m < s.min_interval_sec) wait = 'min_interval';
        else if (today.c >= s.max_calls_per_day) wait = 'daily_cap';
      }
      if (wait) { out.push({ account: a.id, waiting: wait, pending: pending.length }); continue; }
      const counts = {}; for (const e of pending) counts[e.type] = (counts[e.type] || 0) + 1;
      const call = await placeCall({ accountId: a.id, to: dec(a.phone_enc), toMasked: a.phone_masked, purpose: 'notify', message: message(counts), eventCount: pending.length });
      const ids = pending.map((e) => e.id);
      if (call.status === 'completed') await db.run(`UPDATE events SET status = 'called', call_id = ? WHERE id IN (${ids.map(() => '?').join(',')})`, call.id, ...ids);
      out.push({ account: a.id, call: call.id, status: call.status, events: ids.length });   // failed call -> events stay pending
    }
    return out;
  }

  async function deviceStatus(dev) {
    const c = await db.all('SELECT type, status, COUNT(*) AS n FROM events WHERE account_id = ? GROUP BY type, status', dev.account_id);
    const calls = await db.first("SELECT COUNT(*) AS n FROM calls WHERE account_id = ? AND purpose = 'notify'", dev.account_id);
    const acc = await db.first('SELECT phone_masked, paused FROM accounts WHERE id = ?', dev.account_id);
    return json(200, { linked: true, device: dev.name, phone_masked: acc.phone_masked, paused: !!acc.paused,
      settings: settingsOf(dev), events: c, notification_calls: calls.n, mock });
  }
  async function setPaused(accountId, paused) {
    await db.tx(async () => {
      await db.run('UPDATE accounts SET paused = ? WHERE id = ?', paused ? 1 : 0, accountId);
      if (paused) await db.run("UPDATE events SET status = 'paused' WHERE account_id = ? AND status = 'pending'", accountId);
    });
  }
  async function updateSettings(dev, body) {
    const s = settingsOf(dev); const bad = [];
    for (const [k, v] of Object.entries(body || {})) {
      if (k in SETTING_BOUNDS) { const [lo, hi] = SETTING_BOUNDS[k]; if (Number.isInteger(v) && v >= lo && v <= hi) s[k] = v; else bad.push(k); }
      else if (['call_on_failed', 'call_on_unverified'].includes(k) && typeof v === 'boolean') s[k] = v;
      else bad.push(k);
    }
    if (bad.length) return json(400, { error: 'bad_settings', fields: bad });
    await db.run('UPDATE accounts SET settings = ? WHERE id = ?', JSON.stringify(s), dev.account_id);
    return json(200, { settings: s });
  }

  async function handle(req) {
    const { method, path } = req;
    try {
      if (method === 'GET' && path === '/healthz') return json(200, { ok: true, provider: provider.name });
      if (method === 'GET' && path === '/link') return html(pages.linkPage({ code: normCode(req.query.code || ''), mock }));
      if (method === 'POST' && path === '/v1/pair/start') return await pairStart(req);
      if (method === 'POST' && path === '/v1/pair/poll') return await pairPoll(req);
      if (method === 'POST' && path === '/link/start') return await linkStart(req);
      if (method === 'POST' && path === '/link/verify') return await linkVerify(req);
      if (mock && method === 'GET' && path === '/mock/phone') return html(pages.mockPhonePage());
      if (mock && method === 'GET' && path === '/mock/calls') {   // fictional numbers only; disabled when mock=false
        const phone = normPhone(req.query.to);
        if (!phone || phone === 'NOT_TEST') return json(400, { error: 'test_numbers_only' });
        const rows = await db.all('SELECT id, purpose, created_at, event_count, message, status, to_enc FROM calls ORDER BY created_at, rowid');
        return json(200, { calls: rows.filter((r) => dec(r.to_enc) === phone).map(({ to_enc, ...r }) => r) });
      }
      if (mock && method === 'POST' && path === '/mock/keypress') {   // simulates the callee pressing a key during a call
        const c = await db.first("SELECT * FROM calls WHERE id = ? AND purpose = 'notify'", String((req.body || {}).call_id || ''));
        if (!c) return json(404, { error: 'no_call' });
        await db.run('UPDATE calls SET digit = ? WHERE id = ?', String(req.body.digit).slice(0, 1), c.id);
        if (String(req.body.digit) === '9') await setPaused(c.account_id, true);
        return json(200, { ok: true, paused: String(req.body.digit) === '9' });
      }
      if (path.startsWith('/v1/')) {
        const dev = await deviceFrom(req);
        if (!dev) return json(401, { error: 'unauthorized' });
        if (method === 'POST' && path === '/v1/events') return await postEvent(req, dev);
        if (method === 'GET' && path === '/v1/device/status') return await deviceStatus(dev);
        if (method === 'POST' && path === '/v1/device/pause') { await setPaused(dev.account_id, true); return json(200, { paused: true }); }
        if (method === 'POST' && path === '/v1/device/resume') { await setPaused(dev.account_id, false); return json(200, { paused: false }); }
        if (method === 'POST' && path === '/v1/device/settings') return await updateSettings(dev, req.body);
        if (method === 'POST' && path === '/v1/device/unlink') { await db.run('UPDATE devices SET revoked_at = ? WHERE id = ?', now(), dev.id); return json(200, { unlinked: true }); }
      }
      return json(404, { error: 'not_found' });
    } catch (e) {
      return json(500, { error: 'internal' });
    }
  }
  return { handle, tick, _test: { message, inQuiet } };
}
module.exports = { createCore, DEFAULT_SETTINGS };
