#!/bin/sh
# Spike S13: a pane that records every size change it is told about.
NAME="$1"; LOG="$2"
trap 'echo "$NAME $(stty size < /dev/tty)" >> "$LOG"' WINCH
while :; do sleep 0.1; done
