#!/bin/sh
# Spike S9: runs read-only slash commands in a variant's session and saves each screen.
# Usage: probe.sh <out-dir> <variant> <commands...>
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$1"; V="$2"; shift 2
T="$DIR/t.sh"
for C in "$@"; do
  "$T" send-keys -t "s9:$V" -l "/$C"; sleep 1; "$T" send-keys -t "s9:$V" Enter; sleep 5
  "$T" capture-pane -p -S -300 -t "s9:$V" > "$OUT/$V-$(echo "$C" | tr ' ' '_').txt"
  "$T" send-keys -t "s9:$V" Escape; sleep 1
done
