/** The project and command name. Everything that needs the name imports it from here. */
export const APP_NAME = "dwa";

/** The name drawn large, for the foot of the status pane. Every row is as wide as the widest. */
export const APP_LOGO: readonly string[] = [
  " ______        ___    ",
  "│  _ ╲ ╲      ╱ ╱ ╲   ",
  "│ │ │ ╲ ╲ ╱╲ ╱ ╱ _ ╲  ",
  "│ │_│ │╲ V  V ╱ ___ ╲ ",
  "│____╱  ╲_╱╲_╱_╱   ╲_╲",
];

/** Name of the private tmux server socket (`tmux -L <name>`), so the user's own tmux is never touched. */
export const TMUX_SOCKET_NAME = APP_NAME;

/** Synchronized output (DECSET 2026) arrived in tmux 3.7; older versions flicker with Claude Code. */
export const MIN_TMUX_VERSION = "3.7";

/** Cross-session messaging (ListAgents / SendMessage, inbox socket) needs this Claude Code version. */
export const MIN_CLAUDE_VERSION = "2.1.224";

/** OpenTUI requires this Bun version. */
export const MIN_BUN_VERSION = "1.3.14";

/** Used when no profile and no override selects another executable. */
export const DEFAULT_CLAUDE_COMMAND = "claude";

/** Overrides the Claude command for a whole workspace (below per-agent and --profile settings). */
export const CLAUDE_COMMAND_ENV = "DWA_CLAUDE_COMMAND";

/** Most agent tiles shown at once in the agents pane; the list scrolls beyond this. */
export const MAX_VISIBLE_AGENTS = 12;

/** Default key pressed before a dwa shortcut (tmux notation, Ctrl+Q). Set `keys.prefix` to change it. */
export const DEFAULT_KEY_PREFIX = "C-q";
