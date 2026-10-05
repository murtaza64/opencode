#!/usr/bin/env bash
# Daemon event-loop stall detector (dotfiles#144). Samples a trivially cheap
# daemon GET at ~5 Hz for DURATION seconds alongside daemon/dashboard/renderer
# CPU, prints a histogram of latencies and every stall >= 250 ms with the CPU
# snapshot taken in the same second. Red when any stall >= 1000 ms.
#
# usage: stall.sh [DURATION=60] [URL]
set -u
DURATION=${1:-60}
URL=${2:-${OPENCODE_URL:-http://127.0.0.1:4096}/global/health}
DAEMON_PID=$(ps -axo pid=,command= | awk '/opencode serve --port 4096/ && !/awk/ {print $1; exit}')
DASH_PIDS=$(pgrep -f 'es-dashboard --port 7777' | tr '\n' ',' | sed 's/,$//')
RENDERER_PID=$(ps -axo pid=,command= | awk '/Editspace Helper \(Renderer\)/ && /type=renderer/ && !/awk/ {print $1; exit}')
echo "# stall $(date -u +%FT%TZ) duration=${DURATION}s url=$URL daemon=$DAEMON_PID dash=$DASH_PIDS renderer=$RENDERER_PID"
end=$((SECONDS + DURATION))
n=0; red=0
declare -a hist=(0 0 0 0 0 0)   # <50 <100 <250 <500 <1000 >=1000
while [ $SECONDS -lt $end ]; do
  ms=$(curl -s -o /dev/null -m 10 -w '%{time_total}' "$URL" | awk '{printf "%d", $1*1000}')
  n=$((n+1))
  if [ "$ms" -lt 50 ]; then hist[0]=$((hist[0]+1))
  elif [ "$ms" -lt 100 ]; then hist[1]=$((hist[1]+1))
  elif [ "$ms" -lt 250 ]; then hist[2]=$((hist[2]+1))
  elif [ "$ms" -lt 500 ]; then hist[3]=$((hist[3]+1))
  elif [ "$ms" -lt 1000 ]; then hist[4]=$((hist[4]+1))
  else hist[5]=$((hist[5]+1)); red=1; fi
  if [ "$ms" -ge 250 ]; then
    cpu=$(ps -o pid=,%cpu=,rss= -p "$DAEMON_PID,$DASH_PIDS,$RENDERER_PID" 2>/dev/null | awk '{printf "%s:%s%%/%dMB ", $1,$2,$3/1024}')
    echo "stall ${ms}ms at $(date -u +%T) cpu[$cpu]"
  fi
  sleep 0.2
done
echo "samples=$n  <50:${hist[0]} <100:${hist[1]} <250:${hist[2]} <500:${hist[3]} <1000:${hist[4]} >=1000:${hist[5]}  $([ $red = 1 ] && echo RED || echo ok)"
exit $red
