#!/bin/sh
# Spike S9: starts one variant's session in the scratch project and accepts the trust prompt.
# Usage: start.sh <scratch-dir> <out-dir> <variant> [extra claude arguments...]
DIR="$(cd "$(dirname "$0")" && pwd)"
P="$1"; OUT="$2"; V="$3"; shift 3
T="$DIR/t.sh"
CMD="cd '$P' && exec $HOME/claude_me --setting-sources project,local --strict-mcp-config --mcp-config '$OUT/mcp.json' --model haiku"
for A in "$@"; do CMD="$CMD '$A'"; done
if "$T" has-session -t s9 2>/dev/null; then "$T" new-window -d -t s9 -n "$V" "$CMD"
else "$T" new-session -d -s s9 -n "$V" -x 200 -y 60 "$CMD"; fi
sleep 6
"$T" capture-pane -p -t "s9:$V" | grep -qi "trust this folder" && { "$T" send-keys -t "s9:$V" Down; sleep 0.5; "$T" send-keys -t "s9:$V" Enter; sleep 6; }
"$T" capture-pane -p -t "s9:$V" | grep -v '^ *$' | tail -8
