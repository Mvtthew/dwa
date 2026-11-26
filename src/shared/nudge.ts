// When a session that leads does a lot itself, it is reminded that it could hand the work
// over. A reminder is never a refusal: the call has run, and what to do next is the session's
// judgement. Pure: the daemon keeps one state per leading session and feeds it the tool calls.

export type NudgeKind = "reads" | "edits" | "checks" | "web";

/** What a leading session has done itself in its current turn. */
export interface NudgeState {
  /** Calls that read or search files. */
  reads: number;
  /** The files it has edited or written, each once. */
  edited: string[];
  /** Web searches and fetches. */
  web: number;
  /** The reminders it has had this turn: each kind comes once. */
  fired: NudgeKind[];
  /** It started an agent or a workflow this turn, so it is handing work over already. */
  delegated: boolean;
}

export function newTurn(): NudgeState {
  return { reads: 0, edited: [], web: 0, fired: [], delegated: false };
}

/** From how many reads and searches, edited files and web lookups in one turn a reminder comes. */
export const NUDGE_AT = { reads: 8, edits: 3, web: 3 } as const;

const READ_TOOLS = ["Read", "Grep", "Glob"];
const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];
const WEB_TOOLS = ["WebSearch", "WebFetch"];
/** Calls that hand work over; `mcp__<server>__` stands before the name. */
const DELEGATING = /^mcp__[^_]+(?:_[^_]+)*__(spawn_agent|run_workflow)$/;

const PACKAGE_SCRIPTS = ["test", "build", "lint", "typecheck", "check"];

/**
 * How a command that runs the project's checks starts, when `[main] check_commands` does not
 * say: test, build, lint and typecheck runs of the usual tools.
 */
export const DEFAULT_CHECK_COMMANDS: readonly string[] = [
  ...["bun", "npm", "pnpm", "yarn"].flatMap((manager) => [
    `${manager} test`,
    ...PACKAGE_SCRIPTS.map((script) => `${manager} run ${script}`),
  ]),
  "npx tsc",
  "tsc",
  "pytest",
  "jest",
  "vitest",
  "eslint",
  "biome",
  "cargo test",
  "cargo build",
  "cargo check",
  "cargo clippy",
  "go test",
  "go build",
  "go vet",
  "make",
  "mvn",
  "gradle",
  "./gradlew",
  "dotnet test",
  "dotnet build",
];

/**
 * Whether a shell command runs one of the check commands: one of its parts (between `&&`,
 * `||`, `;` and `|`) starts with one, as whole words.
 */
export function isCheckCommand(
  command: string,
  checks: readonly string[] = DEFAULT_CHECK_COMMANDS,
): boolean {
  const parts = command.split(/&&|\|\||[;|\n]/).map((part) => part.trim());
  return parts.some((part) =>
    checks.some((check) => check !== "" && (part === check || part.startsWith(`${check} `))),
  );
}

export interface ToolCall {
  tool: string;
  /** The tool's input as the hook gives it. */
  input?: unknown;
}

function field(input: unknown, key: string): string | undefined {
  const value = (input as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Takes one finished tool call into the turn's state and says which reminder, if any, is due
 * now. None after the session has handed work over in this turn, and each kind once a turn.
 */
export function afterCall(
  state: NudgeState,
  call: ToolCall,
  checks: readonly string[] = DEFAULT_CHECK_COMMANDS,
): { state: NudgeState; kind?: NudgeKind } {
  if (DELEGATING.test(call.tool)) return { state: { ...state, delegated: true } };
  let next = state;
  let due: NudgeKind | undefined;
  if (READ_TOOLS.includes(call.tool)) {
    next = { ...state, reads: state.reads + 1 };
    if (next.reads >= NUDGE_AT.reads) due = "reads";
  } else if (EDIT_TOOLS.includes(call.tool)) {
    const path = field(call.input, "file_path") ?? field(call.input, "notebook_path");
    if (path !== undefined && !state.edited.includes(path)) {
      next = { ...state, edited: [...state.edited, path] };
    }
    if (next.edited.length >= NUDGE_AT.edits) due = "edits";
  } else if (WEB_TOOLS.includes(call.tool)) {
    next = { ...state, web: state.web + 1 };
    if (next.web >= NUDGE_AT.web) due = "web";
  } else if (call.tool === "Bash") {
    if (isCheckCommand(field(call.input, "command") ?? "", checks)) due = "checks";
  }
  if (due === undefined || next.delegated || next.fired.includes(due)) return { state: next };
  return { state: { ...next, fired: [...next.fired, due] }, kind: due };
}

/** The roles a kind of work goes to, the first that exists here being named. */
const ROLES_FOR: Record<NudgeKind, string[]> = {
  reads: ["explore"],
  edits: ["developer", "quick"],
  checks: ["runner"],
  web: ["web-research"],
};

function whom(kind: NudgeKind, roles: readonly string[]): string {
  const known = ROLES_FOR[kind].filter((role) => roles.includes(role));
  if (known.length === 0) return "an agent";
  return `an agent (role ${known.join(" or ")})`;
}

/**
 * The reminder as the session reads it. It says what was noticed and what the other way is,
 * and leaves the decision with the session. `roles` are the roles that exist here.
 */
export function nudgeText(kind: NudgeKind, roles: readonly string[]): string {
  const to = whom(kind, roles);
  const keep = "This is a reminder, not a refusal: if you are nearly done, carry on.";
  switch (kind) {
    case "reads":
      return `[dwa] You have read or searched ${NUDGE_AT.reads} times in this turn yourself. You lead this workspace: when there is more to find out, give the question to ${to} with spawn_agent and keep your own context for the plan and the user. ${keep}`;
    case "edits":
      return `[dwa] You have changed ${NUDGE_AT.edits} files in this turn yourself. You lead this workspace: a change of this size is work for ${to}; hand over the rest with spawn_agent, saying what is already done. ${keep}`;
    case "checks":
      return `[dwa] You ran a test, build or lint command yourself, and its output is now in your context. You lead this workspace: next time give the run to ${to} with spawn_agent and read only the outcome. ${keep}`;
    case "web":
      return `[dwa] You have looked things up on the web ${NUDGE_AT.web} times in this turn yourself. You lead this workspace: when there is more to look up, give the question to ${to} with spawn_agent. ${keep}`;
  }
}
