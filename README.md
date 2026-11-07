# Sync AI Voice Notifications — prototype 0.3 (no calls yet)

A Claude Code plugin that sends a **task-completion event automatically** when Claude finishes a task
— without the user asking — and only after an independent check. Phone calls are a later phase.

## What the customer does (Claude Code on their own computer)

| # | Step | Where |
|---|------|-------|
| 1 | `/plugin marketplace add mnagah80/sync-ai-voice-notifications` | inside Claude Code |
| 2 | `/plugin install sync-notify@sync` | inside Claude Code |
| 3 | Link once with the pairing code from the Sync website (`/sync-notify:link <code>` — planned; today: `node <plugin>/bin/sync_hook.js link <https-url> <token>`) | inside Claude Code |

Requirements: Claude Code only (it already includes Node). No Python, no GitHub account or token, no
GitHub Actions, no config file per project. The repository must be **public** for step 1 to work without a token.

## How success is decided (stopping is never success)

| Situation | Event |
|---|---|
| Claude stops, answers a question, chats, or runs out of turns (no claim) | nothing |
| Claude claims `failed` | `task_failed` |
| Coding task, the project's tests (auto-detected: `npm test`, pytest, unittest, cargo, go, make) pass — run **by the hook**, not by Claude | `task_succeeded` (`verification: check_passed`) |
| Coding task, tests fail | stop blocked once so Claude fixes it, then `task_failed` |
| Coding task, project has no tests | `task_completed_unverified` (never "succeeded") |
| Non-coding task (document, research …), listed deliverables exist and are non-empty | `task_completed_unverified` (`deliverables_exist`) |
| Non-coding task, a listed deliverable is missing | blocked once, then `task_failed` |

Events are sent once (idempotency key = `event_id`), with `Authorization: Bearer <pairing token>`, over HTTPS.
A send failure never breaks the Claude session.
No permission prompts: the plugin pre-approves exactly one action — a `Write` of JSON to `<project>/.sync/complete.json`
(not other files, not Bash, not a symlinked `.sync`). `.sync/` is git-ignored automatically. Behind an HTTPS proxy the hook enables Node's proxy support.

## Files
```
.claude-plugin/marketplace.json        marketplace "sync"
plugin/sync-notify/                    the plugin (hooks/hooks.json + bin/sync_hook.js, Node, no npm deps)
receiver/receiver.js                   local test receiver (token-checked)
tests/hook.test.js                     unit tests: node --test tests/hook.test.js
tests/fresh_install.sh                 from-scratch install (fresh Claude config, no Python on PATH) + real tasks
tests/run_scenarios.sh                 v0.1 scenario runner (Python fixtures)
```

## Proven by test (2026-11-07, Claude Code 2.1.319, Linux)
- Fresh config dir, marketplace add + install from a git clone, no Python on PATH: coding task → `task_succeeded`;
  document task → `task_completed_unverified`; plain question → nothing.
- Default permission mode with no general write permission: 0 permission denials, events still delivered.
- Real Claude task → event delivered over **HTTPS to an external server** (ntfy.sh) and read back from it.

## Not proven / not supported
- Claude Cowork, the claude.ai web/cloud sessions and Windows/macOS: **not tested**.
- Claude chat (claude.ai / apps) has no hooks → no automatic events.
- No calling service, no receiving server and no customer accounts exist yet.
