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
- Sessions are isolated from the user's own Claude setup (`--setting-sources project,local`, `--strict-mcp-config`, and the generated settings; see docs/spikes.md, S5). Whatever a session gets must come from the project's Claude files or from dwa configuration, and `dwa statusline` prints only the one line the daemon gives it (`sessionLine` in `src/daemon/activity.ts`): Claude Code keeps a row for the status line even when it is empty.
- A role is a `.dwa/roles/<role>.toml` file, a personal one, or one built into dwa (`examples/roles/`, `builtinRolesDir`), found in that order (`findRole`). A built-in role is never written to: it is copied into a file first (`adoptRole`), and `listAllRoles` and the editors see files only. `.claude/agents/` is not read, and `--agent` is not used: the role's prompt is appended to the system prompt.
- A new capability field goes into `capabilityFields` only; `resolveSession` is the one place that decides what a session gets, and a spawn made by an agent (`narrowOnly`) may only take away.
- Built-in tools and skills are given, never assumed: a session has the tools of its `tools` list or `DEFAULT_TOOLS` (`listedTools` in `src/shared/capabilities.ts`; `deny_tools` takes away from that list, `"*"` is the only way to every tool) and no built-in skill unless `builtin_skills` names it. Do not add a tool to `DEFAULT_TOOLS` for convenience: each one is sent with every request of every session (docs/spikes.md, S9). `BUILTIN_SKILLS` and `BUILTIN_TOOLS` are the Claude command's names at one version; the `Skill` check of the hook (`skillRefusal`, `skills.json`, written from `ResolvedSession.allowedSkills`) is what holds when they change, so keep it independent of those lists.
- The Claude command's own subagents are off in every session (`SUBAGENT_TOOLS` in `src/shared/capabilities.ts`, taken away in `resolveSession`, and with them the built-in skills that fork a subagent by themselves, `SUBAGENT_SKILLS`) unless `subagents = true`. A skill whose file says `context: fork` is not left to the Claude command either: `resolveSession` moves it from `skills` to `agentSkills`, the session is told to start it with `spawn_agent` and `skill`, and the new session reads the skill's file as its task (`src/shared/skill-guide.ts`). Never give such a session the skill itself: it would fork again. Delegation goes through `spawn_agent`; do not give `Agent` back through a tool list.
- Role files, `[defaults]` and `[main]` (`saveMain`, the leader mode switch) are written only through `src/shared/role-edit.ts`, which keeps the rest of the file byte for byte (`setKeys` in `src/shared/toml.ts`) and records a version in `.dwa/history/`. Never rewrite one of these files from parsed values.
- Workflow files are written only through `src/shared/workflow-edit.ts`, which edits the text in place the same way and records a version. `formatWorkflow` writes a whole text afresh and is for a run's own copy only; never use it on a file.
- An agent writes a role file only through `save_role` (`RoleAuthor.saveFile`), which accepts only the session `RoleAuthor.author` started and only the role that session was started for. Never widen that: a role file is what `narrowOnly` narrows.
- A role or a workflow is addressed by name and source (`src/shared/scope.ts`) wherever a file is edited, moved or versioned. Only what a session or a run uses goes by name alone, and there the project's item wins over a personal one.
- History versions are never deleted or renumbered; switching moves the `current` pointer only.
- What a running session has is its stored `launch` plus the calls its hook refuses (`agents.blocked`). Claude Code does not re-read `--settings`, so a change is either such a refusal or a restart (`--resume`, same pane); see docs/spikes.md, S6. A restart resolves the session from the files as they are now.
- `dwa hook` prints nothing except the refusal of a blocked tool on `PreToolUse` (also of a `Skill` call for a skill the session was not given, from `skills.json` there), the approval of dwa's own tools in plan mode on `PermissionRequest` (`approvesOwnTool`; plan mode ignores the `mcp__dwa` allow rule), and on `PostToolUse` and `PostToolUseFailure` the reminder for a main session that leads (`additionalContext`, from the daemon's `context`; `src/shared/nudge.ts`, docs/spikes.md S11). A reminder never refuses, comes from the daemon only (none while it is down), and is for a leading main session alone: do not turn it into a refusal or send it to agents. It decides the refusal from `blocked.json` in the session's run folder, not from the daemon's answer, so a refusal holds while the daemon is down; change the list only through `Workspace.setBlocks`, which writes both the store and the file.
- `when_to_use`, `role_list` and `in_role_list` are plain role-file fields, not capability fields. The list of roles a session is given is made when its files are written (`src/shared/role-guide.ts`, in `Workspace.sessionFiles`) and is never part of `ResolvedSession`; an optional field there (`roleList`) is set only when it is on, because the stored session is compared with a new one (`liveBlocks`).
- An agent another session started with `spawn_agent` (`agents.spawned_by`) ends only through `finish_task` or by being stopped, never because a turn ended or time passed, and dwa never stops one that has not reported. Ending is `Workspace.stop`: nothing of the row or the run folder is deleted.
- `Delegation` touches only rows with `spawned_by`, the workflow engine only step agents. Only a spawn request with `from` sets it: the `spawn_agent` tool, and `agent spawn` of the CLI when it runs inside a session (`spawnOrigin` in `src/shared/env.ts`), which is then narrow-only too. The engine, the role and workflow authors, `[[agents]]`, the user's own CLI and the menu never send it.
- A workflow step ends only through `complete_step` or `fail_step` (from its agent, or from the user with `dwa workflow complete` / `fail`) or its session ending, never because a turn ended or time passed.
- The workflow engine reads a step at its latest attempt only (`Store.workflowSteps`); a review that sends work back adds attempt rows, it never rewrites old ones.
- A session's task is never a launch argument and never comes through a hook: it is typed into the prompt box once the session's dwa tools have connected (`Workspace.ready`). Only a prompt from the prompt box, or a tool result, shows a session the tools of an MCP server that connected late; see docs/spikes.md, S8.
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
- `src/daemon/feed.ts` the event feed: recaps, spawns, results, messages, workflow steps and lifecycle items, written where each happens (a write never throws), read with `GET /feed` and `GET /feed/item`
- `src/daemon/activity.ts` turns hook events and statusline JSON into agent activity and telemetry
- `src/cli/hook.ts` holds the `hook` and `statusline` commands Claude Code runs in every session; keep it fast, free of heavy imports and silent apart from what its comments name
- `src/shared/shortcuts.ts` every shortcut once (key, label, category, action); the tmux bindings, the top bar and its `display-menu` dropdowns (`menuArgs` in `src/tmux/conf.ts`) are made from it
- `src/ui/` OpenTUI panes: `model.ts` is pure view logic, `agents.ts`, `status.ts` and `topbar.ts` draw it; `feed.ts` is the event feed pane and `feed-model.ts` its pure logic (filters, lines); `wizard.ts` is the form engine for the popups and `wizards.ts` their screens, the menu included (no terminal code); `theme.ts` holds the colours; test with `createTestRenderer` from `@opentui/core/testing`
- `src/daemon/messaging.ts` messages and questions: delivery through the mailbox hook with a paste fallback, questions that never expire
- `src/mcp/server.ts` the MCP server each session runs for the dwa tools; stateless, every tool is a daemon request
- `src/cli/talk.ts` the user's `ask`, `answer` and `inbox` commands; `palette.ts` lists the project's roles; `init.ts` project setup; `roles.ts` the `role` and `config check` commands
- `src/shared/tools.ts` what the tools dialog shows and what its switches mean (pure); `src/shared/toml.ts` in-place TOML edits; `src/shared/history.ts` numbered versions; `src/shared/role-edit.ts` every change dwa makes to role files and `[defaults]`
- `src/ui/tool-screens.ts` the Agent tools dialog, `src/ui/role-screens.ts` the Role settings (files reached through `RoleStore`, `role-store.ts` being the real one); `src/cli/tools.ts` the `agent tools` command; `src/mcp/list-tools.ts` asks an MCP server for its tool names
- `src/shared/capabilities.ts` the fields that say what a session may use (shared by `[defaults]`, role files, `[[agents]]`, workflow steps and spawn requests); `src/shared/roles.ts` role files and `resolveSession`, which layers them into what a session is started with
- `src/daemon/workflows.ts` the workflow engine: runs, steps, review loops, live editing, reminders, resume after a restart; `src/shared/workflow.ts` the TOML definition format, parser and writer (pure); `src/cli/workflow.ts` the `workflow` command
- `src/daemon/delegation.ts` work handed over outside workflows: who an agent owes its result to, `finish_task`, reminders, what `wait_for` returns for an agent that is gone; `src/shared/role-guide.ts` the list of roles a session can hand work to (pure); `src/shared/skill-file.ts` reads a skill's front matter and `src/shared/skill-guide.ts` makes the list of skills a session starts as agents and the task of such an agent (pure)
- `src/daemon/role-author.ts` roles written by an agent: the `role-author` session and the `save_role` tool behind "Describe it to an agent" in the role settings
- `src/shared/scope.ts` project and personal items; `src/shared/workflow-edit.ts` every change dwa makes to workflow files; `src/shared/diagram.ts` the picture of a workflow as cells and click regions (pure); `src/cli/workflow-files.ts` the `workflow` commands that work on the files
- `src/ui/designer.ts` the workflow designer on screen, `designer-model.ts` its session, undo and what is shown (pure), `designer-gesture.ts` drags, `diagram-view.ts` the picture; `workflow-screens.ts` and `run-screens.ts` its screens as data (files reached through `WorkflowStore`, `workflow-store.ts` being the real one)
- `examples/roles/` the roles and `examples/skills/` the skill dwa carries as built in, and `examples/workflows/` the workflows; `dwa init --roles` copies all three into a project. The workflows double as the designer's templates and must use only those roles
- Tests that read roles from a real folder set `DWA_BUILTIN_DIR` (empty for none) so the built-in roles do not show up in them
- Never test against the real project's workspace while the user may be using it; use a scratch project via `DWA_PROJECT`
- Tests use `test/fake-tmux.ts` instead of a real tmux server
- UI tests must live in `test/`: a script run from outside the project loads a second copy of `@opentui/core`, and mouse events never reach the components
- `spikes/` throwaway experiments; results are written up in `docs/spikes.md`
