#!/usr/bin/env bash
# Pull the trip plan out of the OLD Supabase backend, if it ever comes back.
#
# WHY THIS EXISTS
# The backend moved to a Google Sheet after Supabase died for the third time around
# 2026-10-08. The newest local backup at that point was from 2026-09-30, so roughly a
# week of the group's edits existed only inside that dead project.
#
# If the Supabase dashboard still offers "Restore", that week is recoverable: restore
# it there, run this to grab the plan, then feed the file to tools/restore-plan.sh to
# load it into the Sheet. If the project is gone for good, this script has no purpose
# and the 2026-09-30 backup is the best copy that exists.
#
# The old project URL and anon key are NOT stored here. They are read out of this
# repository's own git history, where the previous config.js still has them — there is
# no reason to re-commit a credential just to retire it.
#
# Usage:  bash tools/rescue-from-supabase.sh <plan-id>
#   then: bash tools/restore-plan.sh <plan-id> <the file this prints> --overwrite

set -euo pipefail

PLAN_ID="${1:-}"
OUT_DIR="${BACKUP_DIR:-$HOME/TripTrackerBackups}"

if [ -z "$PLAN_ID" ]; then
  echo "Usage: bash tools/rescue-from-supabase.sh <plan-id>"
  echo "The plan id is in $OUT_DIR/plan-id.txt"
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

# Walk back through config.js until a revision mentions Supabase.
URL=""
KEY=""
for rev in $(git rev-list HEAD -- config.js); do
  BLOB="$(git show "$rev:config.js" 2>/dev/null || true)"
  case "$BLOB" in
    *supabase.co*)
      URL=$(printf '%s' "$BLOB" | grep -o 'https://[a-z0-9]*\.supabase\.co/rest/v1' | head -1)
      KEY=$(printf '%s' "$BLOB" | grep -o 'eyJ[A-Za-z0-9._-]*' | head -1)
      echo "Found the old backend in config.js at commit ${rev:0:7}"
      break
      ;;
  esac
done

if [ -z "$URL" ] || [ -z "$KEY" ]; then
  echo "Could not find a Supabase URL and key anywhere in config.js history."
  echo "Nothing to rescue from."
  exit 1
fi
echo "Old backend: ${URL%/rest/v1}"

HOST="${URL#https://}"
HOST="${HOST%%/*}"

mkdir -p "$OUT_DIR"
RAW="$OUT_DIR/.rescue.$$.json"
trap 'rm -f "$RAW"' EXIT

HTTP=$(curl -s -o "$RAW" -w '%{http_code}' -m 60 \
  -X POST "$URL/rpc/get_plan" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d "{\"pid\":\"$PLAN_ID\"}" || true)

if [ "$HTTP" = "000" ]; then
  echo
  echo "Still unreachable — nothing answered at $HOST."
  echo "Confirm with:   nslookup $HOST 8.8.8.8"
  echo "NXDOMAIN there means the project is still paused or deleted. If the dashboard"
  echo "offers Restore, do that first and run this again."
  exit 1
fi

if [ "$HTTP" != "200" ]; then
  echo "The old backend answered HTTP $HTTP. Nothing saved."
  exit 1
fi

if [ "$(head -c 4 "$RAW")" = "null" ] || [ "$(wc -c < "$RAW")" -lt 50 ]; then
  echo "The project is alive but holds no plan under that id. Nothing saved."
  echo "(If the id is right, the data itself did not survive.)"
  exit 1
fi

STAMP=$(date +%Y-%m-%d_%H%M)
OUT="$OUT_DIR/plan_${STAMP}_rescued.json"
mv "$RAW" "$OUT"

ITEMS=$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String((p.items||[]).length))' "$OUT")
echo
echo "Rescued $ITEMS items to:"
echo "  $OUT"
echo
echo "Compare it against the newest ordinary backup before loading it — if this one is"
echo "older or emptier, the backup is the better copy:"
echo "  ls -1t $OUT_DIR/plan_*.json | head -3"
echo
echo "Then load it into the Sheet backend:"
echo "  bash tools/restore-plan.sh '$PLAN_ID' '$OUT' --overwrite"
