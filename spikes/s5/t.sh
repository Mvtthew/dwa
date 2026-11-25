#!/bin/sh
# Spike S5 helper: tmux against the private spike server (dwa-spike5), with a clean environment
# so sessions do not inherit CLAUDE* / TMUX variables from the session that runs the spike.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec env -i HOME="$HOME" PATH="$PATH" USER="$USER" SHELL="${SHELL:-/bin/sh}" \
  LANG="${LANG:-en_US.UTF-8}" TERM=xterm-256color COLORTERM=truecolor \
  DWA_SPIKE_OUT="$DIR/../out/s5" \
  tmux -L dwa-spike5 -f "$DIR/../tmux.conf" "$@"
