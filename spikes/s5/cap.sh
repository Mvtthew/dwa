#!/bin/sh
# Spike S5: optionally type something into a variant's session, wait, and save the screen.
# Usage: cap.sh <variant> <label> [wait-seconds] [text to type and submit]
DIR="$(cd "$(dirname "$0")" && pwd)"
V="$1"; L="$2"; W="${3:-3}"; shift 3 2>/dev/null
T="$DIR/t.sh"; OUT="$DIR/../out/s5"
if [ -n "$1" ]; then "$T" send-keys -t "s5:$V" -l "$1"; sleep 1; "$T" send-keys -t "s5:$V" Enter; fi
sleep "$W"
"$T" capture-pane -p -t "s5:$V" > "$OUT/$V-$L.txt"
grep -v '^ *$' "$OUT/$V-$L.txt"
