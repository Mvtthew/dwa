#!/bin/bash
# S7: does a program in a dwa popup get mouse presses, drags and the wheel?
#
# Two private tmux servers, neither the user's: "dwa-s7-outer" plays the terminal (120x40) and
# runs a client of "dwa-s7-inner", which has the config dwa generates. Mouse input is typed into
# the outer pane as SGR mouse sequences, the way a terminal would send it.
#
# Usage: spikes/s7/run.sh start | popup <command...> | mouse <code> <x> <y> <M|m> | keys <keys>
#        | screen | stop       (x and y count from 1, as the terminal sends them)
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=spikes/out/s7
OUTER="tmux -L dwa-s7-outer"
INNER="tmux -L dwa-s7-inner"
case "${1:-}" in
  start)
    mkdir -p "$OUT"
    bun spikes/s7/conf.ts "$PWD/$OUT/project" > "$OUT/tmux.conf"
    $OUTER -f /dev/null new-session -d -s term -x 120 -y 40 \
      "tmux -L dwa-s7-inner -f $OUT/tmux.conf new-session -s work 'sh -c \"echo the pane under the popup; exec cat\"'"
    sleep 1
    ;;
  popup)
    shift
    # Not waited for: display-popup returns when the popup closes.
    $INNER display-popup -E -w 90% -h 90% -T " spike " "$*" &
    sleep 2
    ;;
  mouse)
    $OUTER send-keys -t term -l "$(printf '\033[<%s;%s;%s%s' "$2" "$3" "$4" "$5")"
    sleep 0.2
    ;;
  keys)
    shift
    $OUTER send-keys -t term "$@"
    sleep 0.3
    ;;
  screen)
    $OUTER capture-pane -p -t term
    ;;
  stop)
    $INNER kill-server 2>/dev/null || true
    $OUTER kill-server 2>/dev/null || true
    ;;
  *)
    sed -n 2,10p "$0"
    exit 2
    ;;
esac
