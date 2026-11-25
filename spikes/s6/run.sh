#!/bin/sh
# Spike S6: start the interactive command in its own tmux window of the spike server.
# Usage: run.sh <window> [claude args...]   (scratch project: spikes/out/s5proj, already trusted)
DIR="$(cd "$(dirname "$0")" && pwd)"
P="$DIR/../out/s5proj"; W="$1"; shift
T="$DIR/t.sh"
if ! "$T" has-session -t s6 2>/dev/null; then "$T" new-session -d -s s6 -x 160 -y 50 -c "$P" -n idle "sleep 86400"; fi
"$T" new-window -d -t s6: -n "$W" -c "$P" -- "$HOME/claude_me" --model haiku "$@"
"$T" resize-window -t "s6:$W" -x 160 -y 60
"$T" list-panes -t "s6:$W" -F '#{pane_pid}' > "$DIR/../out/s6/$W.pid"
