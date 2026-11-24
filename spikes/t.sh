#!/bin/sh
# Spike helper: tmux against the private spike server, with a clean environment so sessions
# started from inside another Claude Code session do not inherit its CLAUDE* / TMUX variables.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec env -i HOME="$HOME" PATH="$PATH" USER="$USER" SHELL="${SHELL:-/bin/sh}" \
  LANG="${LANG:-en_US.UTF-8}" TERM=xterm-256color COLORTERM=truecolor \
  DWA_SPIKE_OUT="$DIR/out" \
  tmux -L dwa-spike -f "$DIR/tmux.conf" "$@"
