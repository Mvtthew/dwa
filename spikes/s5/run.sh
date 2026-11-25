#!/bin/sh
# Spike S5: start one variant in its own tmux window. Usage: run.sh <scratch-dir> <variant> [claude args...]
DIR="$(cd "$(dirname "$0")" && pwd)"
P="$1"; V="$2"; shift 2
T="$DIR/t.sh"
if ! "$T" has-session -t s5 2>/dev/null; then "$T" new-session -d -s s5 -x 180 -y 50 -c "$P" -n idle "sleep 86400"; fi
"$T" new-window -d -t s5: -n "$V" -c "$P" -- "$HOME/claude_me" --model haiku --name "s5-$V" "$@"
"$T" resize-window -t "s5:$V" -x 180 -y "${S5_ROWS:-60}"
