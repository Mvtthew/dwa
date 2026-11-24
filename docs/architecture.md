# dwa: terminal workspace for Claude Code agents (MVP plan)

## Context

The goal is an open source terminal workspace that runs a main Claude Code session plus several agent sessions in tmux, with a dashboard, where agents and the user can message each other, ask questions, report progress and wait on decisions, in parallel.

Decisions made: MVP is **workspace + messaging** (workflow engine and shared memory come later), **Claude Code only** behind a provider interface, name and command **`dwa`**, license **MIT**, runtime **Bun + TypeScript**.

The plan was written and tested against Bun 1.4.3, Claude Code 2.1.331 and tmux 3.8.

## Survey: what the research changes in the original document

1. **Claude Code now ships much of the plumbing natively.** The original plan predates this and would rebuild it.
   - Cross-session messaging (`ListAgents`, `SendMessage`, per-session inbox socket; an idle session gets a new turn started). Stable, local, on by default since 2.1.224.
   - 33 hook events, including `Stop`, `Notification` (`permission_prompt`, `idle_prompt`), `PermissionRequest`, `SessionStart/End`, `SubagentStop`. Hook types include `command`, `http`, `mcp_tool`.
   - Statusline JSON with context window %, cost and 5 hour / 7 day subscription limits. This covers the "context usage" panel without estimates.
   - `claude agents --json` lists sessions with `busy / waiting / idle`.
   - So dwa should be a **thin layer over native primitives**, not a parallel infrastructure. Anthropic keeps shipping first-party versions of these features, so thin also means less to throw away.
2. **Not building on:** agent teams (experimental, one team per session, no resume, state files not meant to be edited), channels (research preview, custom channels show a confirmation dialog on every launch), background sessions `claude --bg` (headless under Anthropic's supervisor, not panes you can type into). Worth watching, not depending on.
3. **Subscription login.** Anthropic's legal page allows an end user to sign in to the unmodified Claude Code binary with their own plan, and does not allow third-party tools to route requests through plan credentials. So dwa only launches the native interactive `claude` and never uses `claude -p` or the Agent SDK to drive agents. Also: "Claude Code" must not be part of the product name; `dwa` is fine.
4. **Terminal composition: tmux hybrid wins.**
   - tmux owns persistence and renders the native sessions; our TUI runs only in the dashboard panes. Lowest effort, highest fidelity.
   - Owning the whole screen with OpenTUI's embedded terminal (Ghostty VT) is possible now, but we would have to build persistence, reattach and key passthrough ourselves. Kept as a later option.
   - Require **tmux 3.7+** (synchronized output; older versions flicker with Claude Code). Use a private server (`tmux -L dwa -f <our conf>`), so your own tmux config is never touched.
   - **Claude Code renders badly below about 80 columns.** Twelve live mini-panes on the right, as in the sketch, will not work. See "Layout" for what replaces it.
5. **Prior art** (claude-squad, workmux, herdr, Gas Town, overstory, agent-deck, ccmanager and others):
   - Reliable: tmux session per agent, hook-driven status, a daemon or database as source of truth.
   - Fragile: detecting state by reading the screen (herdr broke on a Claude Code update), raw `send-keys` (lost newlines, swallowed Enter), large role swarms (cost, merge conflicts; overstory is archived, Gas Town "fell apart").
   - Already common, not worth rebuilding: session dashboards, worktree per task, usage viewers (ccusage).
   - Gaps dwa can fill: a first-class **question and decision queue** between agents and the user, hook-based state that survives CLI updates, and later deterministic workflows on top of interactive sessions (nobody does this).
6. **Dashboard library:** OpenTUI core (`@opentui/core`, 0.9.x, used in production by opencode), pinned to an exact version because it is pre-1.0.

## Architecture

```
tmux -L dwa (private server, generated config)
├─ window "workspace"
│   ├─ left pane   : dwa ui status   (OpenTUI)
│   ├─ centre top    : native `claude` main session (always visible)
│   ├─ centre bottom : the selected agent's native `claude` (only while an agent is selected)
│   └─ right pane  : dwa ui agents   (OpenTUI)
└─ window "pool"   : one parked pane per unselected agent, each a native `claude`

dwa daemon (Bun, one per project)
├─ Unix socket API (HTTP + WebSocket) used by the CLI, the UI panes, hooks and the MCP shim
├─ SQLite (bun:sqlite): agents, events, messages, questions
├─ tmux driver (plain tmux CLI calls; control mode only if needed later)
└─ provider interface → claude provider (launch flags, generated settings, hook mapping)
```

- **Layout.** The main session is **always visible** at the top of the centre column and never moves. The right pane is a list of agent tiles (name, role, state, current activity, "needs you" marker), not live terminals. It shows **only active agents** (sessions that are running): no empty slots and no placeholders for roles that have not been started. At most 12 tiles are visible at once; with more, the list scrolls (mouse wheel, `j/k` or arrows when the pane has focus) and the header shows the count, for example `AGENTS 5` or `AGENTS 1–12 of 15`. A stopped agent's tile disappears; with no agents the pane shows a one-line hint on how to spawn one. Selecting an agent opens its native session in a pane **under the main session** (`join-pane -v` from the pool into the centre column, full centre width so it stays above 80 columns). Selecting another agent swaps it into that same lower pane (`swap-pane`); closing the lower pane sends the agent back to the pool, still running, and main gets the full height again. Default split is about 60% main / 40% agent, resizable, and `Alt+z` zooms whichever pane has focus.
- **Launching an agent.** `<profile command> --session-id <uuid> -n <name> --agent <role> --settings <generated.json> --mcp-config <generated.json> --strict-mcp-config? --append-system-prompt-file <dwa-protocol.md>` with `DWA_AGENT_ID` and `DWA_SOCKET` in an otherwise cleaned environment (no inherited `CLAUDE*` or `TMUX` variables), plus `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`, `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0` and a very large `MCP_TOOL_TIMEOUT` so a blocking `ask` is not cut short. Generated settings carry the hooks, the statusline command and `crossSessionInbound: accept`. Nothing is written to your `~/.claude` or the project's `.claude/settings.json`.
- **Configurable Claude command.** `claude` is only the default. The executable is set through named profiles, so different accounts or wrappers can be used:

  ```toml
  # ~/.config/dwa/config.toml (personal), overridable in the project's .dwa/config.toml
  default_profile = "me"
  [profiles.me]
  command = "~/claude_me"
  [profiles.work]
  command = "~/claude_work"
  ```

  - Selection order: per-agent setting (`profile = "work"` on an agent in `.dwa/config.toml`, or `dwa agent spawn --profile work`), then `dwa up --profile <name>`, then `DWA_CLAUDE_COMMAND`, then `default_profile`, then plain `claude`. Main and agents may use different profiles in one workspace.
  - `~` and environment variables are expanded; a profile may also carry extra `args` and `env`.
  - The command must accept the normal Claude Code flags and pass them through (a wrapper script that ends in `exec claude "$@"` works). dwa adds its own flags after the command and never assumes the binary is named `claude`.
  - `dwa doctor` runs `<command> --version` for every profile and reports a missing command or a too-old version. Each agent tile shows its profile when more than one is in use.
- **Model and effort.** Passed as `--model` and `--effort`. dwa resolves them itself so the order does not depend on how Claude Code weighs a flag against a role file: the agent's own setting (config entry, workflow step, spawn request), then `model:` / `effort:` in the role file, then `[defaults]` in the config. With none, no flag is passed. The main session is not affected by any of this; it takes `model` and `effort` from the `[main]` section only, placed after the profile's arguments so they win over a model set there.
- **Agent roles reuse the native format**: `.claude/agents/*.md` (frontmatter + prompt), run with `--agent`. dwa adds only `.dwa/config.toml` (which agents to start, layout, keys). No new YAML agent schema.
- **State.** Hooks call `dwa hook <event>` (command hook that forwards the JSON to the daemon socket). Mapping: `SessionStart` → started, `UserPromptSubmit`/`PreToolUse` → working, `Stop` → idle, `Notification(permission_prompt)`/`PermissionRequest` → needs user, `SessionEnd` → stopped. `dwa statusline` forwards the statusline JSON (context %, limits, cost) and prints a short line. No screen reading.
- **Messaging.** An MCP server (`dwa mcp`, stdio shim to the daemon, identifies the caller by `DWA_AGENT_ID`) gives every session these tools:
  - `list_agents`, `spawn_agent(role, task)`, `stop_agent`
  - `send_message(to, body)`: fire and forget, to an agent or the user
  - `ask(to, question, options?)`: **blocks** until the other agent or the user answers; the answer is the tool result. The asker shows as "waiting on X" in the dashboard. **There is no timeout**: dwa never expires a question and never returns a default answer; a question stays open until it is answered or the user cancels it. It is stored in SQLite, so it also survives a daemon restart or a resumed session. The same holds for `wait_for`.
  - `report_progress(summary, percent?)`, `wait_for(agent | question)`
  - Questions addressed to the user land in a queue in the left pane and are answered there, or by focusing the agent and typing.
- **Delivering a message into a running session** was settled by spike S3 (see [spikes.md](spikes.md)): (1) a mailbox hook: an `asyncRewake` command hook registered on `SessionStart` and `Stop` waits on the daemon and exits with code 2 when a message arrives, which wakes even an idle session; (2) `load-buffer` + `paste-buffer -p` + Enter as a fallback, only when hooks say the session is idle. Agents may also use Claude Code's native `SendMessage` with each other; the daemon sees those through hooks. Writing to the native inbox socket from outside is not used, its payload format is undocumented. The daemon hides this behind one `deliver(agentId, message)` function.
- **Keys.** A prefix key (`Ctrl+Q` by default, `keys.prefix` in the config), then `1..9` to open the agent at that visible position under main (agents further down are opened from the list or the palette), `0` focus main, `x` close the agent pane, `z` zoom, `d` detach. A prefix is the default because Alt/Option shortcuts do not reach the terminal on macOS layouts where Option types characters (Option+1 is `Ń` on the Polish layout). The same actions are also bound to Alt for terminals that send Option as Meta. tmux's default bindings are removed. The command palette and question queue get keys in M4.
- **Worktrees.** Off by default; a role can opt in and then the agent is started with native `claude -w <name>`. Merge handling is post-MVP.

## Repository layout

Single package to start (no monorepo):

```
src/
  cli/          entry + commands: up, attach, down, agent {spawn,list,send,stop}, ask, hook, statusline, mcp, ui, doctor
  daemon/       server.ts, db.ts (schema + migrations), events.ts, services/{agents,messages,questions,delivery}.ts
  tmux/         driver.ts, layout.ts, conf.ts (generated tmux.conf)
  providers/    provider.ts (interface), claude/{launch,settings,hooks}.ts
  mcp/          server.ts (stdio shim)
  ui/           status.ts, agents.ts, palette.ts (OpenTUI core)
  shared/       protocol.ts (zod schemas), paths.ts, constants.ts (name "dwa" in one place)
spikes/         throwaway scripts for S1–S4
docs/           research.md (the survey with sources), architecture.md, spikes.md (results)
test/
```

Tooling: `bun test`, Biome (lint + format), `tsc --noEmit`, GitHub Actions (typecheck, lint, test on macOS + Linux), `bun build --compile` for a single binary later. Dependencies: `@opentui/core` (exact pin), `@modelcontextprotocol/sdk`, `zod`. Root files: `README.md`, `LICENSE` (MIT), `CLAUDE.md`, `.gitignore`, `package.json`, `tsconfig.json`, `biome.json`.

## Status

M0 to M4 are implemented, except the demo recording. The first part of the workflow engine (the DAG runner) is implemented too; see "Workflow engine". Results of the experiments are in [spikes.md](spikes.md). What remains is listed under "After the MVP", plus two checks that need a person or more time: a message arriving while an agent is in the middle of a long tool call, and blocking waits of many hours.

## Milestones

**M0. Scaffold and spikes** (decides the uncertain parts before real code)

- Init the Bun project and the files above; write `docs/research.md` from the survey; install tmux.
- S1 tmux: Claude Code in the private tmux server with `allow-passthrough on`, `focus-events on`, `extended-keys always`, `extended-keys-format csi-u`, `mouse on`. Check Shift+Enter, paste, scroll, flicker; opening an agent under main with `join-pane -v`, swapping agents in the lower pane and sending one back to the pool, and how Claude Code redraws in both panes after each height change; the smallest pane height and width that still render.
- S2 state: generated `--settings` with hooks and statusline; confirm the event sequence for working, idle and permission prompt; check whether `claude agents --json` reports interactive sessions.
- S3 delivery: try the three delivery mechanisms against a busy session and an idle session; record which wake an idle session and how the message appears.
- S4 blocking `ask` with no timeout: hold an MCP tool call open for hours and find every limit on the Claude Code side (`MCP_TOOL_TIMEOUT` and any hard cap), then remove them: set the timeout env var to its maximum in each agent's launch environment and send MCP progress notifications as keep-alive. If Claude Code still has a cap that cannot be lifted, the wait stays infinite from the agent's point of view: the call returns "still pending", the protocol prompt tells the agent to call `wait_for(question_id)` again and do nothing else, and the answer is also pushed through `deliver`. The question itself never expires in either case.
- Results go to `docs/spikes.md`; adjust the design below if a spike fails.

**M1. Workspace.** Daemon with socket API and SQLite; tmux driver and generated config; `dwa up` / `attach` / `down`; main session in the centre; `dwa agent spawn|list|stop`; config loading with profiles for the Claude command (`--profile`); `dwa doctor` (tmux ≥ 3.7, every profile's command present and Claude Code ≥ 2.1.224, Bun version).

**M2. Live state.** `dwa hook`, `dwa statusline`, state machine per agent, events table; agents pane and status pane in OpenTUI; open an agent under main, swap, close, zoom.

**M3. Messaging.** MCP shim and tools, delivery service, question queue with answering from the dashboard, the protocol prompt appended to every agent, `dwa agent send` and `dwa ask` for manual use without any model call.

**M4. Polish for a first release.** Command palette, configurable keys, `.dwa/config.toml`, two or three example roles in `.claude/agents/`, reattach after closing the terminal, README with a demo recording, CI green.

**After the MVP:** workflow engine (DAG: done; revisions and live editing: to do), shared memory with provenance, Codex provider, Claude Code configuration manager (settings, hooks, MCP, plugins, usage), worktree merge flow, packaging as a Claude Code plugin for one-command install.

## Workflow engine

Deterministic workflows on top of interactive sessions. Part 1, the DAG runner, is implemented. The control flow is the daemon's; the work inside a step is an ordinary agent session the user can open and type into.

- **Definition.** One TOML file per workflow in `.dwa/workflows/<name>.toml`: `[steps.<id>]` with `prompt`, and optionally `role`, `profile`, `depends_on`, `keep_agent`. Prompts may use `{{input}}` and `{{steps.<id>.result}}` for steps they depend on. Validated with zod; unknown keys, unknown dependencies, cycles and placeholders for non-ancestors are errors.
- **Run.** `Workflows` in `src/daemon/workflows.ts` starts a step by spawning an agent (`Workspace.spawn`) with the rendered prompt as its task, as soon as all its dependencies are done. Independent steps run in parallel. Changes to runs go through the engine's own serial queue.
- **Completion is explicit.** A step ends when its agent calls the `complete_step(result)` or `fail_step(reason)` tool, or when its session is gone (failed). The end of a turn is not completion: the agent gets a reminder through the mailbox, at most twice, then the user is told and the step is marked as needing attention. There is no timeout.
- **Failure.** After a failed step nothing new starts, running steps finish, pending ones are skipped, and the run ends as failed. No retries yet.
- **State.** `workflow_runs` and `workflow_steps` in SQLite. A run stores a snapshot of its definition, so editing the file does not affect it. On daemon start `resume()` fails steps whose session did not survive and starts steps that became ready.
- **Reporting.** When a run ends, whoever started it (the user or an agent) gets a message with the outcome. Runs are part of the workspace state the panes poll, and the status pane lists them.
- **Events.** `Workspace.onAgentEvent` reports `turn_ended` and `stopped`. Listeners run inside the tmux queue, so they must only enqueue work and never wait on the workspace.

Still to do, each as its own piece of work:

- **Revisions (review loops):** a step sent back for another pass, for example when a reviewer rejects it. `workflow_steps.attempt` is reserved for this and is always 1 today.
- **Live editing** of a run in progress. The per-run definition snapshot is where an edit would apply.
- Conditions, retries, a worktree per step.

## Verification

- Unit tests (`bun test`): state machine from recorded hook payloads, tmux command builders, settings and MCP config generation, message and question services against in-memory SQLite.
- Integration test: start the private tmux server with a fake agent (a small script that emits the same hook calls), assert layout and state transitions through the daemon API. Runs in CI without a Claude login.
- Manual end to end after M3: `dwa up`, ask the main session to spawn two agents; one agent calls `ask` on the other and on the user; answer from the dashboard; confirm the asker resumes, states in the right pane match reality, closing the terminal and `dwa attach` restores everything.
- Tests, typecheck and lint run through the `runner` agent; UI checks are done in tmux by hand (no browser involved).
