# Sync AI Voice Notifications — prototype 0.4, Stage A (MOCK calls only)

A Claude Code plugin + a small service. When Claude finishes a task **and an independent check confirms it**,
the customer's phone gets a short Arabic call. Stage A: the call provider is a **mock** — no real calls, no
paid services, fictional test numbers only (`+1 XXX 555 0100…0199`).

## Customer journey (what the customer actually does)

| # | Step | Where |
|---|------|-------|
| 1 | `/plugin marketplace add mnagah80/sync-ai-voice-notifications` | Claude Code |
| 2 | `/plugin install sync-notify@sync` | Claude Code |
| 3 | `/sync-notify:link` → a link + temporary code (valid 10 min) | Claude Code |
| 4 | Open the link on the phone, type the number, tick consent, tap "اتصل بي للتحقق" | phone browser |
| 5 | Type the 4 digits the verification call says → "تم الربط" | phone browser |

Then nothing: verified task → (grouping window) → call. No GitHub account, no API key, no config file,
no server settings, no app on the phone, no Python. Other commands: `/sync-notify:status`, `:pause`, `:resume`, `:unlink`.

## What is a success (unchanged, and re-checked by the service)

| Situation | Event | Call by default |
|---|---|---|
| Claude stops / chats / answers a question (no claim) | nothing | — |
| Coding task, project tests run **by the hook** and pass | `task_succeeded` | yes: "اكتملت مهمة بنجاح وتم التحقق منها" |
| Tests fail (after one chance to fix) / Claude reports failure | `task_failed` | yes (setting `call_on_failed`) |
| No tests, or a non-coding task (deliverables exist) | `task_completed_unverified` | **no** (recorded; if enabled the call says "بدون تحقق آلي") |

The service accepts `task_succeeded` only with `verification: check_passed` and `check.passed: true`;
anything else is stored as `task_completed_unverified`.

## Events vs calls (nothing is dropped)

Every event is stored (`events` table) with a status: `pending` → `called` (linked to the call that announced it),
`recorded` (stored, no call by policy), or `paused` (stored while the customer paused calls).
Grouping and limits only decide **when** a call happens, never whether an event is kept:

| Setting (per customer) | Default | Effect |
|---|---|---|
| `group_window_sec` | 120 | events within the window after the first pending one → ONE call ("اكتملت 3 مهام…") |
| `min_interval_sec` | 300 | pending events wait for the next allowed call |
| `max_calls_per_day` | 10 | beyond it events wait until the next day |
| `quiet_start_hour` / `quiet_end_hour` / `tz_offset_min` | 23 / 8 / 0 | events wait until the morning |
| `call_on_failed` / `call_on_unverified` | true / false | which event types make a call |

On the customer's computer every event goes to an outbox first and leaves it only when the service accepted it
(offline, not linked yet, rate-limited → retried later; the service de-duplicates by `event_id`).

## Protection
- Pairing code: 6 characters, 10 minutes, one use. Verification code: 4 digits, 5 minutes, 5 attempts.
  Verification calls: 3 per pairing and 3 per number per day. Pairing starts: 20 per IP per hour. Events: 120 per device per hour.
- The device key is created by the service and collected by the plugin itself; stored 0600 on the computer, only
  as SHA-256 on the service, never printed. Phone numbers are AES-256-GCM encrypted (lookup by HMAC); calls are stored encrypted too.
- Isolation: every API call is scoped to the account of the presented device key.
- Stop: press 9 during any call · `/sync-notify:pause` · `/sync-notify:unlink` (revokes the key on the service, deletes it locally).
- Pages: strict CSP, no external resources, `no-store`, `DENY` framing.

## Files
```
plugin/sync-notify/     hooks (SessionStart, PreToolUse, Stop), commands (link/status/pause/resume/unlink), bin/sync_hook.js
server/                 core.js (pairing, events, grouping, limits), pages.js (Arabic RTL pages), db.js (node:sqlite),
                        mock_provider.js (records calls, places none), main.js (local runner)
tests/hook.test.js      plugin unit tests          node --test tests/hook.test.js
tests/server.test.js    service tests, fake clock  node --test tests/server.test.js
tests/journey.sh        whole journey from zero: fresh Claude config, no Python, install, link (phone = Playwright), real tasks
docs/PAIRING_AND_CALLS_DESIGN.md
```
Run the prototype service locally: `node server/main.js` (needs Node ≥ 22.5; no npm install).

## Not proven / not built
- Real calls (Stage B, needs approval), a public service address (the link is `127.0.0.1` in Stage A), web management page.
- Claude Cowork, claude.ai web/cloud sessions, Windows/macOS: not tested. Claude chat has no hooks.
