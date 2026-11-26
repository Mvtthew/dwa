#!/bin/sh
# Spike S8: start an interactive session in its own window of the spike server.
# Usage: run.sh <tag> <delay-ms> <tools|notools> <mail|nomail> [task]
#   tools   = --tools Read,Bash, or the list in S8_TOOLS (no ToolSearch, MCP tools not deferred); notools = the default set
# S8_ENV="A=1 B=2" sets variables in the session's environment; S8_ALWAYS and S8_SETTINGS_ENV: see settings.ts.
# Scratch project: spikes/out/s5proj (already trusted). Writes out/s8/<tag>.sid, .pid, .start.
DIR="$(cd "$(dirname "$0")" && pwd)"
P="$DIR/../out/s5proj"; O="$DIR/../out/s8"; T="$DIR/t.sh"
TAG="$1"; DELAY="$2"; TOOLS="$3"; MAIL="$4"; shift 4
bun "$DIR/settings.ts" "$TAG" "$DELAY" "$MAIL" || exit 1
SID="$(uuidgen | tr 'A-Z' 'a-z')"; echo "$SID" > "$O/$TAG.sid"
set -- --model haiku --setting-sources project,local --strict-mcp-config \
  --mcp-config "$O/$TAG.mcp.json" --settings "$O/$TAG.settings.json" \
  --permission-mode dontAsk --session-id "$SID" "$@"
if [ "$TOOLS" = tools ]; then set -- --tools "${S8_TOOLS:-Read,Bash}" "$@"; fi
if ! "$T" has-session -t s8 2>/dev/null; then "$T" new-session -d -s s8 -x 160 -y 50 -c "$P" -n idle "sleep 86400"; fi
date -u +%Y-%m-%dT%H:%M:%SZ > "$O/$TAG.start"
E=""; for V in $S8_ENV; do E="$E -e $V"; done
# shellcheck disable=SC2086
"$T" new-window -d -t s8: -n "$TAG" -c "$P" $E -- "$HOME/claude_me" "$@"
"$T" resize-window -t "s8:$TAG" -x 160 -y 50
"$T" list-panes -t "s8:$TAG" -F '#{pane_pid}' > "$O/$TAG.pid"
