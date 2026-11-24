# Research survey (2026-11-24)

What exists, what Claude Code offers to build on, and how to compose the terminal. This is the evidence behind [architecture.md](architecture.md). Checked against Claude Code 2.1.331 and tmux 3.8. Items marked _unverified_ were not confirmed from a primary source or by experiment; the spikes in [spikes.md](spikes.md) cover the ones the design depends on.

## 1. What Claude Code exposes

### Getting a message into a running interactive session

| Mechanism                                                                               | Status                              | Wakes an idle session                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging.md)   | Stable, on by default since 2.1.224 | Yes, starts a new turn                                     | `ListAgents` + `SendMessage`. Local messages use a per-session Unix socket. Socket path and token are exported to hooks and Bash as `CLAUDE_CODE_MESSAGING_SOCKET` / `CLAUDE_CODE_MESSAGING_TOKEN`. Plain text, 50-message queue, throttled. `crossSessionInbound` = `accept` / `hold` / `refuse`. The receiver is told the message is not from the user. Wire format for a third-party process posting to another session's socket is _unverified_. |
| [Hooks](https://code.claude.com/docs/en/hooks.md): `Stop` returning `decision: "block"` | Stable                              | No, fires only at turn end                                 | Capped at 8 consecutive continuations.                                                                                                                                                                                                                                                                                                                                                                                                               |
| Hooks: `asyncRewake`                                                                    | Stable                              | Yes (exit code 2 wakes Claude, stderr shown as a reminder) | Using a long-lived re-arming hook as a mailbox is _unverified_.                                                                                                                                                                                                                                                                                                                                                                                      |
| [Channels](https://code.claude.com/docs/en/channels.md)                                 | Research preview                    | Queued to next turn                                        | Custom channels need `--dangerously-load-development-channels`, which shows a dialog on every launch.                                                                                                                                                                                                                                                                                                                                                |
| `tmux send-keys` / paste                                                                | Not an official mechanism           | Yes                                                        | Known problems: lost newlines with extended keys, swallowed Enter, trust prompt eating the first prompt.                                                                                                                                                                                                                                                                                                                                             |

### Native multi-agent features (not used as a base)

- [Agent teams](https://code.claude.com/docs/en/agent-teams.md): experimental, off by default. One team per session, fixed lead, no nested teams, no resume of in-process teammates. State in `~/.claude/teams/` is runtime state, not meant to be edited.
- [Background sessions / agent view](https://code.claude.com/docs/en/agent-view.md): research preview. `claude --bg`, `claude agents`, `attach`, `logs`. Headless sessions under Anthropic's supervisor, not panes the user types into.
- [Subagents](https://code.claude.com/docs/en/sub-agents.md): stable; the `.claude/agents/*.md` format is reused by dwa for roles.

### State and telemetry without reading the screen

- Hooks: 33 events. Useful for lifecycle: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Notification` (`permission_prompt`, `idle_prompt`, `agent_needs_input`), `Stop`, `SubagentStop`, `PreCompact`, `SessionEnd`. Common input: `session_id`, `transcript_path`, `cwd`, `permission_mode`. `Stop` input also has `last_assistant_message` and `background_tasks`. Handler types: `command`, `http`, `mcp_tool`, `prompt`, `agent`.
- [Statusline JSON](https://code.claude.com/docs/en/statusline.md): `context_window.used_percentage`, `cost.total_cost_usd`, `rate_limits.five_hour` / `seven_day` (Pro/Max only, after the first response), `model`, `session_id`.
- `claude agents --json`: `pid`, `cwd`, `sessionId`, `name`, `status` (`busy` / `waiting` / `idle`), `waitingFor`. Whether interactive sessions in tmux get a `status` is _unverified_.
- Transcripts at `~/.claude/projects/<project>/<session-id>.jsonl`; the format is internal and may change.

### Launch flags used per session

`--session-id`, `-n/--name`, `--agent`, `--settings <file-or-json>`, `--mcp-config`, `--strict-mcp-config`, `--append-system-prompt-file`, `--model`, `--permission-mode`, `-w/--worktree`, `-r/--resume`. Do not use `--bare` (it never reads the subscription login).

### Subscription login

From the [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance.md): Anthropic "does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users", and this does not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". Consequence: dwa launches the native interactive CLI only. The same page forbids using "Claude Code" as part of a product name.

## 2. Terminal composition

|                            | tmux panes only         | Own TUI + PTY + emulator              | Hybrid (chosen)       |
| -------------------------- | ----------------------- | ------------------------------------- | --------------------- |
| Fidelity of the native CLI | High                    | Medium, depends on the emulator       | High                  |
| Persistence                | Free                    | Must be built (daemon + screen model) | Free                  |
| MVP effort                 | Low                     | High                                  | Low to medium         |
| Control over look          | Medium                  | Full                                  | Medium                |
| Main risk                  | Resize and narrow panes | Emulator gaps, reattach               | Pane moves and resize |

- **tmux**: latest is 3.8. 3.7 added synchronized output (DECSET 2026); Claude Code's [fullscreen docs](https://code.claude.com/docs/en/fullscreen.md) say older versions flicker. [Recommended settings](https://code.claude.com/docs/en/terminal-config): `allow-passthrough on`, `focus-events on`, `extended-keys on`, `terminal-features 'xterm*:extkeys'`; some setups need `extended-keys always` and `extended-keys-format csi-u` for Shift+Enter.
- **Narrow panes**: Claude Code corrupts its rendering at roughly 36 columns and has an 80-column code path, so keep agent panes at 80 columns or wider ([report](https://cybersader.github.io/agentic-workflow-and-tech-stack/agent-context/zz-research/2026-04-23-claude-code-ink-narrow-pane-bug/)).
- **Own TUI**: Bun has a built-in PTY since 1.3.5 (`Bun.spawn({ terminal })`). OpenTUI ships an [`EmbeddedTerminalRenderable`](https://opentui.com/docs/components/embedded-terminal) built on Ghostty's VT library. Viable later; persistence and key passthrough would be ours to build. [lazyclaude #93](https://github.com/maxenceng/lazyclaude/issues/93) lists the pain points.
- **Dashboard library**: [OpenTUI](https://github.com/anomalyco/opentui) core 0.9.9 (MIT, Bun-only, used by opencode). Pre-1.0, so pinned exactly.
- **Alternatives**: zellij is a serious option but less common and its plugins are Rust/WASM. Terminal-native splits (WezTerm, kitty, Ghostty) tie the tool to one terminal.

## 3. Prior art

| Project                                                                                                                             | Composition                  | Messaging and state                                 | Notes                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| [claude-squad](https://github.com/smtg-ai/claude-squad) (Go)                                                                        | tmux session per agent + TUI | None between agents                                 | AGPL-3.0                                                             |
| [workmux](https://github.com/raine/workmux) (Rust)                                                                                  | tmux window per worktree     | Status from installed hooks                         | MIT. "Worktrees do not prevent merge conflicts"                      |
| [herdr](https://github.com/herdrdev/herdr) (Rust)                                                                                   | Own multiplexer              | Socket API; state from process and output           | Apache-2.0. Broke when a Claude Code update changed the title marker |
| [Gas Town](https://github.com/gastownhall/gastown) (Go)                                                                             | tmux roles                   | Hook-injected mail; nudge by send-keys with a delay | MIT. High cost, complexity                                           |
| [overstory](https://github.com/jayminwest/overstory) (Bun/TS)                                                                       | tmux or headless workers     | SQLite mail, watchdog                               | MIT, archived. Merge conflicts "the normal case"                     |
| [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)                                                               | MCP mailbox                  | Agents poll; nothing wakes an idle agent            | License unclear                                                      |
| [ccmanager](https://github.com/kbwo/ccmanager) (TS)                                                                                 | Own PTY, no tmux             | Per-CLI state strategies                            | MIT. Closing it kills agents                                         |
| [agent-deck](https://github.com/asheshgoplani/agent-deck), [agent-of-empires](https://github.com/agent-of-empires/agent-of-empires) | tmux + TUI/web               | Little or no inter-agent messaging                  | MIT                                                                  |
| [opencode](https://github.com/anomalyco/opencode)                                                                                   | Background server + clients  | HTTP API, event log                                 | MIT. Reference for the daemon/client split and OpenTUI use           |

What holds up: a tmux or PTY session per agent with a persistent server, hook-driven status, a daemon or database as source of truth.

What breaks: state detection from screen content, raw `send-keys`, large swarms of roles (cost and conflicts), and assuming worktrees solve conflicts (they move them to merge time).

Already common, not worth rebuilding first: session dashboards, worktree per task, usage viewers such as [ccusage](https://github.com/ccusage/ccusage).

Gaps dwa aims at: a question and decision queue between agents and the user with answers routed back, hook-based state that survives CLI updates, and later deterministic workflows on top of interactive sessions.

Risk: Anthropic keeps shipping first-party versions of these features, so dwa stays a thin layer over the native ones.
