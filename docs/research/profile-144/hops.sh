#!/usr/bin/env bash
# Per-hop latency probe for dotfiles#144. Read-only GETs, bodies discarded
# (-o /dev/null); prints status/bytes/ttfb/total per request plus p50/p95.
# Exit 1 (red) when any request is non-200 or p95 exceeds its budget.
#
# usage: hops.sh [N]   (default 5 samples per endpoint)
set -u
N=${1:-5}
DAEMON=${OPENCODE_URL:-http://127.0.0.1:4096}
DASH=${ES_DASHBOARD_URL:-http://127.0.0.1:7777}
WEB=${ES_APP_URL:-http://127.0.0.1:3181}
SMALL_ID=${SMALL_ID:?set SMALL_ID (session id)}
SMALL_DIR=${SMALL_DIR:?set SMALL_DIR}
LARGE_ID=${LARGE_ID:?set LARGE_ID}
LARGE_DIR=${LARGE_DIR:?set LARGE_DIR}
enc() { jq -rn --arg v "$1" '$v|@uri'; }
red=0
probe() { # name budget_ms url
  local name=$1 budget=$2 url=$3 out codes=() totals=()
  for _ in $(seq "$N"); do
    out=$(curl -s -o /dev/null -m 60 -w '%{http_code} %{size_download} %{time_starttransfer} %{time_total}' "$url")
    set -- $out
    codes+=("$1"); totals+=("$4")
    printf '%-44s http=%s bytes=%-9s ttfb=%6.0fms total=%6.0fms\n' "$name" "$1" "$2" "$(echo "$3*1000" | bc)" "$(echo "$4*1000" | bc)"
  done
  local sorted p50 p95
  sorted=$(printf '%s\n' "${totals[@]}" | sort -n)
  p50=$(echo "$sorted" | awk -v n="$N" 'NR==int((n+1)/2){printf "%.0f", $1*1000}')
  p95=$(echo "$sorted" | awk -v n="$N" 'NR==(n<20?n:int(n*0.95+0.5)){printf "%.0f", $1*1000}')
  local bad; bad=$(printf '%s\n' "${codes[@]}" | grep -vc '^200$')
  local verdict=ok
  if [ "$bad" -gt 0 ] || [ "$p95" -gt "$budget" ]; then verdict=RED; red=1; fi
  printf '  => %-40s p50=%sms p95=%sms budget=%sms non200=%s %s\n\n' "$name" "$p50" "$p95" "$budget" "$bad" "$verdict"
}
echo "# hops $(date -u +%FT%TZ) N=$N"
probe "daemon health"                 50   "$DAEMON/global/health"
probe "daemon list(limit=1600)"        300  "$DAEMON/experimental/session?roots=false&archived=true&limit=1600"
probe "web->daemon list(limit=1600)"   400  "$WEB/oc/experimental/session?roots=false&archived=true&limit=1600"
probe "dash /api/state"                300  "$DASH/api/state"
probe "web->dash /api/state"           400  "$WEB/es/api/state"
probe "dash /api/notifications"        200  "$DASH/api/notifications"
probe "daemon status(small dir)"       200  "$DAEMON/session/status?directory=$(enc "$SMALL_DIR")"
probe "daemon messages small"          500  "$DAEMON/session/$SMALL_ID/message?directory=$(enc "$SMALL_DIR")&summaryPatches=false"
probe "web->daemon messages small"     700  "$WEB/oc/session/$SMALL_ID/message?directory=$(enc "$SMALL_DIR")&summaryPatches=false"
probe "daemon messages large"          2000 "$DAEMON/session/$LARGE_ID/message?directory=$(enc "$LARGE_DIR")&summaryPatches=false"
probe "web->daemon messages large"     2500 "$WEB/oc/session/$LARGE_ID/message?directory=$(enc "$LARGE_DIR")&summaryPatches=false"
exit $red
