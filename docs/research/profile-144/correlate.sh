#!/usr/bin/env bash
# Correlate daemon event-loop stalls with daemon RSS/CPU and global event rate
# (dotfiles#144). One line per second: health latency (ms), daemon %cpu, daemon
# RSS MB, events/s on /global/event (type names only, nothing stored).
# usage: correlate.sh [DURATION=240]
set -u
DURATION=${1:-240}
DAEMON=${OPENCODE_URL:-http://127.0.0.1:4096}
PID=$(ps -axo pid=,command= | awk '/opencode serve --port 4096/ && !/awk/ {print $1; exit}')
tmp=$(mktemp -d)
# event counter: timestamps of events only
(curl -sN "$DAEMON/global/event" | grep --line-buffered '^data:' | while read -r _; do date +%s; done > "$tmp/ev") &
EVPID=$!
echo "# correlate $(date -u +%FT%TZ) pid=$PID duration=${DURATION}s"
echo "sec health_ms cpu rss_mb events_per_s"
end=$((SECONDS + DURATION)); last=$(date +%s)
while [ $SECONDS -lt $end ]; do
  now=$(date +%s)
  ms=$(curl -s -o /dev/null -m 30 -w '%{time_total}' "$DAEMON/global/health" | awk '{printf "%d", $1*1000}')
  read -r cpu rss <<<"$(ps -o %cpu=,rss= -p "$PID" | awk '{print $1, int($2/1024)}')"
  ev=$(grep -c "^$last$" "$tmp/ev" 2>/dev/null || echo 0)
  printf '%s %s %s %s %s%s\n' "$(date -u +%T)" "$ms" "$cpu" "$rss" "$ev" "$([ "$ms" -ge 500 ] && echo ' <-- STALL')"
  last=$now
  sleep 1
done
kill $EVPID 2>/dev/null; pkill -P $EVPID 2>/dev/null; rm -rf "$tmp"
