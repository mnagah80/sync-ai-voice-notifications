#!/usr/bin/env bash
# The whole customer journey from zero, Stage A (MOCK calls only, fictional numbers only):
#   customer's computer: brand-new Claude Code config, brand-new Sync dir, no Python on PATH, nothing preset
#     1 /plugin marketplace add   2 /plugin install   3 /sync-notify:link
#   customer's phone (Playwright, phone-sized): opens the link, enters a test number, confirms the mock verification call
#   real Claude tasks (prompts never mention notifications) -> verified success -> mock notification call
# The only thing that is not "real customer" here: SYNC_SERVER points at the local prototype service, because no
# public service exists before Stage B. Usage: tests/journey.sh <workdir> [marketplace-source, default file:// clone]
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"; W="${1:?work dir}"; SRC="${2:-}"; PORT=18788; PHONE="+1 202 555 0142"
rm -rf "$W"; mkdir -p "$W/bin" "$W/cfg" "$W/sync-home" "$W/state" "$W/shots"
FULLPATH="$PATH"
# --- Sync service (prototype, mock calls), DEFAULT policy: grouping window 120 s, min interval 300 s.
PORT=$PORT SYNC_STATE_DIR="$W/state" SYNC_QUIET_HOURS=off SYNC_TICK_MS=1000 \
  node "$P/server/main.js" > "$W/server.log" 2>&1 & SPID=$!; trap 'kill $SPID 2>/dev/null' EXIT; sleep 1
URL="http://127.0.0.1:$PORT"
# --- the customer's computer: nothing preset, no Python
for t in node npm npx claude git bash sh env cat ls mkdir rm cp mv sed grep head tail tr cut wc sort dirname basename which timeout date sleep; do
  b="$(command -v "$t")" && ln -sf "$b" "$W/bin/$t"; done
export PATH="$W/bin" CLAUDE_CONFIG_DIR="$W/cfg" SYNC_NOTIFY_HOME="$W/sync-home" SYNC_SERVER="$URL"
command -v python3 >/dev/null && { echo "python still on PATH"; exit 1; }
if [ -z "$SRC" ]; then git clone -q "file://$P" "$W/market-src" && SRC="$W/market-src"; fi
mkdir -p "$W/code" && cd "$W/code" && git init -q
printf 'exports.add = (a, b) => { throw new Error("TODO"); };\nexports.mul = (a, b) => { throw new Error("TODO"); };\n' > math.js
printf 'const t=require("node:test"),a=require("node:assert"),m=require("./math");\nt.test("add",()=>a.equal(m.add(2,3),5));\n' > math.test.js
printf '{"name":"demo","version":"1.0.0","scripts":{"test":"node --test"}}\n' > package.json
mkdir -p "$W/doc" && (cd "$W/doc" && git init -q && echo "# Launch checklist" > launch-checklist.md)
ask() {  # $1 name, $2 dir, $3 prompt, $4 file the task may edit. Default permission mode, narrow allow-list.
  ( cd "$2" && timeout 600 claude -p "$3" --allowedTools "Read" "Edit($4)" "Bash(npm test:*)" "Bash(node --test:*)" \
      --output-format json < /dev/null > "$W/$1.json" 2>&1 )
  node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");const d=JSON.parse(s.split("\n").filter(x=>x.startsWith("{")).pop());
    console.log(`  [${process.argv[2]}] turns ${d.num_turns}, permission prompts denied: ${d.permission_denials.length}`);
    if(process.argv[3])console.log(d.result.split("\n").map(l=>"  | "+l).join("\n"))' "$W/$1.json" "$1" "${5:-}"
}
echo "== STEP 1  /plugin marketplace add $SRC";  claude plugin marketplace add "$SRC" 2>&1 | tail -1
echo "== STEP 2  /plugin install sync-notify@sync"; claude plugin install sync-notify@sync 2>&1 | tail -1
echo "== STEP 3  /sync-notify:link";  ask link "$W/code" "/sync-notify:link" none.txt show
LINK="$(grep -o "$URL/link?code=[A-Z0-9-]*" "$W/link.json" | head -1)"; echo "  link: $LINK"
echo "== STEP 4-5 (on the phone) open link, test number, consent, verification call code"
PATH="$FULLPATH" node "$P/tests/phone.js" "$LINK" "$PHONE" "$W/shots" || exit 1
echo "== Tasks (the prompts never mention notifications)"
ask code1 "$W/code" "Implement add() in math.js so the tests pass. Run the tests." math.js
ask doc1 "$W/doc" "Add a short 5-bullet checklist for launching a small online shop to launch-checklist.md." launch-checklist.md
ask code2 "$W/code" "Also implement mul() in math.js (multiplication) and add a test for it in math.test.js, then run the tests." "*.js"
ask question "$W/doc" "What is 17 * 23? Answer with the number only." none.txt
echo "== waiting for the grouping window (default 120 s) ..."
for i in {1..60}; do node -e 'fetch(process.argv[1]+"/mock/calls?to=%2B12025550142").then(r=>r.json()).then(d=>process.exit(d.calls.some(c=>c.purpose==="notify")?0:1))' "$URL" && break; sleep 5; done; sleep 2
echo "== /sync-notify:status"; ask status "$W/code" "/sync-notify:status" none.txt show
PATH="$FULLPATH" node -e '
  const {chromium,devices}=require("playwright");(async()=>{const b=await chromium.launch();const c=await b.newContext({...devices["iPhone 13"],locale:"ar-EG"});
  const p=await c.newPage();await p.goto(process.argv[1]+"/mock/phone?to=%2B12025550142");await p.waitForSelector(".call");await p.waitForTimeout(500);
  await p.screenshot({path:process.argv[2]+"/6-mock-notification-call.png"});await b.close();})()' "$URL" "$W/shots"
echo "== RESULT: events vs calls (mock call log for $PHONE)"
node -e 'fetch(process.argv[1]+"/mock/calls?to=%2B12025550142").then(r=>r.json()).then(d=>{for(const c of d.calls)console.log(`  ${c.purpose==="verify"?"verification":"notification"} call | events covered: ${c.event_count} | says: ${c.message}`)})' "$URL"
echo "  outbox left on the customer's computer: $(ls "$W/sync-home/outbox" 2>/dev/null | wc -l)"
echo "  local event log:"; cat "$W"/code/.sync/events.log "$W"/doc/.sync/events.log 2>/dev/null | node -e 'require("fs").readFileSync(0,"utf8").trim().split("\n").forEach(l=>{const e=JSON.parse(l);console.log("   ",e.type?`${e.type} (${e.verification}) -> ${e.sent}`:e.stop)})'
