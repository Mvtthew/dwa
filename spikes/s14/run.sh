#!/bin/sh
# Spike S14: start the interactive command in its own tmux window of the spike server.
# Usage: run.sh <window> <permission-mode> <deny-rule or ""> [claude args...]
# (scratch project: $S14_PROJECT)
DIR="$(cd "$(dirname "$0")" && pwd)"
P="${S14_PROJECT:?set S14_PROJECT to the scratch project}"; W="$1"; M="$2"; D="$3"; shift 3
T="$DIR/t.sh"; O="$DIR/../out/s14"
if ! "$T" has-session -t s14 2>/dev/null; then "$T" new-session -d -s s14 -x 160 -y 50 -c "$P" -n idle "sleep 86400"; fi
bun "$DIR/settings.ts" "$O/$W.json" "$W" "$D"
echo '{"mcpServers":{}}' > "$O/mcp.json"
"$T" new-window -d -t s14: -n "$W" -c "$P" -- "$HOME/claude_me" --model haiku \
  --setting-sources project,local --strict-mcp-config --mcp-config "$O/mcp.json" \
  --settings "$O/$W.json" --tools "Read,Bash,Glob,Grep" --permission-mode "$M" "$@"
"$T" resize-window -t "s14:$W" -x 160 -y 60
