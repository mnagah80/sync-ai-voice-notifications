#!/usr/bin/env node
// Test receiver (prototype). Usage: node receiver.js <port> <out.jsonl> [expected_token]
// Accepts POST JSON, checks the Bearer token if one is given, appends the event to out.jsonl, replies 204.
'use strict';
const http = require('http'); const fs = require('fs');
const [port, out, token] = process.argv.slice(2);
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; if (b.length > 65536) req.destroy(); });
  req.on('end', () => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    if (token && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    try { fs.appendFileSync(out, JSON.stringify(JSON.parse(b)) + '\n'); res.writeHead(204).end(); }
    catch { res.writeHead(400).end(); }
  });
}).listen(Number(port), '127.0.0.1');
