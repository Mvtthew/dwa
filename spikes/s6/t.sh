#!/bin/sh
# Spike S6 helper: tmux against the private spike server (dwa-spike6), with a clean environment.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec env -i HOME="$HOME" PATH="$PATH" USER="$USER" SHELL="${SHELL:-/bin/sh}" \
  LANG="${LANG:-en_US.UTF-8}" TERM=xterm-256color COLORTERM=truecolor \
  DWA_SPIKE_OUT="$DIR/../out/s6" \
  tmux -L dwa-spike6 -f "$DIR/../tmux.conf" "$@"
