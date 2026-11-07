#!/usr/bin/env bash
# Real end-to-end scenarios with the Claude Code CLI + the sync-notify plugin + a local test receiver.
# None of the prompts mentions notifications: the event must come from the plugin alone.
# Nested sessions get narrow permissions only: file edits + running the project's unit tests.
set -uo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"; W="${1:?work dir}"; PORT=8799
rm -rf "$W"; mkdir -p "$W"; RECV="$W/received.jsonl"; : > "$RECV"
node "$P/receiver/receiver.js" $PORT "$RECV" & RPID=$!; trap 'kill $RPID 2>/dev/null' EXIT; sleep 1
export SYNC_RECEIVER_URL="http://127.0.0.1:$PORT/events"
fixture() {  # $1 dir, $2 test body
  mkdir -p "$1/.sync"; cd "$1"; git init -q
  printf 'def add(a, b):\n    raise NotImplementedError\n\ndef mul(a, b):\n    raise NotImplementedError\n' > mathlib.py
  printf 'import unittest, mathlib\nclass T(unittest.TestCase):\n%s\n' "$2" > test_mathlib.py
  echo '{"verify": "python3 -m unittest -q"}' > .sync/config.json; cd - >/dev/null
}
run() {  # $1 name, $2 dir, $3 prompt, $4 extra flag (optional)
  echo "===== $1"
  ( cd "$2" && timeout 600 claude -p "$3" --plugin-dir "$P/plugin/sync-notify" \
      --permission-mode acceptEdits --allowedTools "Read" "Edit" "Write" "Bash(python3:*)" "Bash(python:*)" \
      --output-format json ${4:-} > "$W/$1.out.json" 2>&1 )
  python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print('  claude: turns',d.get('num_turns'),'| subtype',d.get('subtype'),'| error',d.get('is_error'))" "$W/$1.out.json" 2>/dev/null || tail -c 300 "$W/$1.out.json"
  echo "  hook log:"; sed 's/^/    /' "$2/.sync/events.log" 2>/dev/null | cut -c1-230
}
fixture "$W/s1" '    def test_add(self): self.assertEqual(mathlib.add(2, 3), 5)'
run s1_success "$W/s1" "Implement add() in mathlib.py so the unit tests pass. Run the tests."
fixture "$W/s2" '    def test_add(self): self.assertEqual(mathlib.add(2, 3), 5)
    def test_impossible(self): self.assertEqual(open("/nonexistent/sync-key").read(), "42")'
run s2_impossible "$W/s2" "Make all unit tests pass. You must NOT modify test_mathlib.py and must NOT create files outside this project directory."
fixture "$W/s3" '    def test_add(self): self.assertEqual(mathlib.add(2, 3), 5)
    def test_mul(self): self.assertEqual(mathlib.mul(2, 3), 6)'
run s3_unfinished "$W/s3" "Implement add() and mul() in mathlib.py, add docstrings and type hints, then run the tests." "--max-turns 1"
echo "===== events received by the test receiver"; cat "$RECV"
