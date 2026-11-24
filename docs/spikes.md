# Spike results

Experiments run on 2026-11-24 with Claude Code 2.1.331, tmux 3.8, Bun 1.4.3 on macOS, using real interactive sessions in a private tmux server (`tmux -L dwa-spike`). Scripts are in `spikes/`; raw output goes to `spikes/out/` (not committed).

## Summary

| Spike | Question                                                                                          | Result                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| S1    | Does Claude Code run well in the private tmux server, and can an agent pane be opened under main? | Yes for everything that can be checked from a script. Real-keyboard checks still to do by hand.         |
| S2    | Can agent state come from hooks and the statusline alone?                                         | Yes.                                                                                                    |
| S3    | Can a message be delivered to a running session, including an idle one?                           | Yes, three ways. The raw inbox socket is not usable.                                                    |
| S4    | Can an `ask` tool call block with no timeout?                                                     | Yes for the 35 minutes tested, past both default limits. The longest possible wait is still unmeasured. |

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

Open points for the real implementation: the waiter should block on the daemon socket instead of polling files; the text is framed as a "Stop hook blocking error", so each message needs a clear header saying who sent it; delivery to a busy session waits for the end of the turn, which is acceptable but should be shown as "queued" in the dashboard.

## S4. Blocking `ask` with no timeout

Documented limits ([mcp](https://code.claude.com/docs/en/mcp.md), [env vars](https://code.claude.com/docs/en/env-vars.md)):

- `MCP_TOOL_TIMEOUT`: wall-clock limit per call, default 100000000 ms (about 28 hours). Maximum not documented.
- `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`: aborts a call with no response and no progress notification; default 30 minutes for stdio servers; `0` disables it.
- `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`: after 2 minutes a running call is moved to a background task; `0` disables it.

Test (`spikes/ask-mcp.ts`): session started with `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0`, `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0`, `MCP_TOOL_TIMEOUT=2000000000`, and an `ask` tool that sends no progress notifications. The answer is supplied after 35 minutes, past both default limits.

Result: the call stayed open for 2,114 seconds (35 minutes) with no abort and no move to the background. `PreToolUse mcp__dwa__ask` fired at 18:08:09, `PostToolUse` at 18:43:23, and the session then answered "blue" and stopped normally. During the wait the session showed as working ("Calling dwa"), and the `PreToolUse` event is enough for the daemon to mark the agent as waiting on a question.

Not measured: waits of many hours, and whether `MCP_TOOL_TIMEOUT=2000000000` is honoured or silently capped.

Design consequence either way: there is still a wall-clock limit somewhere (28 hours by default, about 23 days with the value above if it is honoured). So the question lives in the daemon, not in the tool call. If a call ever ends before the answer, the tool returns "still waiting", the agent calls `wait_for(question_id)` again, and the answer is also sent through the mailbox.
