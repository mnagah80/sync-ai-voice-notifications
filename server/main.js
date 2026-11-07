#!/usr/bin/env node
// Local runner for the Sync notify service (Stage A: mock call provider only, no network calls out).
// Usage: node server/main.js   env: PORT (8787), SYNC_STATE_DIR (./.sync-server), SYNC_BASE_URL,
//        SYNC_GROUP_WINDOW_SEC / SYNC_MIN_INTERVAL_SEC (defaults for new accounts), SYNC_TICK_MS (2000)
'use strict';
process.removeAllListeners('warning');   // hide node:sqlite "experimental" notice
const http = require('http'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { open } = require('./db'); const { createCore } = require('./core'); const { createMockProvider } = require('./mock_provider');

const PORT = Number(process.env.PORT || 8787);
const STATE = path.resolve(process.env.SYNC_STATE_DIR || '.sync-server');
fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
const secretFile = path.join(STATE, 'server_secret');   // generated once, 0600, never logged
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
const defaults = {};
if (process.env.SYNC_GROUP_WINDOW_SEC) defaults.group_window_sec = Number(process.env.SYNC_GROUP_WINDOW_SEC);
if (process.env.SYNC_MIN_INTERVAL_SEC) defaults.min_interval_sec = Number(process.env.SYNC_MIN_INTERVAL_SEC);
if (process.env.SYNC_QUIET_HOURS === 'off') { defaults.quiet_start_hour = 0; defaults.quiet_end_hour = 0; }

const core = createCore({ db: open(path.join(STATE, 'sync.sqlite3')), provider: createMockProvider(),
  secret: fs.readFileSync(secretFile, 'utf8').trim(), baseUrl: process.env.SYNC_BASE_URL || `http://127.0.0.1:${PORT}`,
  mock: true, testNumbersOnly: true, defaults });

http.createServer((q, s) => {
  let raw = ''; q.on('data', (c) => { raw += c; if (raw.length > 32768) q.destroy(); });
  q.on('end', async () => {
    const u = new URL(q.url, 'http://x'); let body = null;
    if (raw) { try { body = JSON.parse(raw); } catch { s.writeHead(400).end(); return; } }
    const r = await core.handle({ method: q.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: q.headers,
      body, ip: q.socket.remoteAddress });
    s.writeHead(r.status, r.headers).end(r.body);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`sync server (MOCK calls) on http://127.0.0.1:${PORT}`));

setInterval(async () => { for (const r of await core.tick()) if (r.call) console.log('mock call', JSON.stringify(r)); }, Number(process.env.SYNC_TICK_MS || 2000));
