#!/usr/bin/env bash
# Put a backed-up trip plan into the backend.
#
# WHY: tools/backup-plan.sh takes copies; this is the other half. After the old
# database died for the third time around 2026-10-08, getting the trip back meant
# having a way to push a snapshot into a freshly built backend. This is that way, and
# it is how the trip was moved onto the Google Sheet.
#
# It reads the backend URL out of config.js, so it always writes wherever the site is
# currently pointed. Set up the Apps Script and put its URL in config.js FIRST — see
# apps-script/SETUP.md.
#
# Usage:  bash tools/restore-plan.sh <plan-id> <backup-file> [--overwrite]
#
# It refuses to write over a plan that already has contents unless you pass
# --overwrite, because the usual way to destroy a trip is to restore an old copy on
# top of a good one.

set -euo pipefail

PLAN_ID="${1:-}"
FILE="${2:-}"
FORCE="${3:-}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$HERE/config.js"

if [ -z "$PLAN_ID" ] || [ -z "$FILE" ]; then
  echo "Usage: bash tools/restore-plan.sh <plan-id> <backup-file> [--overwrite]"
  echo
  echo "Available backups:"
  ls -1t "${BACKUP_DIR:-$HOME/TripTrackerBackups}"/plan_*.json 2>/dev/null | head -10 || echo "  (none found)"
  exit 2
fi

if [ ! -f "$FILE" ]; then
  echo "No such backup file: $FILE"
  exit 2
fi

# BACKEND_URL overrides config.js. It exists so this script can be exercised against
# a local stand-in for the Apps Script endpoint, which is how it was tested before the
# real deployment existed.
URL="${BACKEND_URL:-$(grep -o 'https://script\.google\.com/macros/s/[A-Za-z0-9_-]*/exec' "$CONFIG" | head -1)}"
if [ -z "$URL" ]; then
  echo "Could not find the Apps Script URL in $CONFIG"
  echo "Set up the backend first: apps-script/SETUP.md"
  exit 1
fi
echo "Backend: $URL"

# A bad restore that "succeeds" is worse than one that fails loudly.
SIZE=$(wc -c < "$FILE")
if [ "$SIZE" -lt 50 ] || [ "$(head -c 4 "$FILE")" = "null" ]; then
  echo "That file does not look like a plan ($SIZE bytes). Nothing sent."
  exit 1
fi
if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$FILE" 2>/dev/null; then
  echo "That file is not valid JSON. Nothing sent."
  exit 1
fi

ITEMS=$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String((p.items||[]).length))' "$FILE")
HOUSE=$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String((p.households||[]).length))' "$FILE")
echo "Restoring: $FILE"
echo "  $ITEMS items, $HOUSE households  ->  plan id '$PLAN_ID'"

# Shared helper: POST one op and print the raw body. No -X POST: it would survive the
# 302 Apps Script redirects through and re-send bodyless, which Google answers 411.
# text/plain and -L for the same
# reasons as backup-plan.sh. "|| true" so curl's own failure does not exit silently.
call() {
  local body="$1" out="$2"
  curl -sL -o "$out" -w '%{http_code}' -m 90 \
    "$URL" \
    -H "Content-Type: text/plain;charset=utf-8" \
    -d "$body" || true
}

CUR="$(mktemp)"
PAYLOAD="$(mktemp)"
VERIFY="$(mktemp)"
trap 'rm -f "$CUR" "$PAYLOAD" "$VERIFY"' EXIT

# --- What is already there? ------------------------------------------------
HTTP=$(call "{\"op\":\"get\",\"pid\":\"$PLAN_ID\"}" "$CUR")

if [ "$HTTP" = "000" ]; then
  echo "STOPPED: could not reach the backend at all (no HTTP response)."
  echo "Check the deployment exists and is set to \"Anyone\" access. Nothing sent."
  exit 1
fi
if [ "$HTTP" != "200" ]; then
  echo "STOPPED: the backend answered HTTP $HTTP. Nothing sent."
  exit 1
fi

EXIST=$(node -e '
  const fs = require("fs");
  let b;
  try { b = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { process.exit(3); }
  if (!b || b.ok !== true) { console.error((b && b.error) || "backend refused the read"); process.exit(4); }
  process.stdout.write(b.data ? String((b.data.items || []).length) : "none");
' "$CUR") || { echo "STOPPED: could not read the current plan. Nothing sent."; exit 1; }

if [ "$EXIST" != "none" ]; then
  if [ "$FORCE" != "--overwrite" ]; then
    echo
    echo "STOPPED: plan '$PLAN_ID' already holds $EXIST items."
    echo "Restoring would replace them with the $ITEMS items in the backup."
    echo "If that is what you want, run it again with --overwrite on the end."
    exit 1
  fi
  echo "  (overwriting an existing plan that holds $EXIST items — the backend keeps"
  echo "   the copy it replaces, so this is undoable)"
fi

# --- Send it --------------------------------------------------------------
node -e '
  const fs = require("fs");
  const plan = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  fs.writeFileSync(process.argv[3], JSON.stringify({ op: "save", pid: process.argv[2], payload: plan }));
' "$FILE" "$PLAN_ID" "$PAYLOAD"

HTTP=$(curl -sL -o "$VERIFY" -w '%{http_code}' -m 90 \
  "$URL" \
  -H "Content-Type: text/plain;charset=utf-8" \
  --data-binary "@$PAYLOAD" || true)

if [ "$HTTP" != "200" ]; then
  echo "FAILED: the save answered HTTP $HTTP."
  exit 1
fi
if ! node -e '
  const b = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!b || b.ok !== true) { console.error("the backend refused the save: " + ((b && b.error) || "unknown")); process.exit(1); }
' "$VERIFY"; then
  exit 1
fi

# --- Read it back rather than trusting the write ---------------------------
HTTP=$(call "{\"op\":\"get\",\"pid\":\"$PLAN_ID\"}" "$VERIFY")
BACK=$(node -e '
  const b = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(b && b.ok && b.data ? String((b.data.items || []).length) : "0");
' "$VERIFY" 2>/dev/null || echo "0")

if [ "$BACK" = "$ITEMS" ]; then
  echo "Restored and verified: $BACK items are in the backend under '$PLAN_ID'."
else
  echo "WARNING: wrote the plan but read back $BACK items, expected $ITEMS. Check the site."
  exit 1
fi
