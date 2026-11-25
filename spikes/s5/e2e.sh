#!/bin/sh
# E2E helper: runs the dwa CLI from source against the scratch project spikes/out/e2e with a
# cleaned environment. Usage: e2e.sh <dwa args...> ; e2e.sh tmux <tmux args...> for its tmux server.
DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
P="$REPO/spikes/out/e2e"
if [ "$1" = "tmux" ]; then
  shift
  HASH=$(cd "$REPO" && bun -e 'import {tmuxSocketName} from "./src/shared/paths.ts"; console.log(tmuxSocketName(process.argv[1]))' "$P")
  exec env -i HOME="$HOME" PATH="$PATH" TERM=xterm-256color tmux -L "$HASH" "$@"
fi
cd "$P" && exec env -i HOME="$HOME" PATH="$PATH" USER="$USER" SHELL="${SHELL:-/bin/sh}" \
  LANG="${LANG:-en_US.UTF-8}" TERM=xterm-256color COLORTERM=truecolor \
  DWA_PROJECT="$P" DWA_CLAUDE_COMMAND="$HOME/claude_me" \
  bun "$REPO/src/cli/index.ts" "$@"
