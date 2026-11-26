#!/bin/sh
# Spike S8: type a line into a window (send-keys, or paste-buffer -p with "paste" as 4th argument),
# wait, print the visible screen without empty lines.
# Usage: say.sh <tag> <wait-seconds> [text] [paste]
DIR="$(cd "$(dirname "$0")" && pwd)"
W="$1"; S="$2"; T="$DIR/t.sh"
if [ -n "$3" ]; then
  if [ "$4" = paste ]; then
    printf '%s' "$3" | "$T" load-buffer -b s8 -; "$T" paste-buffer -p -d -b s8 -t "s8:$W"
  else
    "$T" send-keys -t "s8:$W" -l "$3"
  fi
  sleep 1; "$T" send-keys -t "s8:$W" Enter
fi
sleep "$S"
"$T" capture-pane -p -t "s8:$W" | grep -v '^ *$' | tail -${LINES_OUT:-12}
