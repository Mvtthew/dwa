# dwa

A terminal workspace for running several Claude Code sessions side by side and letting them work together.

> Status: early development. The workspace, live agent state, messaging between agents and you, and workflows all work. Shared memory is planned. See [docs/architecture.md](docs/architecture.md) for the plan and [docs/research.md](docs/research.md) for the survey behind it.

## What it does and will do

- Run a main Claude Code session that is always visible, plus any number of agent sessions, all inside tmux.
- Show the active agents in a side pane with their state: working, idle, waiting for you, waiting for another agent.
- Open any agent's real session under the main one, so you can type to it directly.
- Let agents message each other and you, report progress, and ask questions that block until someone answers. A question never times out.
- Run workflows: a fixed graph of steps, each done by its own agent, with results handed from step to step.
- Keep everything running when you close the terminal, and restore it when you attach again.

dwa starts the unmodified `claude` program with your own login. It does not use the Agent SDK or headless mode to drive agents, and it does not write to your `~/.claude` settings or your own tmux configuration.

## Layout

```
┌───────────────┬──────────────────────────────────┬───────────────┐
│ STATUS        │ main session (always visible)    │ AGENTS 3      │
│ context 60%   │                                  │ 1 explore   ● │
│ limits 5h 22% │                                  │ 2 developer ● │
│               ├──────────────────────────────────┤ 3 reviewer  ? │
│ QUESTIONS 1   │ selected agent's session         │               │
│ reviewer asks │ (opens when you pick an agent)   │               │
└───────────────┴──────────────────────────────────┴───────────────┘
```

## Requirements

- [Bun](https://bun.com) 1.3.14 or newer
- tmux 3.7 or newer
- Claude Code 2.1.224 or newer

Check your machine:

```sh
bun install
bun run dwa doctor
```

To get a global `dwa` command that runs this checkout:

```sh
bun link
```

The examples below use `bun run dwa`; with the link in place, plain `dwa` does the same from any project directory.

## Usage

```sh
bun run dwa init --roles            # once per project: config template, example roles and a workflow
bun run dwa up                      # start the workspace for this project and attach
bun run dwa agent spawn explore     # start an agent (optionally --role, --profile, --task)
bun run dwa agent open explore      # show it under the main session
bun run dwa agent close             # hide it again, it keeps running
bun run dwa agent stop explore      # end its session
bun run dwa down                    # stop everything
```

Closing the terminal leaves everything running; `dwa attach` brings it back.

### Talking to agents

Every session gets a set of dwa tools: `list_agents`, `send_message`, `ask`, `answer`, `report_progress`, `wait_for`, `spawn_agent` and `stop_agent`. So you can tell the main session "start a reviewer and ask it to check my last commit" and it will. An agent that needs a decision calls `ask`, which blocks until it is answered, with no time limit. Questions for you show up in the status pane.

From a shell, without any model call:

```sh
bun run dwa agent send dev "the API changed, re-read docs/api.md"
bun run dwa ask reviewer "is the migration safe to run?"   # waits and prints the answer
bun run dwa answer                  # walk through open questions (also Ctrl+Q then q)
bun run dwa answer 3 "use postgres" # answer question 3 directly
bun run dwa inbox                   # messages agents sent to you
```

A message reaches an agent even when it is idle: it wakes up and reads it. You can also answer on behalf of an agent that was asked something.

### Workflows

A workflow is a TOML file in `.dwa/workflows/`. Each step is a prompt for its own agent and starts when the steps it depends on are done:

```toml
# .dwa/workflows/feature.toml
description = "Explore the code, implement the change, review it"

[steps.explore]
role = "explore"
prompt = "Find out what is needed for: {{input}}"

[steps.build]
role = "developer"
depends_on = ["explore"]
prompt = "Implement: {{input}}\nFindings:\n{{steps.explore.result}}"

[steps.review]
role = "reviewer"
depends_on = ["build"]
reviews = "build"                   # may send "build" back for another pass
prompt = "Review the change. The developer reports:\n{{steps.build.result}}"
```

```sh
bun run dwa workflow list
bun run dwa workflow run feature "add a --json flag to agent list"
bun run dwa workflow status         # steps and results of the latest run
bun run dwa workflow cancel 1
bun run dwa workflow complete 1 explore "The flag belongs in src/cli/index.ts"   # close a stuck step yourself
bun run dwa workflow fail 1 build "wrong approach"
bun run dwa workflow edit 1         # change the run in progress, in $EDITOR
```

- Steps without a dependency between them run at the same time.
- `{{input}}` is the text given to the run, and `{{steps.<name>.result}}` is what an earlier step handed over. A step may also set `profile`, `model` and `effort`, and `keep_agent = true` to leave its session open afterwards.
- A step ends only when its agent calls `complete_step` or `fail_step`. If the agent just stops, it is reminded twice, then the status pane marks the step as needing you. Nothing times out; open the agent and sort it out, or close the step yourself with `workflow complete` or `workflow fail`.
- A step with `reviews = "<step>"` is a review: its agent approves with `complete_step` or sends the work back with `request_changes` and its feedback. The reviewed step, any steps between the two, and the review then run again. The agent that did the work keeps its session until the review approves, so it gets the feedback as a message and still knows what it did; each review pass is a new agent.
- After `max_rounds` review passes (3 unless the step sets it) the run waits and you get a question: `another pass`, `accept` or `fail`. A step that uses a reviewed step's result must come before or after the review, not beside it.
- If a step fails, steps already running finish, the rest are skipped and the run fails.
- The run's outcome arrives as a message to whoever started it. Agents can start runs too, with `run_workflow`.
- Runs are stored, so they continue after a daemon restart. A run uses the file as it was when it started.
- `workflow edit <run>` opens the run's own copy of the definition in `$EDITOR` and applies it when you close the editor; the workflow file is not touched. Steps that have not started can be changed, added or removed freely. Changing a step that has started makes it run again, together with every started step after it, and agents working on those are stopped; you see the list and confirm first. `keep_agent` and `max_rounds` never cause a restart. `workflow edit <run> <file>` applies a file instead (add `--yes` to skip the confirmation), and agents can do the same with `edit_workflow`; you get a message saying what they changed.

### Keys

Press `Ctrl+Q`, release, then:

| Key      | Action                                                 |
| -------- | ------------------------------------------------------ |
| `1`–`9`  | Open the agent at that position under the main session |
| `x`      | Close the agent pane (the agent keeps running)         |
| `s`      | Show or hide a plain shell under the main session      |
| `w`      | Workflows: start a run, steer or edit a running one    |
| `a`      | Start an agent: name, role, model, effort, first task  |
| `t`      | Agent tools: what a session can use; block or allow    |
| `r`      | Role settings: edit, create and delete roles, history  |
| `0`      | Focus the main session                                 |
| `q`      | Answer open questions in a popup                       |
| `p`      | Menu: sessions, agents, workflows, shell, stop         |
| `z`      | Zoom the focused pane, and again to restore            |
| `d`      | Detach (everything keeps running)                      |
| `Ctrl+Q` | Send a real Ctrl+Q to the program in the pane          |

Clicking a pane focuses it and dragging a border resizes it. In the agents pane, click an agent to show it under the main session and click it again to hide it; `j`/`k` or the arrow keys and `Enter` do the same, and `t` opens the tools of the selected agent. Under the list the pane shows what the selected agent can use. A `↻` after a name means the session is not as its role says any more: the role changed since it started, or it is about to restart.

The status pane on the left ends with buttons: **Workflows**, **New agent**, **Agent tools**, **Role settings** and **Shell**, then the shortcuts from the table above (close pane, focus main, answer, menu, zoom main, detach), and the dwa version on the last line. Click one, or press its key alone while that pane has the focus. In a short terminal the shortcut buttons are left out so that questions and agents that need you stay visible. The first two, and the menu, open a form in a popup where every row can be clicked: start a workflow, complete or fail a step by hand, decide a review that is waiting for you, edit a run in `$EDITOR`, cancel it; or start an agent with a role, model and effort. The shell is your own `$SHELL` in the project directory. It takes the same place as an open agent, so showing one hides the other, and it keeps running while hidden until you exit it.

The prefix can be changed in the config:

```toml
[keys]
prefix = "C-a"   # tmux key notation
```

The same actions are also on `Alt+1`…`9`, `Alt+x`, `Alt+0`, `Alt+z` and the other keys, but only where the terminal sends Option as Meta. On macOS layouts where Option types characters (Polish, German and others) use the prefix.

## Project configuration

`dwa init` writes a commented `.dwa/config.toml`. Besides profiles and the key prefix it can list agents that start with the workspace and set pane sizes:

```toml
[[agents]]
name = "reviewer"
role = "reviewer"        # .dwa/roles/reviewer.toml
profile = "work"         # optional
task = "Wait for review requests."

[layout]
status_width = 30        # columns
agents_width = 34        # columns
agent_height = 40        # percent of the centre column
```

`dwa init` never overwrites a file; in a git repository it also adds `.dwa/run/` to `.gitignore`.

## Roles and what a session can use

A dwa session does not load your own Claude Code setup. Your plugins, MCP servers and claude.ai connectors, personal skills, commands and agents, your settings (hooks, permission rules, status line) and your personal `CLAUDE.md` stay out, and so does Claude Code's per-project memory unless a role turns it on. The project's own Claude files are always loaded: `CLAUDE.md`, `.claude/settings.json`, `.claude/skills` and the servers in `.mcp.json`. Everything else a session gets is written down in the dwa configuration, so the setup is the same for everyone who clones the project.

A role is one file, `.dwa/roles/<role>.toml`: what the session may use, and its instructions.

```toml
# .dwa/roles/reviewer.toml
description = "Reviews a change and reports findings."
extends = "explore"                  # start from another role; values set here replace its values
model = "opus"
effort = "high"                      # low, medium, high, xhigh or max
permission_mode = "manual"           # manual, acceptEdits, auto, plan, dontAsk, bypassPermissions
deny_tools = ["Edit", "Write"]       # built-in tools to remove; or tools = [...] for the only ones
allow = ["Bash(git log *)"]          # permission rules allowed without asking
deny = ["Read(.env)"]                # permission rules that are refused
mcp = ["github"]                     # MCP servers from the catalogue
plugins = ["lint"]                   # plugins from the catalogue
skills = ["review", "house-style"]   # only these skills; without the key: every project skill
prompt = """
You review changes for correctness. You do not edit files.
"""
```

MCP servers and plugins are defined once, by name, in `config.toml`, and roles list the names:

```toml
[mcp.github]
command = "github-mcp"
args = ["serve"]
env = { GITHUB_TOKEN = "..." }

[mcp.docs]
type = "http"
url = "https://example.com/mcp"

[plugins.lint]
path = "tools/lint-plugin"           # a directory, relative to the project
```

- **Layers.** `[defaults]` in `config.toml` applies to every session. Then come the roles a role extends, the role itself, and last what is set for one agent: on an `[[agents]]` entry, on a workflow step, or with flags of `dwa agent spawn` (`--model`, `--tools`, `--deny-tools`, `--mcp`, `--skills` and so on). A later layer replaces the value of an earlier one, lists included.
- **The main session** is a role too: `main` when `.dwa/roles/main.toml` exists, or the one named by `role` in `[main]`. `model` and `effort` in `[main]` win over the role's and over the profile's.
- **Skills** are looked up by name in `.claude/skills`, then `.dwa/skills`, then `~/.config/dwa/skills`. A role with a `skills` list has only those; project skills it does not list are switched off for it. Skills from the dwa folders appear in the session as `dwa:<name>`. Skills that come with a plugin follow the plugin.
- **Personal layer.** `~/.config/dwa/config.toml` can add catalogue entries, and `~/.config/dwa/roles/` holds roles for every project. The project's entry or role of the same name wins.
- **Agents starting agents.** The `spawn_agent` tool lets a session pick a role and take things away from it for the new agent (tools, permission rules, MCP servers, plugins, skills). It cannot add anything. This guards against mistakes; it is not a security boundary, since a session that can run shell commands can run `dwa` itself.
- **Missing things.** A session is not started when its role names an MCP server whose command is not installed, a plugin directory that does not exist, or an unknown role, catalogue entry or skill. `dwa config check` (also part of `dwa doctor`) reports all of this ahead of time, and `dwa role show <role>` prints what a session of a role ends up with, command line included.
- **The project's MCP servers** from `.mcp.json` are in every session unless a role, an agent or `[defaults]` names them in `off_mcp = [...]`.
- **Built into Claude Code.** Its built-in plugins and skills are on in every session. Switch single ones off by id with `off_plugins = [...]` and `off_skills = [...]`; `/plugin` and `/skills` in a session list the ids. `memory = true` gives a role Claude Code's per-project memory.
- **Status line.** Sessions show none. Context, cost and limits are in the status pane.

`dwa init --roles` adds four roles to start from, a skill and an example workflow that uses them:

| Role        | Model          | Tools                        | Permissions                                                                          | Extra                                                 |
| ----------- | -------------- | ---------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `main`      | opus, high     | all                          | read-only git commands never ask; force push and hard reset are refused              | Claude Code's project memory on                       |
| `developer` | sonnet, high   | all                          | file edits accepted without asking, read-only git allowed, `git push` refused        |                                                       |
| `explore`   | sonnet, medium | only Read, Grep, Glob, Bash  | never asks: read-only shell commands run, anything that changes something is refused |                                                       |
| `reviewer`  | opus, high     | as `explore` (it extends it) | as `explore`                                                                         | only the `review-checklist` skill from `.dwa/skills/` |

They are meant to be edited, by hand or in the role settings. Role files replace the `.claude/agents/<role>.md` files used before: move the prompt and settings of such a file into `.dwa/roles/<role>.toml`.

### Changing what a running session can use

**Agent tools** (`Ctrl+Q` then `t`, `t` on an agent in the agents pane, "Tools…" in the menu, or `dwa agent tools <name>`) shows one session's built-in tools, MCP servers with their single tools, and permission rules, each with a switch. After switching, there are three ways to save:

| Button                                      | Reaches                                                           | Lasts            |
| ------------------------------------------- | ----------------------------------------------------------------- | ---------------- |
| Save for `<agent>` only                     | that session                                                      | until it stops   |
| Save for `<agent>` and next `<role>` agents | that session and every agent of the role started later            | until `dwa down` |
| Save globally…                              | a file you pick: the role, a role it starts from, or `[defaults]` | for good         |

- **Taking something away needs no restart.** The session keeps running and the call is refused from then on, with a note to the agent that it was switched off. This covers built-in tools, whole MCP servers and single MCP tools.
- **Everything else restarts the session**: adding a tool or server, a rule with a pattern such as `Bash(git push *)`, and any other setting. The session comes back in the same pane with its conversation and is told what it has now. An agent that is working is not interrupted unless you say so; the dialog offers "Restart when its turn ends" and "Restart now". The main session always asks first.
- **A save into a file changes no running session by itself.** The dialog lists the sessions that still have the old setup and you tick the ones to bring up to date. The others are marked `↻` in the agents pane; `dwa agent restart <name>` does it later.
- **A restart starts the session from its role as it is now**, so it also brings along other changes made to the role since the session started.

From the command line:

```sh
bun run dwa agent tools reviewer                              # what it can use
bun run dwa agent tools reviewer --block Bash                 # this session only
bun run dwa agent tools reviewer --block mcp__github --scope role
bun run dwa agent tools reviewer --unblock Edit --scope file --file explore
bun run dwa agent restart reviewer --when turn-end
```

`--block` and `--unblock` take a tool name, `mcp__<server>`, `mcp__<server>__<tool>`, or a rule with a pattern (kept as a deny rule).

### Role settings and history

**Role settings** (`Ctrl+Q` then `r`, "Roles…" in the menu, or `dwa wizard roles`) lists the roles and opens one as a form: description, what it starts from, model, effort, permission mode, tools, MCP servers, plugins, skills, rules and memory. Every list can be left to inherit or set for the role. The prompt opens in `$EDITOR`. Roles can be created, duplicated, renamed and deleted there; a rename follows the name through child roles, the config and the workflows, and a role that something still uses cannot be deleted.

Saving changes only the lines of the settings that changed; comments and the rest of the file stay as they are.

Every change to a role file or to `config.toml` is kept as a numbered version in `.dwa/history/` (personal roles: `~/.config/dwa/history/`): saves from the dialogs, and edits made by hand, which dwa notices the next time it reads the file. Switching to another version gives the file that content and moves a pointer; no version is ever removed, so you can go from v4 to v2 and back to v4. An edit made while on v2 becomes v5.

```sh
bun run dwa role history reviewer        # * marks the current version
bun run dwa role diff reviewer           # the current version against the one before
bun run dwa role diff reviewer v2 v4
bun run dwa role switch reviewer v2
bun run dwa role new tester --description "Runs the tests"
bun run dwa role copy reviewer critic
bun run dwa role rename critic judge
bun run dwa role delete judge
bun run dwa role edit-prompt reviewer
```

`.dwa/history/` is meant to be committed with the role files; `.dwa/run/` is not.

## Using a different Claude command

`claude` is only the default. Define profiles in `~/.config/dwa/config.toml` (personal) or `.dwa/config.toml` (project, overrides personal):

```toml
default_profile = "me"

[profiles.me]
command = "~/claude_me"

[profiles.work]
command = "~/claude_work"
# optional: args = ["--model", "sonnet"], env = { KEY = "value" }
```

The command must accept the normal Claude Code arguments, for example a wrapper script ending in `exec claude "$@"`. Pick a profile for the whole workspace with `dwa up --profile work`, or for one agent with `dwa agent spawn reviewer --profile work`. `DWA_CLAUDE_COMMAND` overrides the default without a config file. `dwa doctor` checks every profile.

To keep your personal `CLAUDE.md` out of sessions, dwa has to know the Claude config directory a profile uses. It takes `CLAUDE_CONFIG_DIR` from the profile's `env` or from a wrapper script that sets it, and `~/.claude` otherwise. If your wrapper sets it in a way dwa cannot read, name it: `config_dir = "~/.claude-work"` in the profile. Nothing is written there.

## Development

```sh
bun test            # unit tests
bun run typecheck   # tsc --noEmit
bun run lint        # biome
bun run check       # all three
```

## License

[MIT](LICENSE)

dwa is an independent project and is not affiliated with Anthropic.
