#!/bin/sh
# Spike S9: tmux against the private spike server (dwa-spike9), with a clean environment so
# sessions do not inherit CLAUDE* / TMUX variables from the session that runs the spike.
DIR="$(cd "$(dirname "$0")" && pwd)"
exec env -i HOME="$HOME" PATH="$PATH" USER="$USER" SHELL="${SHELL:-/bin/sh}" \
  LANG="${LANG:-en_US.UTF-8}" TERM=xterm-256color COLORTERM=truecolor \
  S9_LOG="${S9_LOG:-}" \
  tmux -L dwa-spike9 -f "$DIR/../tmux.conf" "$@"
