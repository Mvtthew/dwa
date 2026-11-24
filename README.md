# dwa

A terminal workspace for running several Claude Code sessions side by side and letting them work together.

> Status: early development. The workspace, agent panes, profiles and live agent state work; messaging between agents is next. See [docs/architecture.md](docs/architecture.md) for the plan and [docs/research.md](docs/research.md) for the survey behind it.

## What it does and will do

- Run a main Claude Code session that is always visible, plus any number of agent sessions, all inside tmux.
- Show the active agents in a side pane with their state: working, idle, waiting for you, waiting for another agent.
- Open any agent's real session under the main one, so you can type to it directly.
- Let agents message each other and you, report progress, and ask questions that block until someone answers. A question never times out.
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

## Usage

```sh
bun run dwa up                      # start the workspace for this project and attach
bun run dwa agent spawn explore     # start an agent (optionally --role, --profile, --task)
bun run dwa agent open explore      # show it under the main session
bun run dwa agent close             # hide it again, it keeps running
bun run dwa agent stop explore      # end its session
bun run dwa down                    # stop everything
```

Closing the terminal leaves everything running; `dwa attach` brings it back.

### Keys

Press `Ctrl+Q`, release, then:

| Key      | Action                                                 |
| -------- | ------------------------------------------------------ |
| `1`–`9`  | Open the agent at that position under the main session |
| `x`      | Close the agent pane (the agent keeps running)         |
| `0`      | Focus the main session                                 |
| `z`      | Zoom the focused pane, and again to restore            |
| `d`      | Detach (everything keeps running)                      |
| `Ctrl+Q` | Send a real Ctrl+Q to the program in the pane          |

Clicking a pane focuses it and dragging a border resizes it. In the agents pane, click an agent to open it, or move with `j`/`k` or the arrow keys and press `Enter`; `x` closes the open agent. The prefix can be changed in the config:

```toml
[keys]
prefix = "C-a"   # tmux key notation
```

The same actions are also on `Alt+1`…`9`, `Alt+x`, `Alt+0` and `Alt+z`, but only where the terminal sends Option as Meta. On macOS layouts where Option types characters (Polish, German and others) use the prefix.

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
