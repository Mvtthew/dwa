# dwa

Terminal workspace that runs a main Claude Code session plus agent sessions in tmux and lets them message each other and the user. Bun + TypeScript, MIT.

Read `docs/architecture.md` before changing the design, and `docs/spikes.md` for what has been proven by experiment.

## Commands

- `bun test`, `bun run typecheck`, `bun run lint`, or all three with `bun run check`
- `bun run format` applies Biome fixes
- `bun run dwa <command>` runs the CLI from source

## Rules that are easy to break

- dwa only launches the unmodified interactive Claude command. Never drive agents with `claude -p` or the Agent SDK: subscription logins are only allowed with the native CLI.
- Never assume the executable is called `claude`. It comes from a profile (`src/shared/constants.ts` has the default and the env override).
- Never touch the user's own tmux server or config. All tmux calls go to the private server (`tmux -L dwa -f <generated conf>`).
- Never write to `~/.claude` or the project's `.claude/settings.json`. Per-session settings are generated under `.dwa/run/` and passed with `--settings` and `--mcp-config`.
- Agent state comes from hooks and the statusline JSON, not from reading the screen.
- A blocking `ask` or `wait_for` has no timeout. Questions are stored and stay open until answered or cancelled.
- The name "dwa" lives in `src/shared/constants.ts`; import it instead of repeating the string. "Claude Code" must not become part of the product name.
- `@opentui/core` is pre-1.0 and pinned to an exact version. Upgrade it on purpose, not as part of other work.

## Layout of the code

- `src/cli/` command entry points
- `src/shared/` constants, paths, version helpers, protocol types
- Planned, created when their milestone starts: `src/daemon/`, `src/tmux/`, `src/providers/`, `src/mcp/`, `src/ui/`
- `spikes/` throwaway experiments; results are written up in `docs/spikes.md`
