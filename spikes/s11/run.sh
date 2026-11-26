#!/bin/sh
# Spike S11: start the interactive command in its own tmux window of the spike server.
# Usage: run.sh <window> [claude args...]   (scratch project: $S11_PROJECT)
DIR="$(cd "$(dirname "$0")" && pwd)"
P="${S11_PROJECT:?set S11_PROJECT to the scratch project}"; W="$1"; shift
T="$DIR/t.sh"; O="$DIR/../out/s11"
if ! "$T" has-session -t s11 2>/dev/null; then "$T" new-session -d -s s11 -x 160 -y 50 -c "$P" -n idle "sleep 86400"; fi
bun "$DIR/settings.ts" "$O/$W.json" "$W"
echo '{"mcpServers":{}}' > "$O/mcp.json"
"$T" new-window -d -t s11: -n "$W" -c "$P" -- "$HOME/claude_me" --model haiku \
  --setting-sources project,local --strict-mcp-config --mcp-config "$O/mcp.json" \
  --settings "$O/$W.json" --tools "Read,Bash,Glob,Grep,WebSearch" --permission-mode manual "$@"
"$T" resize-window -t "s11:$W" -x 160 -y 60
"$T" list-panes -t "s11:$W" -F '#{pane_pid}' > "$O/$W.pid"
