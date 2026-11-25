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
- Sessions are isolated from the user's own Claude setup (`--setting-sources project,local`, `--strict-mcp-config`, and the generated settings; see docs/spikes.md, S5). Whatever a session gets must come from the project's Claude files or from dwa configuration, and `dwa statusline` prints nothing.
- A role is a `.dwa/roles/<role>.toml` file. `.claude/agents/` is not read, and `--agent` is not used: the role's prompt is appended to the system prompt.
- A new capability field goes into `capabilityFields` only; `resolveSession` is the one place that decides what a session gets, and a spawn made by an agent (`narrowOnly`) may only take away.
- Role files and `[defaults]` are written only through `src/shared/role-edit.ts`, which keeps the rest of the file byte for byte (`setKeys` in `src/shared/toml.ts`) and records a version in `.dwa/history/`. Never rewrite one of these files from parsed values.
- History versions are never deleted or renumbered; switching moves the `current` pointer only.
- What a running session has is its stored `launch` plus the calls its hook refuses (`agents.blocked`). Claude Code does not re-read `--settings`, so a change is either such a refusal or a restart (`--resume`, same pane); see docs/spikes.md, S6. A restart resolves the session from the files as they are now.
- `dwa hook` prints nothing except the refusal of a blocked tool on `PreToolUse`. It decides that from `blocked.json` in the session's run folder, not from the daemon's answer, so a refusal holds while the daemon is down; change the list only through `Workspace.setBlocks`, which writes both the store and the file.
- A workflow step ends only through `complete_step` or `fail_step` (from its agent, or from the user with `dwa workflow complete` / `fail`) or its session ending, never because a turn ended or time passed.
- The workflow engine reads a step at its latest attempt only (`Store.workflowSteps`); a review that sends work back adds attempt rows, it never rewrites old ones.
- `Workspace.onAgentEvent` listeners run inside the tmux queue: only enqueue work there, never await a `Workspace` call.
- Colours in the panes come from `src/ui/theme.ts` only, as entries of the terminal's 16-colour palette (`RGBA.fromIndex`). OpenTUI's named helpers (`green`, `blue`, ...) are fixed RGB values that ignore the user's theme; do not use them. Selection is shown in inverse video, never by colour alone.
- `display-popup` only returns when the popup closes: never run it through the workspace's tmux queue or await it (`Workspace.popup`).
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
- `src/ui/` OpenTUI panes: `model.ts` is pure view logic, `agents.ts` and `status.ts` draw it; `wizard.ts` is the form engine for the popups and `wizards.ts` their screens, the menu included (no terminal code); `theme.ts` holds the colours; test with `createTestRenderer` from `@opentui/core/testing`
- `src/daemon/messaging.ts` messages and questions: delivery through the mailbox hook with a paste fallback, questions that never expire
- `src/mcp/server.ts` the MCP server each session runs for the dwa tools; stateless, every tool is a daemon request
- `src/cli/talk.ts` the user's `ask`, `answer` and `inbox` commands; `palette.ts` lists the project's roles; `init.ts` project setup; `roles.ts` the `role` and `config check` commands
- `src/shared/tools.ts` what the tools dialog shows and what its switches mean (pure); `src/shared/toml.ts` in-place TOML edits; `src/shared/history.ts` numbered versions; `src/shared/role-edit.ts` every change dwa makes to role files and `[defaults]`
- `src/ui/tool-screens.ts` the Agent tools dialog, `src/ui/role-screens.ts` the Role settings (files reached through `RoleStore`, `role-store.ts` being the real one); `src/cli/tools.ts` the `agent tools` command; `src/mcp/list-tools.ts` asks an MCP server for its tool names
- `src/shared/capabilities.ts` the fields that say what a session may use (shared by `[defaults]`, role files, `[[agents]]`, workflow steps and spawn requests); `src/shared/roles.ts` role files and `resolveSession`, which layers them into what a session is started with
- `src/daemon/workflows.ts` the workflow engine: runs, steps, review loops, live editing, reminders, resume after a restart; `src/shared/workflow.ts` the TOML definition format, parser and writer (pure); `src/cli/workflow.ts` the `workflow` command
- `examples/roles/` the roles, `examples/skills/` the skill and `examples/workflows/` the workflow `dwa init --roles` copies into a project
- Never test against the real project's workspace while the user may be using it; use a scratch project via `DWA_PROJECT`
- Tests use `test/fake-tmux.ts` instead of a real tmux server
- `spikes/` throwaway experiments; results are written up in `docs/spikes.md`
