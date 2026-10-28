#!/usr/bin/env bash
# Save a copy of the trip plan to this machine.
#
# WHY: the backend keeps its own version history, but history that lives inside the
# backend dies with it. That is not theory — the Supabase project this replaced was
# lost three times, and on 2026-10-08 it took 98 stored versions with it. This is the
# copy that lives somewhere else.
#
# The data now sits in a Google Sheet in the owner's Drive, which is far harder to
# lose than a free database project. This still runs, because "harder to lose" is not
# "impossible to lose", and because a bad edit by one of fourteen people is a
# different risk from the host disappearing.
#
# The backup contains confirmation numbers, so it is written OUTSIDE the repo — this
# repo is public. Do not move these files into it.
#
# Usage:  bash tools/backup-plan.sh <plan-id>

set -euo pipefail

PLAN_ID="${1:-${PLAN_ID:-}}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/TripTrackerBackups}"
KEEP=30   # how many snapshots to keep

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$HERE/config.js"

if [ -z "$PLAN_ID" ]; then
  echo "No plan id given. Pass it as an argument:"
  echo "   bash tools/backup-plan.sh trip-xxxxxxxx"
  exit 2
fi

# BACKEND_URL overrides config.js. It exists so this script can be exercised against
# a local stand-in for the Apps Script endpoint, which is how it was tested before the
# real deployment existed.
URL="${BACKEND_URL:-$(grep -o 'https://script\.google\.com/macros/s/[A-Za-z0-9_-]*/exec' "$CONFIG" | head -1)}"
if [ -z "$URL" ]; then
  echo "Could not find the Apps Script URL in $CONFIG"
  echo "If the backend has not been set up yet, see apps-script/SETUP.md."
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y-%m-%d_%H%M)
OUT="$BACKUP_DIR/plan_$STAMP.json"

# Download to scratch files and only move into place once checked. Writing straight
# to the final name means a failed run deletes a good backup that happens to share its
# timestamp — which is exactly what happened the first time this script ran, within
# the same minute as a successful one.
TMP="$BACKUP_DIR/.incoming.$$.json"
RAW="$BACKUP_DIR/.raw.$$.json"
cleanup() { rm -f "$TMP" "$RAW"; }
trap cleanup EXIT

# NO -X POST HERE, DELIBERATELY. Apps Script answers /exec with a 302 to
# googleusercontent, and -X POST forces curl to keep the method on the redirect and
# re-send with no body, which Google rejects with HTTP 411. Letting -d imply the
# method lets curl switch to GET on the redirect, which is what Apps Script expects.
#
# Content-Type must be text/plain — see backend.js for why. -L follows the redirect
# Apps Script answers from.
#
# "|| true" is load-bearing: without it, curl failing outright (a dead host exits 6)
# trips "set -e" and this script exits SILENTLY, printing nothing at all. That is
# exactly how it behaved during the October outage, when it should have been the thing
# that said what was wrong.
HTTP=$(curl -sL -o "$RAW" -w '%{http_code}' -m 90 \
  "$URL" \
  -H "Content-Type: text/plain;charset=utf-8" \
  -d "{\"op\":\"get\",\"pid\":\"$PLAN_ID\"}" || true)

if [ "$HTTP" = "000" ]; then
  echo "FAILED: could not reach the backend at all (no HTTP response)."
  echo "Check the Apps Script deployment still exists and is set to \"Anyone\" access:"
  echo "    $URL"
  echo "Existing backups are untouched."
  exit 1
fi

if [ "$HTTP" != "200" ]; then
  echo "FAILED: the backend answered HTTP $HTTP — existing backups untouched."
  exit 1
fi

# The backend wraps its answer as {"ok":true,"data":<plan>} and reports its own
# refusals as {"ok":false,"error":...} with HTTP 200 — so the status code alone does
# not say whether this worked. Unwrap it and store the bare plan, so the file is the
# same shape the app itself uses and restore-plan.sh can hand it straight back.
if ! node -e '
  const fs = require("fs");
  let body;
  try { body = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); }
  catch (e) { console.error("the backend did not return JSON — is the deployment URL right?"); process.exit(1); }
  if (!body || body.ok !== true) {
    console.error("the backend refused: " + ((body && body.error) || "unknown error"));
    process.exit(1);
  }
  if (!body.data || typeof body.data !== "object") {
    console.error("no plan came back for that id — nothing saved");
    process.exit(1);
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(body.data));
' "$RAW" "$TMP"; then
  echo "FAILED: existing backups untouched."
  exit 1
fi

SIZE=$(wc -c < "$TMP")
if [ "$SIZE" -lt 50 ]; then
  echo "FAILED: the plan that came back is only $SIZE bytes — nothing saved."
  exit 1
fi

mv "$TMP" "$OUT"
ITEMS=$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String((p.items||[]).length))' "$OUT")
echo "Saved $OUT  (${SIZE} bytes, ${ITEMS} items)"

# Keep the most recent snapshots and drop the rest.
COUNT=$(ls -1 "$BACKUP_DIR"/plan_*.json 2>/dev/null | wc -l | tr -d ' ')
if [ "$COUNT" -gt "$KEEP" ]; then
  ls -1t "$BACKUP_DIR"/plan_*.json | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old"
    echo "  removed old snapshot $(basename "$old")"
  done
fi
