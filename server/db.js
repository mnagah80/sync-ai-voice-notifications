'use strict';
// Storage. Local prototype: node:sqlite (built into Node >= 22.5, no npm install).
// Every method is awaited by the core, so a Cloudflare D1 adapter (async) can replace this file later.
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, phone_lookup TEXT UNIQUE NOT NULL, phone_enc TEXT NOT NULL, phone_masked TEXT NOT NULL,
  created_at INTEGER NOT NULL, paused INTEGER NOT NULL DEFAULT 0, settings TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), token_hash TEXT UNIQUE NOT NULL,
  name TEXT, created_at INTEGER NOT NULL, revoked_at INTEGER, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS pairings (
  device_code_hash TEXT PRIMARY KEY, user_code TEXT UNIQUE NOT NULL, device_name TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL,
  phone_lookup TEXT, phone_enc TEXT, phone_masked TEXT, otp_hash TEXT, otp_expires INTEGER,
  otp_attempts INTEGER NOT NULL DEFAULT 0, verify_calls INTEGER NOT NULL DEFAULT 0, account_id TEXT, device_id TEXT,
  token_once TEXT);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, device_id TEXT NOT NULL, event_id TEXT NOT NULL,
  type TEXT NOT NULL, client_type TEXT NOT NULL, kind TEXT, verification TEXT, summary TEXT, project TEXT,
  received_at INTEGER NOT NULL, status TEXT NOT NULL, call_id TEXT, UNIQUE(device_id, event_id));
CREATE INDEX IF NOT EXISTS events_pending ON events(account_id, status);
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY, account_id TEXT, to_enc TEXT NOT NULL, to_masked TEXT NOT NULL, purpose TEXT NOT NULL,
  created_at INTEGER NOT NULL, event_count INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL,
  status TEXT NOT NULL, provider TEXT NOT NULL, provider_ref TEXT, digit TEXT);
CREATE TABLE IF NOT EXISTS rate (key TEXT PRIMARY KEY, win INTEGER NOT NULL, count INTEGER NOT NULL);
`;

function open(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  return {
    async run(sql, ...p) { return db.prepare(sql).run(...p); },
    async first(sql, ...p) { return db.prepare(sql).get(...p) || null; },
    async all(sql, ...p) { return db.prepare(sql).all(...p); },
    async tx(fn) { db.exec('BEGIN IMMEDIATE'); try { const r = await fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    close() { db.close(); },
  };
}
module.exports = { open };
