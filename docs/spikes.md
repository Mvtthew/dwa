# Spike results

Experiments run on 2026-11-24 with Claude Code 2.1.331, tmux 3.8, Bun 1.4.3 on macOS, using real interactive sessions in a private tmux server (`tmux -L dwa-spike`). Scripts are in `spikes/`; raw output goes to `spikes/out/` (not committed).

## Summary

| Spike | Question                                                                                          | Result                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| S1    | Does Claude Code run well in the private tmux server, and can an agent pane be opened under main? | Yes for everything that can be checked from a script. Real-keyboard checks still to do by hand.         |
| S2    | Can agent state come from hooks and the statusline alone?                                         | Yes.                                                                                                    |
| S3    | Can a message be delivered to a running session, including an idle one?                           | Yes, three ways. The raw inbox socket is not usable.                                                    |
| S4    | Can an `ask` tool call block with no timeout?                                                     | Yes for the 35 minutes tested, past both default limits. The longest possible wait is still unmeasured. |
| S5    | Can a session be cut off from the user-level Claude setup and given only chosen capabilities?     | Yes, with flags plus four keys in the generated settings. Built-in skills and plugins need a decision.  |
| S6    | Can what a running session may use be changed, live or by restarting it with its conversation?    | Live only through the PreToolUse hook. Everything else by a resume restart, with one extra flag.        |

## S1. tmux composition

Config: `spikes/tmux.conf` (`allow-passthrough on`, `focus-events on`, `extended-keys always`, `extended-keys-format csi-u`, `mouse on`, `escape-time 0`, `remain-on-exit on`).

- Layout built from a script: left column 30 wide, right column 34 wide, centre 134 wide in a 200x50 window. `join-pane -d -v -l 40%` puts an agent's pane under main (main 134x29, agent 134x20). `break-pane -d` sends it back to its own window and a second `join-pane` brings it back. Both sessions redrew correctly at the new size each time.
- `send-keys S-Enter` inserts a newline in the Claude Code prompt instead of submitting, so the tmux to Claude Code half of Shift+Enter works with these settings.
- `#{pane_current_command}` reports `2.1.331` for a Claude Code pane (its process title), so it cannot be used to recognise agent panes. Track pane ids in the daemon.
- Not yet checked, needs a person at a real terminal: Shift+Enter from the outer terminal, paste of multi-line text, mouse wheel scrolling, flicker during long output, and the smallest usable pane height.

## S2. State from hooks and statusline

Per-session settings passed with `--settings <file>` work for hooks and for `statusLine`; nothing was written to user or project settings.

Observed sequence for a prompt that needs a permission:

```
SessionStart
UserPromptSubmit            -> working
PreToolUse (Bash)
PermissionRequest (Bash)    -> needs user (fires at once)
Notification permission_prompt   (about 6 s later, so PermissionRequest is the better signal)
PostToolUse (Bash)          -> working
Stop                        -> idle, with last_assistant_message
```

- Statusline JSON delivered `context_window.used_percentage`, `cost.total_cost_usd` and `rate_limits.five_hour` / `seven_day` with `used_percentage` and `resets_at`. It is re-run every few seconds, so it doubles as a heartbeat.
- `claude agents --json` does list interactive sessions running in tmux, with `status` (`idle`, `waiting`) and `waitingFor: "permission prompt"`. Useful as a cross-check and for recovering state after a daemon restart. It must be run with the same `CLAUDE_CONFIG_DIR` as the sessions.
- `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` are present in the `SessionStart` hook environment.
- A fresh session costs about 3 to 5% of the context window before any work.

Problems found:

- **Inherited environment.** A tmux server started from inside a Claude Code session inherits its `CLAUDE*` variables. The daemon must start tmux and agents with a cleaned environment.
- **The command matters for login.** Plain `claude` and a wrapper that sets `CLAUDE_CONFIG_DIR` are different logins even when they point at the same directory. Plain `claude` was logged out here while `~/claude_me` was logged in. This is what profiles are for, and `dwa doctor` should check login, not only the version.
- **Dialogs before the session starts.** With a config that has not trusted the folder, the session stops at the trust prompt and no hook fires. A logged-out session accepts a prompt, fires `UserPromptSubmit`, and then never fires `Stop`. The daemon needs a start-up timeout that falls back to `claude agents --json` and shows "needs attention". Whether `StopFailure` fires in the logged-out case is not yet checked.

## S3. Delivering a message

| Mechanism                                 | Idle session                              | How it appears to the agent                                                    | Verdict                                                                                                                                         |
| ----------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `asyncRewake` hook used as a mailbox      | Woke and answered within about 2 s        | A turn starting with "Stop hook feedback" and the message in a system reminder | **Primary.** Works for daemon-to-agent messages.                                                                                                |
| Native `SendMessage` between sessions     | Woke and answered                         | `Message from @dwa-spike-b: ...` and a `<cross-session-message>` block         | Works with no permission prompt. Visible to hooks on both sides (`PreToolUse SendMessage` for the sender, `UserPromptSubmit` for the receiver). |
| `load-buffer` + `paste-buffer -p` + Enter | Submitted a two-line message intact       | Ordinary user input                                                            | **Fallback.** Only when hooks say the session is idle.                                                                                          |
| Writing to the inbox socket from outside  | Nothing delivered, no reply on the socket | n/a                                                                            | **Dropped.** The payload format is undocumented; guessing it is not a base to build on.                                                         |

How the mailbox works (`spikes/wait-mail.ts`): a `command` hook with `asyncRewake: true` and a long `timeout` is registered on `SessionStart` and `Stop`. It waits for a message, prints it to stderr and exits with code 2, which wakes the session. The `Stop` after that turn starts the next waiter. A pid file keeps it to one waiter per agent. Two messages in a row were delivered this way.

Later checks with the real implementation (M3): a message woke an idle agent, which replied to the user; `dwa ask` got an answer back from an agent; an agent's blocking `ask` to the user was answered from the CLI and the agent then messaged a second agent, which woke and read it. Not yet tested: a message arriving while the agent is in the middle of a long tool call.

Open points noted at spike time: the waiter should block on the daemon socket instead of polling files; the text is framed as a "Stop hook blocking error", so each message needs a clear header saying who sent it; delivery to a busy session waits for the end of the turn, which is acceptable but should be shown as "queued" in the dashboard.

## S4. Blocking `ask` with no timeout

Documented limits ([mcp](https://code.claude.com/docs/en/mcp.md), [env vars](https://code.claude.com/docs/en/env-vars.md)):

- `MCP_TOOL_TIMEOUT`: wall-clock limit per call, default 100000000 ms (about 28 hours). Maximum not documented.
- `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`: aborts a call with no response and no progress notification; default 30 minutes for stdio servers; `0` disables it.
- `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`: after 2 minutes a running call is moved to a background task; `0` disables it.

Test (`spikes/ask-mcp.ts`): session started with `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`, `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0`, `MCP_TOOL_TIMEOUT=2000000000`, and an `ask` tool that sends no progress notifications. The answer is supplied after 35 minutes, past both default limits.

Result: the call stayed open for 2,114 seconds (35 minutes) with no abort and no move to the background. `PreToolUse mcp__dwa__ask` fired at 18:08:09, `PostToolUse` at 18:43:23, and the session then answered "blue" and stopped normally. During the wait the session showed as working ("Calling dwa"), and the `PreToolUse` event is enough for the daemon to mark the agent as waiting on a question.

Not measured: waits of many hours, and whether `MCP_TOOL_TIMEOUT=2000000000` is honoured or silently capped.

Design consequence either way: there is still a wall-clock limit somewhere (28 hours by default, about 23 days with the value above if it is honoured). So the question lives in the daemon, not in the tool call. If a call ever ends before the answer, the tool returns "still waiting", the agent calls `wait_for(question_id)` again, and the answer is also sent through the mailbox.

## S5. Isolation and capabilities

Run on 2026-11-24 and 25 with Claude Code 2.1.331, real interactive sessions (`~/claude_me`, Haiku) in a private tmux server (`tmux -L dwa-spike5`). Scripts are in `spikes/s5/`: `setup.sh` builds a scratch project (its own `CLAUDE.md`, `.claude/settings.json`, two project skills, a `.mcp.json` server) and the per-variant files, `variants.sh` lists every variant that was run, `probe.sh` and `cap.sh` save the screens of `/context all`, `/mcp`, `/skills`, `/hooks`, `/permissions`, `/plugin` and `/status`. Every result is a difference against a baseline session with no extra flags. A model turn was used only where the screens could not tell (which tools exist, which instructions were loaded).

The user-level setup tested against: a status line command, seven hooks, four personal agents, seven personal skills and commands, ten skills synced from claude.ai, three claude.ai connectors, a personal `CLAUDE.md`, auto-memory, and `enabledPlugins` (one installed plugin, built-in plugins switched off).

### What each mechanism does

| Mechanism                                                      | Effect seen                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--setting-sources project,local`                              | Still logged in on the subscription. Gone: user hooks, user status line, personal agents, personal skills and commands, skills synced from claude.ai, the user's installed plugin. Kept: project settings, project skills, project `CLAUDE.md`. **Not** gone: the personal `CLAUDE.md`, auto-memory, claude.ai connectors. |
| `--setting-sources project`                                    | As above, but approvals stored in `.claude/settings.local.json` are ignored, so the project MCP server dialog comes back at every start.                                                                                                                                                                                   |
| `--setting-sources ""`                                         | Accepted. Also drops project settings and project skills. Not what dwa wants.                                                                                                                                                                                                                                              |
| `claudeMdExcludes: ["<config dir>/CLAUDE.md"]` in `--settings` | The personal `CLAUDE.md` is no longer loaded; project `CLAUDE.md` files stay.                                                                                                                                                                                                                                              |
| `autoMemoryEnabled: false` in `--settings`                     | The auto-memory `MEMORY.md` is no longer loaded.                                                                                                                                                                                                                                                                           |
| `--mcp-config <file>` alone                                    | Adds the server next to the project servers and the claude.ai connectors.                                                                                                                                                                                                                                                  |
| `--strict-mcp-config --mcp-config <file>`                      | Only the servers in the file. claude.ai connectors are gone, and so are the project `.mcp.json` servers and the MCP servers of plugins. No approval dialog for project servers, also in a project that never approved them.                                                                                                |
| `--tools "Read,Grep,Glob"`                                     | The session has exactly those built-in tools plus the MCP tools (`mcp__dwa__ping` was listed and callable).                                                                                                                                                                                                                |
| `--disallowedTools "Edit,Write"`                               | Those two are gone; everything else stays, MCP tools included.                                                                                                                                                                                                                                                             |
| `permissions` in `--settings`                                  | `allow: ["mcp__dwa"]` suppresses the prompt in `manual` mode (without it the prompt appears). `deny` rules and `defaultMode` apply.                                                                                                                                                                                        |
| `--permission-mode <mode>`                                     | `manual`, `acceptEdits`, `auto`, `dontAsk` and `plan` start directly. `bypassPermissions` stops at a confirmation dialog whose default is "No, exit".                                                                                                                                                                      |
| `--plugin-dir <dir>` (repeatable)                              | Loads with user settings skipped. Skills appear as `<plugin>:<skill>` and are "locked by plugin". The plugin's own MCP server loads only without `--strict-mcp-config`.                                                                                                                                                    |
| A generated plugin directory                                   | A folder with `.claude-plugin/plugin.json` and `skills/<name>` as a symlink to a skill folder elsewhere delivers that skill to one session (`dwa:dwaskill`).                                                                                                                                                               |
| `Skill(<name>)` deny rule                                      | The skill cannot be run ("blocked by permission rules") but is still listed to the model and still costs context.                                                                                                                                                                                                          |
| `skillOverrides: {"<name>": "off"}` in `--settings`            | The skill is gone from the session and from the context ("locked by flag"). Works for project skills and for built-in skills. Other values: `name-only`, `user-invocable-only`.                                                                                                                                            |
| `--agents '<json>' --agent <name>`                             | Works interactively with the JSON as one argument (8 KB tested). The role text, `--append-system-prompt` and the project `CLAUDE.md` were all in effect together. A file path in place of the JSON is refused outside `--print`.                                                                                           |
| `--append-system-prompt-file <file>`                           | Works interactively.                                                                                                                                                                                                                                                                                                       |
| `statusLine` command that prints nothing                       | No status row at all. The user's own status line is already gone once user settings are skipped.                                                                                                                                                                                                                           |

### Problems found

- **Built-in plugins and skills come back.** With user settings skipped, the user's `enabledPlugins` no longer applies, so built-in plugins the user had switched off are on again (one of them brought its own MCP server and tool), and about 20 built-in skills (3.2k tokens) are always present. `enabledPlugins: {"<id>": false}` and `skillOverrides` in `--settings` switch them off one by one, but the ids are Claude Code's and can change between versions. `--disable-slash-commands` removes all skills at once, the wanted ones too.
- **Project MCP servers need merging.** `--strict-mcp-config` is the only thing that removes the claude.ai connectors, and it removes the project's `.mcp.json` servers as well. To keep "project files stay loaded", the generated MCP file must include them.
- **Plugin MCP servers** do not load under `--strict-mcp-config` either. A plugin that needs its server must have it copied into the generated MCP file.
- **An allow list hides `Skill`.** With `--tools`, a role that lists skills also needs `Skill` in the list.
- **tmux command length.** One tmux command carries between 16 and 20 KB. A larger role prompt cannot be passed as an argument through tmux directly. Starting the pane with `sh -c 'exec <command> ... --agents "$(cat <file>)"'` worked with 100 KB and still runs the unmodified command.
- **The status line is not a heartbeat when idle.** An idle session did not re-run the command (one call in 30 s across eight sessions, and that was a session starting). With `"refreshInterval": 5` in the `statusLine` entry it ran every 5 s. This corrects the S2 note that it is re-run every few seconds.
- **Start-up dialogs.** A new folder stops at the trust prompt and then, without `--strict-mcp-config`, at a second dialog per unapproved project MCP server; both default to the negative answer. A notice about auto mode being the default is shown once more when user settings are skipped; it does not block.
- **Temp directories behave differently.** In a project under `/private/tmp` no project `CLAUDE.md` was loaded even in the baseline, and the personal one disappeared with `--setting-sources project,local`. In a normal directory both loaded. Do not test memory loading in a temp directory.
- **Parent directories.** A project `CLAUDE.md` above the project's git root was still loaded (the scratch repository sat inside this repository).

### Recommended launch for an isolated session

```
<profile command> --setting-sources project,local
  --settings <generated.json> --strict-mcp-config --mcp-config <generated.json>
  [--tools <list> | --disallowedTools <list>] [--permission-mode <mode>]
  [--plugin-dir <catalogue plugin>]... [--plugin-dir <generated skills plugin>]
  [--agents '<json>' --agent <role>] --append-system-prompt-file <file>
```

Generated settings: hooks, `statusLine` (silent command, with `refreshInterval` if a heartbeat is wanted), `permissions` (`allow` with `mcp__dwa`, the role's `allow` and `deny`), `claudeMdExcludes` with the personal `CLAUDE.md` of the profile's config directory, `skillOverrides` set to `off` for project skills the role does not list. Hooks from the generated settings fired with user settings skipped (`SessionStart`, `UserPromptSubmit`). Generated MCP file: `dwa`, the role's catalogue servers, and the servers from the project's `.mcp.json`.

Not tested: `asyncRewake` hooks under these flags (the mailbox), `--plugin-url`, HTTP MCP servers in the generated file, whether the role text passed with `--agents` replaces or extends the default system prompt (the session still opened with the Claude Code identity line and the token count did not settle it), user permission rules (the test profile has none), and managed (policy) settings.

## S6. Changing a running session

Run on 2026-11-25 with Claude Code 2.1.332, real interactive sessions (`~/claude_me`, Haiku unless noted) in a private tmux server (`tmux -L dwa-spike6`), in the S5 scratch project with the S5 isolation flags and `--permission-mode manual`. Scripts are in `spikes/s6/`: `run.sh` starts a session in a window, `say.sh` types a line and prints the screen, `settings.ts` writes a session settings file whose hooks call `hook-log.ts` (it records every hook call in `spikes/out/s6/hooks.jsonl`), `list-tools.ts` and `http-mcp.ts` are for the MCP part. What a session can do was checked by making it call the tool, not by asking: after a restart a model repeats the tool list it remembers from the conversation.

### What was tried

| Question                                                 | What was done                                                                                                                                                                                                  | Result                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is the `--settings` file re-read while the session runs? | Added to the file of a running session, one after another: an allow rule (`Bash(touch *)`), deny rules (`Read(./file.txt)`, `Edit`, `mcp__extra__ping`), a `UserPromptSubmit` hook, `skillOverrides`.          | No. None of them took effect in later turns: the command still asked, the file was read, the MCP tool still asked, the hook never ran, the skill stayed listed.                                                                                                                  |
| Can anything change live?                                | The `PreToolUse` hook command already in the settings read a file on every call and answered with `hookSpecificOutput.permissionDecision`.                                                                     | Yes. `deny` refused the call (built-in and MCP tools alike) and the model was given the reason text. `allow` ran a command that otherwise asks in manual mode. The file was changed while the session ran and applied to the next call. The tool stays in the model's tool list. |
| Bare names in `permissions.deny`, at launch              | `["Edit", "Bash", "mcp__extra__ping"]` in one session, `["mcp__extra"]` in another.                                                                                                                            | The tools are removed from the session, the same as `--disallowedTools`: not listed, and "No such tool" on a call. A server name removes all of its tools, `mcp__<server>__<tool>` removes one.                                                                                  |
| Restart with `--resume <session-id>`                     | Left the session with `/exit`, then started the command again with `--resume`, a different `--tools`, a different `--settings` file, a different `--mcp-config` and a different `--append-system-prompt-file`. | The conversation continued (a word given before was recalled). Tools, settings (hooks, deny rules) and MCP servers of the new launch applied. The new appended prompt did not.                                                                                                   |
| Appended prompt on resume                                | Resumed with a new prompt file, with inline `--append-system-prompt`, with `--fork-session`, and with `--system-prompt-snapshot off`.                                                                          | The system prompt is recorded on the first request and reused on every resume, whatever the new launch passes (`--help` says so under `--system-prompt-snapshot`). Only `--system-prompt-snapshot off` on the resuming launch made the new prompt apply.                         |
| Session id                                               | Hook records of the resumed session.                                                                                                                                                                           | Same `session_id` and the same transcript file; `SessionStart` reports `source: "resume"`. `--session-id` together with `--resume` exits with status 1 unless `--fork-session` is added, which gives the new id and `source: "fork"`.                                            |
| Stopping the old process                                 | `/exit`, and killing the tmux window (idle, with a background shell running, and in the middle of a response).                                                                                                 | Both fire `SessionEnd` and leave a transcript that resumes. After a kill in the middle of a turn the resumed session knows the turn was cut off and waits for input; it does not continue by itself. A background shell is reported as not finished.                             |
| Under isolation                                          | All of the above ran with `--setting-sources project,local` and `autoMemoryEnabled: false`.                                                                                                                    | No difference.                                                                                                                                                                                                                                                                   |

### Built-in tools

Asked of a session with no tool restrictions (Fable 5.2 and Haiku 5.5 gave the same list, except that only Fable has `EndConversation`).

- Loaded at start: `Agent`, `Artifact`, `AskUserQuestion`, `Bash`, `Edit`, `ListAgents`, `Read`, `ReportFindings`, `ScheduleWakeup`, `Skill`, `ToolSearch`, `Workflow`, `Write`
- Deferred (loaded through `ToolSearch`): `ArtifactComments`, `ArtifactData`, `CronCreate`, `CronDelete`, `CronList`, `DesignSync`, `EndConversation`, `EnterPlanMode`, `EnterWorktree`, `ExitPlanMode`, `ExitWorktree`, `McpTaskCheck`, `Monitor`, `NotebookEdit`, `PushNotification`, `RemoteTrigger`, `SendMessage`, `SendToProject`, `SendToProjectContext`, `TaskStop`, `WebSearch`
- Only when named in `--tools`: `Glob`, `Grep`, `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`. `Glob` and `Grep` also appear by themselves when `Bash` is denied.
- Names that gave nothing in `--tools`: `WebFetch`, `TodoWrite`, `LS`, `MultiEdit`, `BashOutput`, `KillShell`, `TaskOutput`, `LSP`. `Task` gives `Agent`. An unknown name is ignored without an error.
- With `--tools` nothing is deferred and there is no `ToolSearch` unless it is named. Denying `Bash` also removes `Monitor`.
- The built-in `easel` plugin adds `mcp__easel__chart` in every session.

### Listing an MCP server's tools from dwa

`spikes/s6/list-tools.ts` uses the client of the MCP SDK already in `package.json` (1.32.2): `new Client(...)`, `client.connect(transport, { timeout })`, `client.listTools(undefined, { timeout })`, `client.close()`, with `StdioClientTransport` (`command`, `args`, `env`, `stderr: "ignore"`), `StreamableHTTPClientTransport` or `SSEClientTransport` (`requestInit.headers`).

| Case                                                         | Result                                                                | Time         |
| ------------------------------------------------------------ | --------------------------------------------------------------------- | ------------ |
| stdio server (`spikes/s5/echo-mcp.ts`)                       | tools listed                                                          | 62 ms        |
| HTTP server with a required header (`spikes/s6/http-mcp.ts`) | tools listed                                                          | 25 ms        |
| command not installed                                        | error `Executable not found in $PATH`                                 | 5 ms         |
| process that never answers                                   | `Request timed out` at the given timeout; `close()` ended the process | 2 s (as set) |
| process that exits at once                                   | `Connection closed`                                                   | 0.3 s        |
| HTTP without the header, or nothing listening                | error with the server's answer, or `ECONNREFUSED`                     | 4 ms         |

### What this means for dwa

- **Live, without a restart:** only decisions made by the `PreToolUse` hook. dwa already runs that hook in every session, so blocking a tool (built-in, MCP server or single MCP tool) or letting a call through can apply from the next tool call if the hook asks the daemon. The tool stays visible to the model and costs context; it is refused on use with the reason dwa gives.
- **Needs a restart:** removing a tool from the session or adding one (`--tools`, `--disallowedTools`, deny rules), permission rules in the settings file, the permission mode, MCP servers, plugins, skills, hooks, and the role prompt.
- **Restart command:** the normal launch with `--resume <session-id>` in place of `--session-id <id>` and, so that a changed role prompt applies, `--system-prompt-snapshot off`:

  ```
  <profile command> --setting-sources project,local [--tools <list> | --disallowedTools <list>]
    --resume <session-id> --system-prompt-snapshot off --name <name>
    --settings <generated.json> --strict-mcp-config --mcp-config <generated.json>
    --append-system-prompt-file <file> [--permission-mode <mode>] [--plugin-dir <dir>]...
  ```

  The session id, and with it the agent's row and its hook records, stays the same. Never add `--session-id` to it.
- **Stopping the old process:** killing the pane is enough, also in the middle of a turn.
- **After a restart the session must be told what changed.** It waits for input and still believes it has the tools it had before, so dwa should send it a message such as "You were restarted; you no longer have Write" and, after a turn that was cut off, ask it to carry on.
- **Tool list for dwa:** the three groups above. `Glob`, `Grep` and the `Task*` tools exist only for an allow list, so the dialog should offer them only for roles that use `tools`.

Not tested: whether a hook `allow` wins over a deny rule in the settings (expected not to); a hook decision of `ask`; what later resumes do after one launch with `--system-prompt-snapshot off` when the flag is left out again; the prompt after the conversation was compacted; `--continue`; resume with `--plugin-dir` changes or changed skills; resume across a Claude Code update; a restart of a session that is waiting at a permission prompt or inside a blocking dwa `ask`; listing the tools of an HTTP server that needs OAuth.
