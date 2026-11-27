#!/bin/sh
# Spike S14: type a line into a window, wait, print the visible screen without empty lines.
# Usage: say.sh <window> <wait-seconds> [text]
DIR="$(cd "$(dirname "$0")" && pwd)"
W="$1"; S="$2"; T="$DIR/t.sh"
if [ -n "$3" ]; then "$T" send-keys -t "s14:$W" -l "$3"; sleep 1; "$T" send-keys -t "s14:$W" Enter; fi
sleep "$S"
"$T" capture-pane -p -t "s14:$W" | grep -v '^ *$' | tail -${LINES_OUT:-45}
