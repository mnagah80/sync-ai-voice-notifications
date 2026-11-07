#!/usr/bin/env bash
# From-scratch install test, as a customer would do it, in an isolated setup:
#  - a brand-new Claude Code config dir (no plugins, no settings)  -> CLAUDE_CONFIG_DIR
#  - a brand-new Sync link dir                                     -> SYNC_NOTIFY_HOME
#  - PATH WITHOUT python (only node, claude, git, coreutils)       -> proves Node is the only runtime needed
#  - the plugin installed from a git URL marketplace (a clone of this repo), not from the working tree
# Then real `claude -p` tasks whose prompts never mention notifications; the event must arrive by itself.
# Usage: tests/fresh_install.sh <workdir> [marketplace-source]   (default source: file:// clone of this repo)
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"; W="${1:?work dir}"; SRC="${2:-}"
rm -rf "$W"; mkdir -p "$W/bin" "$W/cfg" "$W/sync-home"; RECV="$W/received.jsonl"; : > "$RECV"; PORT=8798; TOKEN="test-$RANDOM$RANDOM"
for t in node npm npx claude git bash sh env cat ls mkdir rm cp mv sed grep head tail tr cut wc sort dirname basename which timeout date sleep; do
  b="$(command -v "$t")" && ln -sf "$b" "$W/bin/$t"; done
export PATH="$W/bin"; command -v python3 >/dev/null && { echo "python still on PATH"; exit 1; }
export CLAUDE_CONFIG_DIR="$W/cfg" SYNC_NOTIFY_HOME="$W/sync-home"
node "$P/receiver/receiver.js" $PORT "$RECV" "$TOKEN" & RPID=$!; trap 'kill $RPID 2>/dev/null' EXIT; sleep 1

# SRC may be a GitHub "owner/repo" (real customer path) or empty = file:// clone of this checkout
if [ -z "$SRC" ]; then git clone -q "file://$P" "$W/market-src" && SRC="$W/market-src"; fi
echo "== customer step 1: add marketplace + install plugin ($SRC)"
claude plugin marketplace add "$SRC" 2>&1 | tail -2
claude plugin install sync-notify@sync 2>&1 | tail -2
echo "== customer step 2: link (pairing code)"
node "$CLAUDE_CONFIG_DIR"/plugins/cache/sync/sync-notify/*/bin/sync_hook.js link "${SYNC_LINK_URL:-http://127.0.0.1:$PORT/events}" "$TOKEN"

task() {  # $1 name, $2 dir, $3 prompt, $4 the ONE file the task may edit
  # Default permission mode. Claude may edit only the task's own file and run the tests; it has NO general
  # permission to write files, so the completion claim gets through only via the plugin's own narrow approval.
  echo "===== $1"
  ( cd "$2" && timeout 600 claude -p "$3" --allowedTools "Read" "Edit($4)" "Bash(npm test:*)" "Bash(node --test:*)" \
      --output-format json > "$W/$1.out.json" 2>&1 )
  node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log("  claude: turns",d.num_turns,"| subtype",d.subtype,"| permission denials:",JSON.stringify((d.permission_denials||[]).map(x=>x.tool_name+" "+(x.tool_input.file_path||x.tool_input.command||""))))' "$W/$1.out.json" 2>/dev/null || tail -c 300 "$W/$1.out.json"
  echo "  hook log:"; sed 's/^/    /' "$2/.sync/events.log" 2>/dev/null | cut -c1-260
}
# coding task in a Node project: the check (npm test) is auto-detected, no .sync/config.json
mkdir -p "$W/code" && cd "$W/code" && git init -q
printf 'exports.add = (a, b) => { throw new Error("TODO"); };\n' > math.js
printf 'const t=require("node:test"),a=require("node:assert"),m=require("./math");\nt.test("add",()=>a.equal(m.add(2,3),5));\n' > math.test.js
printf '{"name":"demo","version":"1.0.0","scripts":{"test":"node --test"}}\n' > package.json; cd - >/dev/null
task code_task "$W/code" "Implement add() in math.js so the tests pass. Run the tests." math.js
# non-coding task: a document, no tests exist -> must NOT be reported as verified success
mkdir -p "$W/doc" && (cd "$W/doc" && git init -q && echo "# Launch checklist" > launch-checklist.md)
task doc_task "$W/doc" "Add a short 5-bullet checklist for launching a small online shop to launch-checklist.md." launch-checklist.md
# a plain question -> nothing must be sent
task question "$W/doc" "What is 17 * 23? Answer with the number only." none.txt
echo "===== events received (token checked by the receiver)"; cat "$RECV"
