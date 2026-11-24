# dwa

A terminal workspace for running several Claude Code sessions side by side and letting them work together.

> Status: early development. The workspace, live agent state, messaging between agents and you, and workflows all work. Review loops and live editing of workflows, and shared memory, are planned. See [docs/architecture.md](docs/architecture.md) for the plan and [docs/research.md](docs/research.md) for the survey behind it.

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
prompt = "Review the change. The developer reports:\n{{steps.build.result}}"
```

```sh
bun run dwa workflow list
bun run dwa workflow run feature "add a --json flag to agent list"
bun run dwa workflow status         # steps and results of the latest run
bun run dwa workflow cancel 1
```

- Steps without a dependency between them run at the same time.
- `{{input}}` is the text given to the run, and `{{steps.<name>.result}}` is what an earlier step handed over. A step may also set `profile`, `model` and `effort`, and `keep_agent = true` to leave its session open afterwards.
- A step ends only when its agent calls `complete_step` or `fail_step`. If the agent just stops, it is reminded twice, then the status pane marks the step as needing you. Nothing times out; open the agent and sort it out.
- If a step fails, steps already running finish, the rest are skipped and the run fails.
- The run's outcome arrives as a message to whoever started it. Agents can start runs too, with `run_workflow`.
- Runs are stored, so they continue after a daemon restart. A run uses the file as it was when it started.

### Keys

Press `Ctrl+Q`, release, then:

| Key      | Action                                                 |
| -------- | ------------------------------------------------------ |
| `1`–`9`  | Open the agent at that position under the main session |
| `x`      | Close the agent pane (the agent keeps running)         |
| `0`      | Focus the main session                                 |
| `q`      | Answer open questions in a popup                       |
| `p`      | Command menu: open, message, start or stop agents      |
| `z`      | Zoom the focused pane, and again to restore            |
| `d`      | Detach (everything keeps running)                      |
| `Ctrl+Q` | Send a real Ctrl+Q to the program in the pane          |

Clicking a pane focuses it and dragging a border resizes it. In the agents pane, click an agent to open it, or move with `j`/`k` or the arrow keys and press `Enter`; `x` closes the open agent. The prefix can be changed in the config:

```toml
[keys]
prefix = "C-a"   # tmux key notation
```

The same actions are also on `Alt+1`…`9`, `Alt+x`, `Alt+0` and `Alt+z`, but only where the terminal sends Option as Meta. On macOS layouts where Option types characters (Polish, German and others) use the prefix.

## Project configuration

`dwa init` writes a commented `.dwa/config.toml`. Besides profiles and the key prefix it can list agents that start with the workspace and set pane sizes:

```toml
[[agents]]
name = "reviewer"
role = "reviewer"        # .claude/agents/reviewer.md
profile = "work"         # optional
task = "Wait for review requests."

[layout]
status_width = 30        # columns
agents_width = 34        # columns
agent_height = 40        # percent of the centre column
```

Model and effort can be set per agent: `model` and `effort` on an `[[agents]]` entry, on a workflow step, or with `dwa agent spawn --model <model> --effort <level>`. An agent that sets neither uses `model:` / `effort:` from its role file, and after that the `[defaults]` section:

```toml
[defaults]
model = "sonnet"
effort = "medium"       # low, medium, high, xhigh or max
```

`[defaults]` never overrides a role file and does not apply to the main session. The main session has its own section, which overrides a model set in its profile:

```toml
[main]
model = "opus"
effort = "medium"
```

Agent roles are ordinary Claude Code agent definitions in `.claude/agents/`. `dwa init --roles` adds three to start from, `explore`, `developer` and `reviewer`, and an example workflow that uses them. `dwa init` never overwrites a file; in a git repository it also adds `.dwa/run/` to `.gitignore`.

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
