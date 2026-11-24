# dwa

A terminal workspace for running several Claude Code sessions side by side and letting them work together.

> Status: early development. The design is settled, the workspace itself is not built yet. See [docs/architecture.md](docs/architecture.md) for the plan and [docs/research.md](docs/research.md) for the survey behind it.

## What it will do

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

## Using a different Claude command

`claude` is only the default. Profiles for other commands (for example `~/claude_me` and `~/claude_work`) will be configured in `~/.config/dwa/config.toml`; until then, set `DWA_CLAUDE_COMMAND`.

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
