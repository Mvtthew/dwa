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
- `src/shared/` constants, paths, config and profiles, environment cleaning, protocol types
- `src/daemon/` one process per project: `workspace.ts` is the application service (all tmux changes go through its serial queue), `server.ts` the Unix-socket API, `db.ts` the SQLite store
- `src/tmux/` private-server driver, generated config, layout operations
- `src/providers/` the provider interface and the Claude Code launch command
- `src/daemon/activity.ts` turns hook events and statusline JSON into agent activity and telemetry
- `src/cli/hook.ts` holds the `hook` and `statusline` commands Claude Code runs in every session; keep it fast, silent and free of heavy imports
- `src/ui/` OpenTUI panes: `model.ts` is pure view logic, `agents.ts` and `status.ts` draw it; test with `createTestRenderer` from `@opentui/core/testing`
- `src/daemon/messaging.ts` messages and questions: delivery through the mailbox hook with a paste fallback, questions that never expire
- `src/mcp/server.ts` the MCP server each session runs for the dwa tools; stateless, every tool is a daemon request
- `src/cli/talk.ts` the user's `ask`, `answer` and `inbox` commands
- Never test against the real project's workspace while the user may be using it; use a scratch project via `DWA_PROJECT`
- Tests use `test/fake-tmux.ts` instead of a real tmux server
- `spikes/` throwaway experiments; results are written up in `docs/spikes.md`
