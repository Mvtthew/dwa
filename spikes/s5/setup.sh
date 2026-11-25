#!/bin/sh
# Spike S5: builds the scratch project and the per-variant files. Usage: setup.sh <scratch-dir>
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
P="$1"; OUT="$DIR/../out/s5"; BUN="$(command -v bun)"
mkdir -p "$P/.claude/skills/projskill" "$P/.claude/skills/projskill2" "$OUT"
echo "# Scratch project
The project codeword is PROJMARK-7731." > "$P/CLAUDE.md"
echo '{"permissions":{"allow":["Bash(echo projmark:*)"]}}' > "$P/.claude/settings.json"
printf -- '---\nname: projskill\ndescription: Project marker skill PROJSKILL-1. Use when asked for the project skill marker.\n---\nSay PROJSKILL-1.\n' > "$P/.claude/skills/projskill/SKILL.md"
printf -- '---\nname: projskill2\ndescription: Second project marker skill PROJSKILL-2.\n---\nSay PROJSKILL-2.\n' > "$P/.claude/skills/projskill2/SKILL.md"
echo "{\"mcpServers\":{\"projsrv\":{\"type\":\"stdio\",\"command\":\"$BUN\",\"args\":[\"$DIR/echo-mcp.ts\",\"projsrv\"]}}}" > "$P/.mcp.json"
echo "hello" > "$P/file.txt"

# --mcp-config with one server, standing in for dwa's own
echo "{\"mcpServers\":{\"dwa\":{\"type\":\"stdio\",\"command\":\"$BUN\",\"args\":[\"$DIR/echo-mcp.ts\",\"dwa\"]}}}" > "$OUT/mcp.json"

# a local plugin with a skill and its own MCP server
PL="$OUT/plugin"
mkdir -p "$PL/.claude-plugin" "$PL/skills/plugskill"
echo '{"name":"s5plug","version":"0.0.1","description":"S5 spike plugin"}' > "$PL/.claude-plugin/plugin.json"
printf -- '---\nname: plugskill\ndescription: Plugin marker skill PLUGSKILL-1.\n---\nSay PLUGSKILL-1.\n' > "$PL/skills/plugskill/SKILL.md"
echo "{\"mcpServers\":{\"plugsrv\":{\"command\":\"$BUN\",\"args\":[\"$DIR/echo-mcp.ts\",\"plugsrv\"]}}}" > "$PL/.mcp.json"

# a "generated" per-session plugin whose skill is a symlink to a dwa skill folder
mkdir -p "$OUT/dwa-skills/dwaskill" "$OUT/genplugin/.claude-plugin" "$OUT/genplugin/skills"
printf -- '---\nname: dwaskill\ndescription: dwa marker skill DWASKILL-1.\n---\nSay DWASKILL-1.\n' > "$OUT/dwa-skills/dwaskill/SKILL.md"
echo '{"name":"dwa","version":"0.0.1","description":"generated"}' > "$OUT/genplugin/.claude-plugin/plugin.json"
ln -sfn "$OUT/dwa-skills/dwaskill" "$OUT/genplugin/skills/dwaskill"

# settings variants
S="$BUN $DIR/status-log.ts"
echo "{\"statusLine\":{\"type\":\"command\",\"command\":\"$S quiet\"},\"permissions\":{\"allow\":[\"mcp__dwa\"]}}" > "$OUT/settings-quiet.json"
echo "{\"statusLine\":{\"type\":\"command\",\"command\":\"$S loud loud\"}}" > "$OUT/settings-loud.json"
echo '{"permissions":{"allow":["mcp__dwa"],"deny":["Skill(projskill)","Read(./file.txt)"],"defaultMode":"acceptEdits"}}' > "$OUT/settings-perm.json"
echo '{"permissions":{"allow":["mcp__dwa"]}}' > "$OUT/settings-allow.json"

# the candidate isolation settings: what --setting-sources does not cover
echo "{\"statusLine\":{\"type\":\"command\",\"command\":\"$S quiet\"},\"claudeMdExcludes\":[\"$HOME/.claude/CLAUDE.md\"],\"autoMemoryEnabled\":false,\"enabledPlugins\":{\"cc-plugin-easel@builtin\":false},\"permissions\":{\"allow\":[\"mcp__dwa\"]}}" > "$OUT/settings-iso.json"
echo "{\"claudeMdExcludes\":[\"$HOME/.claude/CLAUDE.md\"],\"autoMemoryEnabled\":false}" > "$OUT/settings-noallow.json"
echo "{\"claudeMdExcludes\":[\"$HOME/.claude/CLAUDE.md\"],\"autoMemoryEnabled\":false,\"skillOverrides\":{\"projskill\":\"off\",\"dataviz\":\"off\",\"code-review\":\"name-only\"},\"permissions\":{\"allow\":[\"mcp__dwa\"]}}" > "$OUT/settings-skoff.json"
echo "{\"statusLine\":{\"type\":\"command\",\"command\":\"$S refresh\",\"refreshInterval\":5}}" > "$OUT/settings-refresh.json"
echo "{\"hooks\":{\"SessionStart\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"touch $OUT/hook-sessionstart\"}]}],\"UserPromptSubmit\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"touch $OUT/hook-prompt\"}]}]}}" > "$OUT/settings-hook.json"
printf 'The file codeword is FILEMARK-5.\n' > "$OUT/append.md"

# role prompts: about 8 KB (fits a tmux command) and about 100 KB (does not)
bun -e '
const pad = "Filler sentence for the big role prompt size test. ".repeat(2000);
await Bun.write(process.argv[1] + "/agents-big.json", JSON.stringify({ big: { description: "big", prompt: "Your role codeword is BIGMARK-7.\n" + pad + "\nThe tail codeword is TAILMARK-8." } }));
' "$OUT"
bun -e '
const pad = "This paragraph is filler for the size test of the role prompt. ".repeat(125);
const agents = { reviewer: { description: "S5 role", prompt: "You are the S5 reviewer role. Your role codeword is ROLEMARK-42. Always state it when asked for the role codeword.\n" + pad } };
await Bun.write(process.argv[1] + "/agents.json", JSON.stringify(agents));
console.log("agents.json bytes", JSON.stringify(agents).length);
' "$OUT"
echo "ok $P"
