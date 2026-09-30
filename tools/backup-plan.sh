#!/usr/bin/env bash
# Save a copy of the trip plan to this machine.
#
# WHY: the version history built into the database lives *inside* the database, so it
# protects against a bad edit but not against losing the project. On 2026-09-30 the
# Supabase project was paused and every link died at once; nothing outside it held a
# copy of the bookings. This is the copy that lives somewhere else.
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

URL=$(grep -o 'https://[a-z0-9]*\.supabase\.co/rest/v1' "$CONFIG" | head -1)
KEY=$(grep -o 'eyJ[A-Za-z0-9._-]*' "$CONFIG" | head -1)
if [ -z "$URL" ] || [ -z "$KEY" ]; then
  echo "Could not read the backend details out of $CONFIG"
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y-%m-%d_%H%M)
OUT="$BACKUP_DIR/plan_$STAMP.json"

# Download to a scratch file and only move it into place once it has been checked.
# Writing straight to the final name means a failed run deletes a good backup that
# happens to share its timestamp — which is exactly what happened the first time
# this script ran, within the same minute as a successful one.
TMP="$BACKUP_DIR/.incoming.$$.json"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

HTTP=$(curl -s -o "$TMP" -w '%{http_code}' -m 60 \
  -X POST "$URL/rpc/get_plan" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"pid\":\"$PLAN_ID\"}")

if [ "$HTTP" != "200" ]; then
  echo "FAILED: the database answered HTTP $HTTP — existing backups untouched."
  exit 1
fi

# An empty or null answer means the id was wrong, or the plan is gone. Either way it
# is not a backup, and saving it would quietly replace good copies with junk.
SIZE=$(wc -c < "$TMP")
FIRST=$(head -c 4 "$TMP")
if [ "$SIZE" -lt 50 ] || [ "$FIRST" = "null" ]; then
  echo "FAILED: no plan came back for id '$PLAN_ID' — nothing saved, existing backups untouched."
  exit 1
fi

mv "$TMP" "$OUT"
RECORDS=$(grep -o '"id"' "$OUT" | wc -l | tr -d ' ')
echo "Saved $OUT  (${SIZE} bytes, ~${RECORDS} records)"

# Keep the most recent snapshots and drop the rest.
COUNT=$(ls -1 "$BACKUP_DIR"/plan_*.json 2>/dev/null | wc -l | tr -d ' ')
if [ "$COUNT" -gt "$KEEP" ]; then
  ls -1t "$BACKUP_DIR"/plan_*.json | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old"
    echo "  removed old snapshot $(basename "$old")"
  done
fi
