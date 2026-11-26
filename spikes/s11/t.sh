#!/bin/sh
# Spike S11 helper: tmux against the private spike server (dwa-spike11), with a clean environment.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec env -i HOME="$HOME" PATH="$PATH" USER="$USER" SHELL="${SHELL:-/bin/sh}" \
  LANG="${LANG:-en_US.UTF-8}" TERM=xterm-256color COLORTERM=truecolor \
  DWA_SPIKE_OUT="$DIR/../out/s11" \
  tmux -L dwa-spike11 -f "$DIR/../tmux.conf" "$@"
