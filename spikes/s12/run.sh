#!/bin/sh
# Spike S12: start the interactive command in its own tmux window of the spike server.
# Usage: S12_ALLOW="rule,rule" S12_DENY="rule,rule" run.sh <window> [claude args...]   (scratch project: $S12_PROJECT)
# Only --model and --settings are fixed; every other flag is the caller's, so one flag can change
# at a time. $O/mcp.json (an empty server set) is written for --mcp-config.
DIR="$(cd "$(dirname "$0")" && pwd)"
P="${S12_PROJECT:?set S12_PROJECT to the scratch project}"; W="$1"; shift
T="$DIR/t.sh"; O="$DIR/../out/s12"
if ! "$T" has-session -t s12 2>/dev/null; then "$T" new-session -d -s s12 -x 160 -y 50 -c "$P" -n idle "sleep 86400"; fi
bun "$DIR/settings.ts" "$O/$W.json" "$W" "${S12_ALLOW:-}"
echo '{"mcpServers":{}}' > "$O/mcp.json"
echo "$*" > "$O/$W.args"
"$T" new-window -d -t s12: -n "$W" -c "$P" -- "$HOME/claude_me" --model haiku --settings "$O/$W.json" "$@"
"$T" resize-window -t "s12:$W" -x 160 -y 60
"$T" list-panes -t "s12:$W" -F '#{pane_pid}' > "$O/$W.pid"
