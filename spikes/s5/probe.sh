#!/bin/sh
# Spike S5: run the read-only slash commands in a variant's session and save each screen.
# Usage: probe.sh <variant> [commands...]   (default: context mcp skills memory agents permissions status)
DIR="$(cd "$(dirname "$0")" && pwd)"
V="$1"; shift
T="$DIR/t.sh"; OUT="$DIR/../out/s5"
[ $# -eq 0 ] && set -- context mcp skills memory agents permissions status
for C in "$@"; do
  "$T" send-keys -t "s5:$V" -l "/$C"; sleep 1; "$T" send-keys -t "s5:$V" Enter; sleep 4
  "$T" capture-pane -p -S -200 -t "s5:$V" > "$OUT/$V-$C.txt"
  "$T" send-keys -t "s5:$V" Escape; sleep 1
  "$T" send-keys -t "s5:$V" -l "/clear"; sleep 0.5; "$T" send-keys -t "s5:$V" Enter; sleep 1.5
done
