// Service core tests (no network, mock provider, fake clock): node --test tests/server.test.js
'use strict';
process.removeAllListeners('warning');
const test = require('node:test'); const assert = require('node:assert');
const { open } = require('../server/db'); const { createCore } = require('../server/core');
const { createMockProvider } = require('../server/mock_provider');

function setup(defaults = {}) {
  let t = 1_800_000_000 + 12 * 3600 - (1_800_000_000 % 86400);   // 12:00 UTC, outside quiet hours
  const db = open(':memory:');
  const core = createCore({ db, provider: createMockProvider(), secret: 'x'.repeat(64), now: () => t, baseUrl: 'http://t', defaults });
  const call = async (method, path, body, headers = {}, ip = '10.0.0.1', query = {}) => {
    const r = await core.handle({ method, path, body, headers, ip, query });
    return { status: r.status, d: r.headers['content-type'].startsWith('application/json') ? JSON.parse(r.body) : r.body };
  };
  const otpOf = async (phone) => {
    const c = (await call('GET', '/mock/calls', null, {}, 'ip', { to: phone })).d.calls.filter((x) => x.purpose === 'verify').at(-1);
    return c.message.match(/(\d) (\d) (\d) (\d)/).slice(1).join('');
  };
  async function pair(phone, ip = '10.0.0.1') {
    const s = (await call('POST', '/v1/pair/start', { device_name: 'laptop' }, {}, ip)).d;
    assert.equal((await call('POST', '/link/start', { code: s.user_code, phone, consent: true }, {}, ip)).status, 200);
    assert.equal((await call('POST', '/link/verify', { code: s.user_code, otp: await otpOf(phone) }, {}, ip)).status, 200);
    const p = (await call('POST', '/v1/pair/poll', { device_code: s.device_code })).d;
    assert.equal(p.status, 'approved'); return p.token;
  }
  const auth = (tok) => ({ authorization: `Bearer ${tok}` });
  let n = 0;
  const ev = (type, extra = {}) => ({ event_id: 'evt' + String(++n).padStart(8, '0'), type, kind: 'code',
    verification: type === 'task_succeeded' ? 'check_passed' : 'none', check: type === 'task_succeeded' ? { passed: true } : null, summary: 's', ...extra });
  return { core, db, call, pair, auth, ev, otpOf, adv: (s) => { t += s; }, now: () => t };
}
const calls = async (h, phone) => (await h.call('GET', '/mock/calls', null, {}, 'ip', { to: phone })).d.calls.filter((c) => c.purpose === 'notify');

test('full pairing: code -> verification call -> token once; page served', async () => {
  const h = setup(); const s = (await h.call('POST', '/v1/pair/start', {})).d;
  assert.match(s.user_code, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/); assert.equal(s.expires_in, 600);
  assert.match((await h.call('GET', '/link', null, {}, 'ip', { code: s.user_code })).d, new RegExp(s.user_code));
  assert.equal((await h.call('POST', '/v1/pair/poll', { device_code: s.device_code })).d.status, 'authorization_pending');
  await h.call('POST', '/link/start', { code: s.user_code.toLowerCase().replace('-', ''), phone: '+1 202 555 0101', consent: true });
  assert.equal((await h.call('POST', '/link/verify', { code: s.user_code, otp: await h.otpOf('+12025550101') })).d.message, 'تم الربط');
  const p = (await h.call('POST', '/v1/pair/poll', { device_code: s.device_code })).d; assert.ok(p.token.length >= 40);
  assert.equal((await h.call('POST', '/v1/pair/poll', { device_code: s.device_code })).d.error, 'already_used');
  assert.equal((await h.call('GET', '/v1/device/status', null, h.auth(p.token))).d.phone_masked, '+1202•••01');
});

test('pairing code expires after 10 minutes; OTP expires; 5 wrong OTPs kill the pairing', async () => {
  const h = setup(); const s = (await h.call('POST', '/v1/pair/start', {})).d; h.adv(601);
  assert.equal((await h.call('POST', '/link/start', { code: s.user_code, phone: '+12025550102', consent: true })).d.error, 'bad_code');
  assert.equal((await h.call('POST', '/v1/pair/poll', { device_code: s.device_code })).d.error, 'expired_token');
  const s2 = (await h.call('POST', '/v1/pair/start', {})).d;
  await h.call('POST', '/link/start', { code: s2.user_code, phone: '+12025550102', consent: true });
  for (let i = 0; i < 5; i++) assert.equal((await h.call('POST', '/link/verify', { code: s2.user_code, otp: '0000' === (await h.otpOf('+12025550102')) ? '1111' : '0000' })).d.error, 'wrong_otp');
  assert.equal((await h.call('POST', '/link/verify', { code: s2.user_code, otp: await h.otpOf('+12025550102') })).d.error, 'expired');
  const s3 = (await h.call('POST', '/v1/pair/start', {})).d; await h.call('POST', '/link/start', { code: s3.user_code, phone: '+12025550103', consent: true });
  h.adv(301); assert.equal((await h.call('POST', '/link/verify', { code: s3.user_code, otp: await h.otpOf('+12025550103') })).d.error, 'expired');
});

test('only fictional test numbers, consent required, verification calls limited', async () => {
  const h = setup(); const s = (await h.call('POST', '/v1/pair/start', {})).d;
  assert.equal((await h.call('POST', '/link/start', { code: s.user_code, phone: '+201001234567', consent: true })).d.error, 'test_numbers_only');
  assert.equal((await h.call('POST', '/link/start', { code: s.user_code, phone: '+12025550104', consent: false })).d.error, 'consent_required');
  for (let i = 0; i < 3; i++) assert.equal((await h.call('POST', '/link/start', { code: s.user_code, phone: '+12025550104', consent: true })).status, 200);
  assert.equal((await h.call('POST', '/link/start', { code: s.user_code, phone: '+12025550104', consent: true })).status, 429);
  assert.equal((await h.call('GET', '/mock/calls', null, {}, 'ip', { to: '+201001234567' })).d.error, 'test_numbers_only');
});

test('rate limit on pairing starts per IP', async () => {
  const h = setup(); for (let i = 0; i < 20; i++) assert.equal((await h.call('POST', '/v1/pair/start', {}, {}, '9.9.9.9')).status, 200);
  assert.equal((await h.call('POST', '/v1/pair/start', {}, {}, '9.9.9.9')).status, 429);
  assert.equal((await h.call('POST', '/v1/pair/start', {}, {}, '8.8.8.8')).status, 200);
});

test('customer isolation: tokens only reach their own account', async () => {
  const h = setup({ group_window_sec: 0, min_interval_sec: 0 });
  const a = await h.pair('+12025550110'); const b = await h.pair('+12025550111');
  await h.call('POST', '/v1/events', h.ev('task_succeeded'), h.auth(a));
  await h.call('POST', '/v1/device/pause', null, h.auth(b));
  assert.equal((await h.call('GET', '/v1/device/status', null, h.auth(a))).d.paused, false);
  await h.core.tick();
  assert.equal((await calls(h, '+12025550110')).length, 1); assert.equal((await calls(h, '+12025550111')).length, 0);
  assert.equal((await h.call('GET', '/v1/device/status', null, h.auth(b))).d.events.length, 0);
  assert.equal((await h.call('GET', '/v1/device/status', null, { authorization: 'Bearer ' + 'A'.repeat(43) })).status, 401);
});

test('duplicate events are stored once, also across retries', async () => {
  const h = setup(); const tok = await h.pair('+12025550120'); const e = h.ev('task_succeeded');
  assert.equal((await h.call('POST', '/v1/events', e, h.auth(tok))).status, 202);
  assert.equal((await h.call('POST', '/v1/events', e, h.auth(tok))).d.duplicate, true);
  const st = (await h.call('GET', '/v1/device/status', null, h.auth(tok))).d.events;
  assert.equal(st.reduce((s, r) => s + r.n, 0), 1);
});

test('unverified is never success: the server re-checks the evidence', async () => {
  const h = setup({ group_window_sec: 0, min_interval_sec: 0 }); const tok = await h.pair('+12025550130');
  const fake = h.ev('task_succeeded', { verification: 'none', check: null });   // claims success without a passed check
  assert.equal((await h.call('POST', '/v1/events', fake, h.auth(tok))).d.type, 'task_completed_unverified');
  assert.equal((await h.call('POST', '/v1/events', h.ev('task_completed_unverified', { kind: 'other' }), h.auth(tok))).d.status, 'recorded');
  await h.core.tick(); assert.equal((await calls(h, '+12025550130')).length, 0, 'no call for unverified by default');
  await h.call('POST', '/v1/device/settings', { call_on_unverified: true }, h.auth(tok));
  await h.call('POST', '/v1/events', h.ev('task_completed_unverified'), h.auth(tok)); await h.core.tick();
  const c = await calls(h, '+12025550130'); assert.equal(c.length, 1);
  assert.match(c[0].message, /بدون تحقق آلي/); assert.doesNotMatch(c[0].message, /تم التحقق منها/);
});

test('grouping: 5 events -> 1 call; every event kept and linked to the call', async () => {
  const h = setup({ group_window_sec: 120, min_interval_sec: 0 }); const tok = await h.pair('+12025550140');
  for (let i = 0; i < 4; i++) { await h.call('POST', '/v1/events', h.ev('task_succeeded'), h.auth(tok)); h.adv(20); }
  await h.call('POST', '/v1/events', h.ev('task_failed'), h.auth(tok));
  assert.equal((await h.core.tick())[0].waiting, 'grouping');
  h.adv(60); await h.core.tick();
  const c = await calls(h, '+12025550140'); assert.equal(c.length, 1); assert.equal(c[0].event_count, 5);
  assert.match(c[0].message, /اكتملت 4 مهام بنجاح وتم التحقق منها/); assert.match(c[0].message, /مهمة لم تكتمل/);
  assert.equal(h.core._test.message({ task_succeeded: 2 }), 'معاك سينك. اكتملت مهمتان بنجاح وتم التحقق منهما. لإيقاف الإشعارات اضغط 9.');
  const rows = await h.db.all("SELECT status, call_id FROM events"); assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.status === 'called' && r.call_id === rows[0].call_id));
});

test('limits defer, never drop: min interval, daily cap, quiet hours', async () => {
  const h = setup({ group_window_sec: 0, min_interval_sec: 600, max_calls_per_day: 2 }); const tok = await h.pair('+12025550150');
  const post = () => h.call('POST', '/v1/events', h.ev('task_succeeded'), h.auth(tok));
  await post(); await h.core.tick();                                   // call 1
  await post(); assert.equal((await h.core.tick())[0].waiting, 'min_interval');
  h.adv(600); await h.core.tick();                                      // call 2
  h.adv(600); await post(); await post(); assert.equal((await h.core.tick())[0].waiting, 'daily_cap');
  assert.equal((await calls(h, '+12025550150')).length, 2);
  h.adv(86400 - 1200 - 4 * 3600);                                       // next day 08:00 -> allowed
  await h.core.tick(); const c = await calls(h, '+12025550150'); assert.equal(c.length, 3); assert.equal(c[2].event_count, 2);
  const all = await h.db.all('SELECT status FROM events'); assert.equal(all.length, 4); assert.ok(all.every((r) => r.status === 'called'));
  h.adv(15 * 3600); await post(); assert.equal((await h.core.tick())[0].waiting, 'quiet_hours');   // 23:00
  h.adv(9 * 3600); await h.core.tick();                                                            // 08:00 next day
  const fin = await h.db.all('SELECT status FROM events'); assert.equal(fin.length, 5); assert.ok(fin.every((r) => r.status === 'called'));
});

test('stop: press 9 during a call, pause/resume, unlink revokes the token', async () => {
  const h = setup({ group_window_sec: 0, min_interval_sec: 0 }); const tok = await h.pair('+12025550160');
  await h.call('POST', '/v1/events', h.ev('task_succeeded'), h.auth(tok)); await h.core.tick();
  const [c] = await calls(h, '+12025550160'); assert.match(c.message, /اضغط 9/);
  assert.equal((await h.call('POST', '/mock/keypress', { call_id: c.id, digit: '9' })).d.paused, true);
  const e = (await h.call('POST', '/v1/events', h.ev('task_succeeded'), h.auth(tok))).d; assert.equal(e.status, 'paused');
  await h.core.tick(); assert.equal((await calls(h, '+12025550160')).length, 1, 'paused -> stored, no call');
  await h.call('POST', '/v1/device/resume', null, h.auth(tok));
  await h.call('POST', '/v1/events', h.ev('task_succeeded'), h.auth(tok)); await h.core.tick();
  assert.equal((await calls(h, '+12025550160')).length, 2);
  assert.equal((await h.call('POST', '/v1/device/unlink', null, h.auth(tok))).d.unlinked, true);
  assert.equal((await h.call('POST', '/v1/events', h.ev('task_succeeded'), h.auth(tok))).status, 401);
});

test('stored data: phone encrypted, token only as hash', async () => {
  const h = setup(); const tok = await h.pair('+12025550170');
  const dump = JSON.stringify([await h.db.all('SELECT * FROM accounts'), await h.db.all('SELECT * FROM devices'),
    await h.db.all('SELECT * FROM pairings'), await h.db.all('SELECT * FROM calls')]);
  assert.ok(!dump.includes('15550170')); assert.ok(!dump.includes(tok));
});

test('settings are validated', async () => {
  const h = setup(); const tok = await h.pair('+12025550180');
  assert.equal((await h.call('POST', '/v1/device/settings', { group_window_sec: 30, max_calls_per_day: 3 }, h.auth(tok))).status, 200);
  assert.equal((await h.call('POST', '/v1/device/settings', { max_calls_per_day: 9999 }, h.auth(tok))).status, 400);
  assert.equal((await h.call('POST', '/v1/device/settings', { phone: '+1' }, h.auth(tok))).status, 400);
});
