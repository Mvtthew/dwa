#!/bin/sh
# Spike S5: the variants that were run. Usage: variants.sh <project-dir> <variant>
# Run setup.sh <project-dir> first; probe with probe.sh / cap.sh; stop with `t.sh kill-server`.
# The project must not be in a temp directory: there Claude Code 2.1.331 loaded no project CLAUDE.md.
DIR="$(cd "$(dirname "$0")" && pwd)"; OUT="$DIR/../out/s5"; P="$1"; V="$2"
SS="--setting-sources project,local"
ISO="$SS --settings $OUT/settings-iso.json"
STRICT="--strict-mcp-config --mcp-config $OUT/mcp.json"
case "$V" in
  base) set -- ;;
  sspl) set -- $SS ;;
  ssp) set -- --setting-sources project ;;
  ssempty) set -- --setting-sources "" ;;
  iso) set -- $ISO ;;
  mcpadd) set -- $ISO --mcp-config "$OUT/mcp.json" ;;
  strict) set -- $ISO $STRICT ;;
  tools) set -- $ISO $STRICT --tools "Read,Grep,Glob" ;;
  deny) set -- $ISO $STRICT --disallowedTools "Edit,Write" ;;
  plug) set -- $ISO $STRICT --plugin-dir "$OUT/plugin" --plugin-dir "$OUT/genplugin" ;;
  plug2) set -- $ISO --plugin-dir "$OUT/plugin" ;;
  perm) set -- $SS --settings "$OUT/settings-perm.json" ;;
  skoff) set -- $SS --settings "$OUT/settings-skoff.json" $STRICT ;;
  manallow) set -- $ISO $STRICT --permission-mode manual ;;
  mannoallow) set -- $SS --settings "$OUT/settings-noallow.json" $STRICT --permission-mode manual ;;
  pm-*) set -- $ISO $STRICT --permission-mode "${V#pm-}" ;;
  agent) set -- $ISO --agents "$(cat "$OUT/agents.json")" --agent reviewer --append-system-prompt "The append codeword is APPENDMARK-9." ;;
  agentfile) set -- $ISO --agents "$OUT/agents.json" --agent reviewer ;;
  loud) set -- $SS --settings "$OUT/settings-loud.json" ;;
  refresh) set -- $SS --settings "$OUT/settings-refresh.json" ;;
  hook) set -- $SS --settings "$OUT/settings-hook.json" $STRICT ;;
  agentbig)
    # 100 KB of role prompt is more than one tmux command can carry (limit between 16 and 20 KB),
    # so a shell reads it from the file and execs the unmodified command.
    exec "$DIR/t.sh" new-window -d -t s5: -n agentbig -c "$P" -- sh -c \
      "exec $HOME/claude_me --model haiku $ISO --agents \"\$(cat $OUT/agents-big.json)\" --agent big --append-system-prompt-file $OUT/append.md" ;;
  *) echo "unknown variant $V" >&2; exit 2 ;;
esac
exec "$DIR/run.sh" "$P" "$V" "$@"
