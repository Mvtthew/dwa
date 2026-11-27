# dwa

A terminal workspace for running several Claude Code sessions side by side and letting them work together.

> Status: early development. The workspace, live agent state, messaging between agents and you, and workflows all work. Shared memory is planned. See [docs/architecture.md](docs/architecture.md) for the plan and [docs/research.md](docs/research.md) for the survey behind it.

## What it does and will do

- Run a main Claude Code session that is always visible, plus any number of agent sessions, all inside tmux.
- Show the active agents in a side pane with their state: working, idle, waiting for you, waiting for another agent.
- Open any agent's real session beside the main one, so you can type to it directly. A wide terminal shows several at once.
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

A bar with the menus runs across the top, and the event feed is a fourth column on the right until you hide it. In a wide terminal the side columns grow a little, and agents are shown right of the main session instead of under it, two to a column, as many columns as fit:

```
┌────────┬─────────────────┬────────────┬────────────┬────────┬──────┐
│ STATUS │ main session    │ explore    │ reviewer   │ AGENTS │ FEED │
│        │                 ├────────────┼────────────┤        │      │
│        │                 │ developer  │ tester     │        │      │
│        ├─────────────────┴────────────┴────────────┤        │      │
│        │ shell (when shown)                        │        │      │
└────────┴───────────────────────────────────────────┴────────┴──────┘
```

With the default sizes that starts at about 240 columns with the feed hidden and 310 with it shown; a second column of agents fits from about 325 and 380. When every place is taken, opening one more agent sends the one opened longest ago back to the background, where it keeps running. A terminal that gets narrower keeps the agents opened last.

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
bun run dwa init --roles            # once per project: config template, example roles and workflows
bun run dwa                         # start the workspace for this project, or attach to it
bun run dwa up                      # the same, spelled out; takes --profile and --no-attach
bun run dwa help                    # every command (also: dwa ?)
bun run dwa agent spawn explore     # start an agent (optionally --role, --profile, --task)
bun run dwa agent open explore      # show it under the main session
bun run dwa agent close             # hide it again, it keeps running
bun run dwa agent stop explore      # end its session
bun run dwa down                    # stop everything
```

Closing the terminal leaves everything running; `dwa attach` brings it back.

### Talking to agents

Every session gets a set of dwa tools: `list_agents`, `list_roles`, `send_message`, `ask`, `answer`, `report_progress`, `wait_for`, `spawn_agent`, `stop_agent` and `finish_task`. So you can tell the main session "start a reviewer and ask it to check my last commit" and it will. An agent a session starts this way hands its result back with `finish_task` and then its session ends by itself, so nothing is left idle; the result reaches the session that started it, and your inbox gets a line saying the agent finished. A session started with `keep` stays for follow-ups until it is stopped. An agent that ends its turn without reporting is reminded twice, then the session that waits is told; it is never removed without its report. Agents you start yourself stay until you stop them. An agent that needs a decision calls `ask`, which blocks until it is answered, with no time limit. Questions for you show up in the status pane.

From a shell, without any model call:

```sh
bun run dwa agent send dev "the API changed, re-read docs/api.md"
bun run dwa ask reviewer "is the migration safe to run?"   # waits and prints the answer
bun run dwa answer                  # walk through open questions (also Ctrl+Q then q)
bun run dwa answer 3                # show question 3 and read the answer
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
bun run dwa workflow show feature   # the steps as a picture; a run number shows how far it is
bun run dwa workflow design feature # the designer; a run number opens that run
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

### The workflow designer

`Ctrl+Q` then `g`, "Design a workflow…" in the Workflows popup, or `dwa workflow design [name]` opens the designer: the steps as a picture on the left, and on the right a panel for whatever the cursor is on. Everything works with the keyboard and with the mouse.

```
 ╭───────────╮
 │ explore   │
 │ explore   │
 ╰─────┬─────╯
       │
 ╭─────▼─────╮
 │ build     │◀─×3─╮
 │ developer │     │
 ╰─────┬─────╯     │
       │           │
 ╭─────▼─────╮     │
 │ review    │     │
 │ reviewer  ├─────╯
 ╰───────────╯
```

- **The picture.** A box is a step with its role; a line down means "starts when the one above is done"; a line back up is a review with the passes it may ask for. `!` marks a step with something wrong, `∞` one that keeps its agent, `≡` one with settings of its own.
- **Changing it.** Arrows or a click choose a step. `a` adds one (name and role first; its prompt is written in the panel), `del` removes one and joins what depended on it to what it depended on, `m` picks one up and shows the places it can go (on a line: between those two steps; beside a step: at the same time as it; under a step: after it), `c` draws a line (down: a dependency; up to an earlier step: a review of it). With the mouse: drag a step onto one of the marked places, or onto another step to join them.
- **The panel.** Name, role, model, effort, what the step waits for, what it reviews, whether it keeps its agent, and the prompt, typed in place with buttons that put in `{{input}}` and the results of earlier steps, or opened in `$EDITOR`. "More settings…" has the same lists a role has (tools, MCP servers, plugins, skills, rules).
- **Nothing is lost.** Every change can be taken back (`u`, and `U` to do it again). Unsaved work is kept as a draft under `.dwa/run/` with its undo steps and offered again when you open the workflow, also after the popup was closed. While something is wrong the footer says what, and saving is refused.
- **Saving** shows what changes in the file first. Only the changed lines are written: comments and the rest of the file stay as they are. If the file was changed elsewhere meanwhile, you are shown what changed and choose whose text to go on from.
- **Starting a new one:** empty, from a template (`feature`, `bugfix`, `parallel-build`, `review-only`), as a copy, or "Describe it to an agent": a session of the `workflow-author` role reads the project, writes the workflow, saves it with the `save_workflow` tool and stays open, so you refine it by talking to it or on the picture.

A run opens in the same designer (Workflows popup, or `dwa workflow design <run>`). Every step shows its state (`○` waits, `●` running, `✓` done, `✖` failed, `◆` needs you), the pass it is on and its agent, and the picture follows the run. The panel has what can be done: complete or fail a running step by hand, decide a review that waits for you, read results, cancel the run. `e` unlocks the steps for editing. Saving then says what the change does to the run (which steps run again) and asks where it goes: this run, the workflow file, or both. The file keeps its comments.

Workflow files have versions like role files, and may be personal (`~/.config/dwa/workflows/`); the project's workflow wins when both have one of the same name.

```sh
bun run dwa workflow new deploy --from bugfix    # or without --from: a file with one step to start from
bun run dwa workflow new notes --personal
bun run dwa workflow duplicate feature feature-fast
bun run dwa workflow rename feature-fast quick
bun run dwa workflow move quick --to personal
bun run dwa workflow delete personal:quick       # its history is kept
bun run dwa workflow history feature             # * marks the current version
bun run dwa workflow diff feature v2 v4
bun run dwa workflow switch feature v2
```

### Keys

Press `Ctrl+Q`, release, then:

| Key      | Action                                                  |
| -------- | ------------------------------------------------------- |
| `1`–`9`  | Open the agent at that position beside the main session |
| `x`      | Hide the focused agent or shell (it keeps running)      |
| `s`      | Show or hide a plain shell in a row under the sessions  |
| `w`      | Workflows: start a run, steer or edit a running one     |
| `g`      | Workflow designer: workflows as a picture, history      |
| `a`      | Start an agent: name, role, model, effort, first task   |
| `t`      | Agent tools: what a session can use; block or allow     |
| `r`      | Role settings: edit, create and delete roles, history   |
| `l`      | Leader mode: whether the main session hands work over   |
| `0`      | Focus the main session                                  |
| `q`      | Answer open questions in a popup                        |
| `p`      | Menu: sessions, agents, workflows, shell, stop          |
| `z`      | Zoom the focused pane, and again to restore             |
| `d`      | Detach (everything keeps running)                       |
| `Ctrl+Q` | Send a real Ctrl+Q to the program in the pane           |

Popups are drawn on the black of your terminal's palette with its white for text, so they stand out from the panes behind them.

Clicking a pane focuses it and dragging a border resizes it, until the layout is next set: when a pane is shown or hidden or the terminal changes size. In the agents pane, click an agent to show it beside the main session and click it again to hide it; `j`/`k` or the arrow keys and `Enter` do the same, and `t` opens the tools of the selected agent. Under its title the pane says how many agents are doing what (`1 needs you · 2 working · 3 idle`, only the states some agent is in). At its bottom it lists the open questions and the messages to you: click a question to answer it, a message to read them all, or **Clear messages**; under those it shows what the selected agent can use. A `↻` after a name means the session is not as its role says any more: the role changed since it started, or it is about to restart.

The status pane on the left ends with the shortcuts from the table above as buttons in four sections, with one line under them that names the prefix: **Workflows** (workflows, workflow designer), **Agents** (new agent, agent tools, role settings, answer), **Panes** (shell, focus main, zoom main, close pane) and **Workspace** (menu, detach), and the dwa version on the last line. Click one, or press its key alone while that pane has the focus. In a short terminal the sections are left out from the last one up so that agents that need you stay visible. The list above the buttons can be clicked too: a workflow run or one of its steps opens that run on its picture. The first two, and the menu, open a form in a popup where every row can be clicked: start a workflow or open a run on its picture; or start an agent with a role, model and effort. The shell is your own `$SHELL` in the project directory. It has a row of its own under the main session and the shown agents, so it hides none of them, and it keeps running while hidden until you exit it.

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
status_width = 30        # columns, in a terminal of 200 columns or fewer
agents_width = 34        # columns, likewise
side_scale_max = 140     # how far the side columns grow in a wider terminal, in percent
agent_height = 40        # percent of the centre column, for the agent shown under main
main_min_width = 90      # agents are shown right of main once main keeps this many columns
agent_min_width = 70     # beside a column of agents this wide
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
- **Tools.** A session has a list of built-in tools and no others. Without a `tools = [...]` list in any layer it is a short default one: `Read`, `Edit`, `Write`, `Bash`, `Glob`, `Grep`, `Skill`, `AskUserQuestion` and `ExitPlanMode`. Anything else (`WebSearch`, `NotebookEdit`, `Monitor`, the task list tools and so on) is there only when a `tools` list names it, so a tool that a new version of Claude Code brings does not turn up by itself. `deny_tools = [...]` takes tools away from the list below it. `tools = ["*"]` is every tool Claude Code ships, limited only by `deny_tools`. The short list also saves context: a session without a list starts at about 28k tokens, with the default one at about 13k. The dwa tools and the tools of MCP servers are not part of this list, but they are sent in full with every request too; a role with a large MCP server should have `ToolSearch` in its `tools`, which makes the server's tools load on demand (34k tokens less for a server of 57 tools).
- **The main session** is a role too: `main` (your file, or the built-in one), or the one named by `role` in `[main]`. `model` and `effort` in `[main]` win over the role's and over the profile's.
- **Leader mode.** The main session leads: dwa tells it to keep the conversation with you, the plan, small things and the judging of results for itself, and to hand the rest to agents (finding things out in the code, writing a change, running checks, reviewing, web research, design). It gets the list of roles and of the project's workflows for that, asks you before a larger job, does not wait for its agents (you can keep talking to it; results arrive as messages) and tells you in a line or two what each one brought back. It keeps all its tools, and where "small enough to do myself" ends is its own judgement. `leader = false` in `[main]` turns this off and the session works alone, as an ordinary one. `Ctrl+Q` `l` (or the menu) switches it for you: the setting goes into your personal `config.toml`, and the main session is restarted with its conversation, after asking. A value in the project's `config.toml` wins and is changed there. While it leads, dwa reminds it (never refuses) when it does a lot itself in one turn: eight reads and searches, edits to three files, three web lookups, or a test, build or lint command; `check_commands = [...]` in `[main]` names the commands that count as checks when the usual ones do not fit. Only the main session leads; an agent it starts does its task itself and comes back with questions.
- **Built-in roles.** dwa carries a set of roles, so a project has them without any file: `dwa role list` shows them as "built in". A file of the same name in `.dwa/roles/` or `~/.config/dwa/roles/` takes a built-in role's place. To change one, copy it first: `dwa role adopt <role>` (add `--personal` for your own folder), or "Copy into the project" in the role settings; deleting the file brings the built-in role back. `dwa init --roles` copies all of them at once.
- **A role's profile.** `profile = "<name>"` in a role file makes its sessions run with that profile (see "Using a different Claude command"), for a role that needs its own command or arguments. A profile named when the agent is started wins. A role whose profile your config does not define is left out of the list of roles and named by `dwa config check`.
- **Skills** are looked up by name in `.claude/skills`, then `.dwa/skills`, then `~/.config/dwa/skills`. A role with a `skills` list has only those; project skills it does not list are switched off for it. Skills from the dwa folders appear in the session as `dwa:<name>`. Skills that come with a plugin follow the plugin.
- **Personal layer.** `~/.config/dwa/config.toml` can add catalogue entries, and `~/.config/dwa/roles/` holds roles for every project. The project's entry or role of the same name wins.
- **Who does what.** The main session is told which roles it can hand work to: in leader mode always, and otherwise when its role sets `role_list = true`. dwa adds the list after the role's prompt, one entry per role with its `when_to_use` text (several lines if you like: what to hand to the role and what not), or its `description` when it has none. Your own rules that span roles ("tests always go to the runner") go into the `main` role's prompt. A role with `in_role_list = false` is not offered. The list in the prompt is from the session's start; the `list_roles` tool gives the current one. Edit the text in the role settings or with `dwa role edit-when-to-use <role>`.
- **Agents starting agents.** The `spawn_agent` tool lets a session pick a role and take things away from it for the new agent (tools, permission rules, MCP servers, plugins, skills). It cannot add anything. This guards against mistakes; it is not a security boundary, since a session that can run shell commands can run `dwa` itself.
- **Missing things.** A session is not started when its role names an MCP server whose command is not installed, a plugin directory that does not exist, or an unknown role, catalogue entry or skill. `dwa config check` (also part of `dwa doctor`) reports all of this ahead of time, and `dwa role show <role>` prints what a session of a role ends up with, command line included.
- **The project's MCP servers** from `.mcp.json` are in every session unless a role, an agent or `[defaults]` names them in `off_mcp = [...]`.
- **Built into Claude Code.** Its built-in skills (`simplify`, `security-review`, `dataviz`, `loop` and the rest, 20 of them) are off in every session. `builtin_skills = ["simplify"]` keeps single ones; `/context` in a session started outside dwa lists the names. A session's hook also refuses any call of the Skill tool for a skill the session was not given, so a skill a later version of Claude Code adds cannot be used by an agent before dwa knows it; `/<skill>` typed by you is not checked. Built-in plugins are still on in every session; switch single ones off by id with `off_plugins = [...]` (`/plugin` lists the ids), and name any other skill to switch off in `off_skills = [...]`. `memory = true` gives a role Claude Code's per-project memory. Claude Code's own subagents (the `Agent` and `Workflow` tools, and the built-in `code-review` skill, which starts one by itself) are off in every session, the main one included, so work is handed over to dwa agents with `spawn_agent` where you can see it; `subagents = true` in `[defaults]` or a role turns them back on. A skill of yours that asks for a subagent (`context: fork` in its `SKILL.md`) runs as a dwa agent instead: the session is told about it and starts it with `spawn_agent` and `skill`, or you do with `dwa agent spawn --skill <name> --task "<what to work on>"`. The agent runs as the role the skill names with `agent:` when the workspace has a role of that name. `/<skill>` typed into a session does not run such a skill. The built-in `code-review` has no file to start from; use a reviewing role.
- **Status line.** Sessions show none. Context, cost and limits are in the status pane.

The built-in roles, which `dwa init --roles` also copies into the project together with a skill and four workflows that use them (`feature`, `bugfix`, `parallel-build`, `review-only`). Two of them write for you from a description: `workflow-author` writes workflows (see "The workflow designer") and `role-author` writes roles (see "Role settings and history"). The others:

| Role           | Model          | Tools                                              | Permissions                                                                                  | For                                                              |
| -------------- | -------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `main`         | opus, high     | the default ones and WebSearch                     | read-only git commands never ask; force push and hard reset are refused                      | the session you talk to; Claude Code's project memory on         |
| `explore`      | sonnet, medium | only Read, Grep, Glob, Bash                        | never asks: read-only shell commands run, anything that changes something is refused         | questions about the code                                         |
| `planner`      | opus, high     | as `explore` (it extends it)                       | as `explore`                                                                                 | the plan for a larger change                                     |
| `developer`    | sonnet, high   | the default ones and WebSearch                     | file edits accepted without asking, read-only git allowed, `git push` refused                | a change that is already scoped, with its tests                  |
| `quick`        | haiku, low     | Read, Edit, Write, Grep, Glob, Bash                | file edits accepted without asking; `git push` and `git commit` refused                      | small mechanical edits from an exact spec                        |
| `runner`       | haiku, low     | only Read, Grep, Glob, Bash                        | never asks: the usual test, build and lint commands run, anything else is refused            | test, build, lint and typecheck runs; reports the outcome        |
| `reviewer`     | opus, high     | as `explore` (it extends it)                       | as `explore`                                                                                 | a second look at a finished change; the `review-checklist` skill |
| `designer`     | opus, high     | as `explore` (it extends it)                       | as `explore`                                                                                 | a design spec for a UI, and a review of how a UI change looks    |
| `web-research` | sonnet, medium | WebSearch, WebFetch, Read, Grep, Glob              | never asks: searching and fetching are allowed, nothing else                                 | documentation and other answers that are on the web              |
| `web-chrome`   | opus, medium   | only Read, Grep, Glob, Bash, and the browser tools | never asks: read-only git runs; running scripts in a page and uploading files are taken away | looking at pages in your Chrome; needs a `chrome` profile        |
| `dwa-selfheal` | opus, medium   | only Read, Grep, Glob                              | never asks; it changes nothing and proposes fixes for you to decide on                       | started by dwa when a session reports a gap in its setup         |

`web-chrome` drives your own Chrome through Claude in Chrome. Its sessions need the Claude command started with `--chrome`, so the role names the profile `chrome`: define `[profiles.chrome]` with `args = ["--chrome"]` and the command of your usual profile, and have the extension installed and connected. Until then the role is not offered. The role allows the browser tools as a whole, so it never stops at a prompt; what it may not do there is in its `deny` list and its prompt: look before you rely on it for pages that are not local.

The `runner` role's list of allowed commands is a general one; add your project's own check commands to a copy of it. Your own rules for the main session ("tests always go to the runner", "ask me before more than three agents") go into the `main` role's `prompt`, which comes after dwa's own instructions for leading and has the last word.

They are meant to be edited, by hand or in the role settings. Role files replace the `.claude/agents/<role>.md` files used before: move the prompt and settings of such a file into `.dwa/roles/<role>.toml`.

### When a role does not fit

A session that finds its role does not fit its task, or that lacks a tool, a skill, an MCP server or a permission, reports it with its `report_gap` tool instead of working around it. dwa starts a session of the built-in `dwa-selfheal` role, one for each role that is reported on, which reads the role's files and what the session was refused and then does one of three things: it tells the reporter how to do it with what it has, it proposes a change, or, when dwa itself misbehaved, it writes a report into `.dwa/reports/` (ignored by git).

A proposed change waits for you: the top bar shows `✚` with a count, and prefix then `f` (or `dwa wizard fixes`) opens it. You see each change, with `▲` on the ones that give a session more than it had, and the role file as it would differ. Then you apply it to the role (the reporting sessions restart with their conversation when their turn ends; for the main session you choose when), give it to the reporting session alone without changing a file, or turn it down with a reason. Nothing is written before you decide, and what you turn down is remembered for that role and not proposed again.

```sh
dwa selfheal developer "developers should be able to run the linter"   # report it yourself, for a session or a role
dwa selfheal --list            # fixes that wait for you
dwa selfheal --memory          # what you turned down; --clear-memory [role] forgets it
```

A fix reaches role files and `[defaults]`. For the other parts of the config (`[mcp.X]`, `[plugins.X]`, `[profiles.X]`, `[[agents]]`) the selfheal session can only tell you what to change.

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

**Role settings** (`Ctrl+Q` then `r`, "Roles…" in the menu, or `dwa wizard roles`) lists the roles and opens one as a form: description, what it starts from, model, effort, permission mode, tools, MCP servers, plugins, skills, rules, memory and subagents. Every list can be left to inherit or set for the role. The prompt opens in `$EDITOR`. Roles can be created, duplicated, renamed and deleted there; a rename follows the name through child roles, the config and the workflows, and a role that something still uses cannot be deleted.

A new role can also be described to an agent: "New role…", then "Describe it to an agent…". A session of the `role-author` role reads the project and the roles it has, writes the role, saves it with the `save_role` tool and stays open, so you refine the role by talking to it or in the settings, which open on it after the first save. The text is checked like a session start (unknown keys, parents, MCP servers, plugins and skills are refused and nothing is written), every save is a version in the history with the agent as its source, and you get a message that says what the role may use. A role decides what a session may do, so `save_role` works only for that session and only for the role you named: no agent can change another role, or its own.

A role is either the project's (`.dwa/roles/`) or personal (`~/.config/dwa/roles/`, yours in every project), and every screen says which. New and Duplicate ask where the role goes, and a role can be moved from one place to the other with its history. A personal role that the project has one of the same name for is listed as hidden and can still be opened. "Save globally" in the Agent tools dialog names its targets the same way, and can write to your personal `[defaults]` as well as the project's.

Saving changes only the lines of the settings that changed; comments and the rest of the file stay as they are.

Every change to a role file or to `config.toml` is kept as a numbered version in `.dwa/history/` (personal roles: `~/.config/dwa/history/`): saves from the dialogs, and edits made by hand, which dwa notices the next time it reads the file. Switching to another version gives the file that content and moves a pointer; no version is ever removed, so you can go from v4 to v2 and back to v4. An edit made while on v2 becomes v5.

```sh
bun run dwa role history reviewer        # * marks the current version
bun run dwa role diff reviewer           # the current version against the one before
bun run dwa role diff reviewer v2 v4
bun run dwa role switch reviewer v2
bun run dwa role new tester --description "Runs the tests"
bun run dwa role copy reviewer critic
bun run dwa role new helper --personal   # yours, in every project
bun run dwa role copy reviewer mine --to personal
bun run dwa role move mine --to project
bun run dwa role history personal:mine   # personal:<name> or project:<name> names one file exactly
bun run dwa role rename critic judge
bun run dwa role delete judge
bun run dwa role edit-prompt reviewer
bun run dwa role edit-when-to-use reviewer   # what the main session reads when it picks a role
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
