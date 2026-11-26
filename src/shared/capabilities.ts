import { z } from "zod";

/** A mistake in a config file, a role file or a reference between them. */
export class ConfigError extends Error {}

/** Effort levels the Claude command accepts with `--effort`. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/** Permission modes the Claude command accepts with `--permission-mode`. */
export const PERMISSION_MODES = [
  "manual",
  "acceptEdits",
  "auto",
  "plan",
  "dontAsk",
  "bypassPermissions",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * Built-in tools that start subagents inside a session, out of the workspace's sight. A session
 * has them only with `subagents = true`. (`Task` is another name for `Agent`; docs/spikes.md, S6.)
 */
export const SUBAGENT_TOOLS: readonly string[] = ["Agent", "Workflow"];

/**
 * Built-in skills that start a subagent of their own through the `Skill` tool, so taking
 * `SUBAGENT_TOOLS` away does not stop them: the Claude command runs them as a background fork
 * (docs/spikes.md, S5, "Problems found"). Switched off with the tools, by the Claude command's own ids.
 */
export const SUBAGENT_SKILLS: readonly string[] = ["code-review"];

/**
 * The built-in tools a session has when no layer gives it a `tools` list. Short on purpose: a
 * tool that is not listed does not exist for the session, so a tool a new version of the Claude
 * command brings stays out until a role asks for it, and the definitions of the rest are not
 * sent with every request (docs/spikes.md, S9: 21k tokens of tool definitions without a list,
 * under 5k with this one). `subagents = true` adds `SUBAGENT_TOOLS`.
 */
export const DEFAULT_TOOLS: readonly string[] = [
  "Read",
  "Edit",
  "Write",
  "Bash",
  "Glob",
  "Grep",
  "Skill",
  "AskUserQuestion",
  "ExitPlanMode",
];

/**
 * In a `tools` list: every built-in tool the Claude command ships, known to dwa or not. The
 * way back to a session that is limited only by `deny_tools`.
 */
export const ALL_TOOLS = "*";

/**
 * The skills built into the Claude command (2.1.332; docs/spikes.md, S9), by the ids it uses
 * in `skillOverrides`. All are switched off unless named in `builtin_skills`. A skill of a
 * later version that is missing here is not switched off, but the session's hook refuses it
 * (`skillRefusal` in `tools.ts`).
 */
export const BUILTIN_SKILLS: readonly string[] = [
  "artifact-capabilities",
  "artifact-design",
  "artifact-diagramming",
  "claude-api",
  "claude-approvals",
  "code-review",
  "dataviz",
  "fewer-permission-prompts",
  "init",
  "keybindings-help",
  "loop",
  "plugin-authoring",
  "run",
  "schedule",
  "security-review",
  "ship",
  "simplify",
  "steward",
  "update-config",
  "workflow-authoring",
];

/** Model for a session, as the Claude command's `--model` takes it (an alias or a full name). */
export const ModelSchema = z.string().min(1);
/** Effort for a session, passed with `--effort`. */
export const EffortSchema = z.enum(EFFORT_LEVELS);

/** Name of a role, a catalogue entry or a skill: also a file name, so no separators. */
export const NAME_PATTERN = /^[\w.-]+$/;
const NameSchema = z.string().regex(NAME_PATTERN, "use letters, digits, '.', '_' and '-' only");
const NamesSchema = z.array(NameSchema);
const RulesSchema = z.array(z.string().min(1));

/**
 * What a session may use. The same fields appear in `[defaults]`, in a role file, in an
 * `[[agents]]` entry, in a workflow step and in a spawn request; a later layer replaces the
 * value of an earlier one.
 */
export const capabilityFields = {
  model: ModelSchema.optional(),
  effort: EffortSchema.optional(),
  permission_mode: z.enum(PERMISSION_MODES).optional(),
  /**
   * Built-in tools the session has; nothing else exists for it. Without it: `DEFAULT_TOOLS`.
   * `"*"` (`ALL_TOOLS`) in the list stands for every tool the Claude command ships. Not together
   * with `deny_tools` in one file.
   */
  tools: RulesSchema.optional(),
  /** Built-in tools taken away from the list a lower layer or the default gives. */
  deny_tools: RulesSchema.optional(),
  /** Permission rules that are allowed without a prompt, such as `Bash(git log *)`. */
  allow: RulesSchema.optional(),
  /** Permission rules that are refused. */
  deny: RulesSchema.optional(),
  /** MCP servers from the catalogue (`[mcp.<name>]`). */
  mcp: NamesSchema.optional(),
  /** Plugins from the catalogue (`[plugins.<name>]`). */
  plugins: NamesSchema.optional(),
  /** Skills by name. When absent the session has every project skill and no others. */
  skills: NamesSchema.optional(),
  /**
   * MCP servers of the project's own `.mcp.json` to leave out, by name. They are in every
   * session unless named here.
   */
  off_mcp: NamesSchema.optional(),
  /**
   * Plugins and skills built into the Claude command to switch off, by the ids it uses for
   * them (`/plugin` and `/skills` in a session show them). They are on unless named here.
   */
  off_plugins: RulesSchema.optional(),
  off_skills: RulesSchema.optional(),
  /**
   * Skills built into the Claude command that the session keeps (`BUILTIN_SKILLS`). All of them
   * are off unless named here; one that starts a subagent needs `subagents` as well.
   */
  builtin_skills: NamesSchema.optional(),
  /**
   * Lets the session read and write the Claude command's own per-project memory, which is kept
   * in the user's Claude config. Off unless set, like the rest of the user's own setup.
   */
  memory: z.boolean().optional(),
  /**
   * Lets the session use the Claude command's own subagents (`SUBAGENT_TOOLS` and
   * `SUBAGENT_SKILLS`). Off unless
   * set: work is handed over to sessions of the workspace, which the user can see.
   */
  subagents: z.boolean().optional(),
};

const CapabilitiesSchema = z.strictObject(capabilityFields);
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export const CAPABILITY_KEYS = Object.keys(capabilityFields) as (keyof Capabilities)[];

/** For `superRefine`: a single file may give an allow list or a deny list of tools, not both. */
export function refuseBothToolLists(
  value: { tools?: unknown; deny_tools?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (value.tools !== undefined && value.deny_tools !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["deny_tools"],
      message: "set either tools or deny_tools, not both",
    });
  }
}

/** Checks capability values that did not come from a file, such as those of a spawn request. */
export function parseCapabilities(input: unknown, source: string): Capabilities {
  const result = CapabilitiesSchema.superRefine(refuseBothToolLists).safeParse(input);
  if (!result.success) throw new ConfigError(`${source}: ${formatIssues(result.error)}`);
  return result.data;
}

/** Only the capability fields of a larger object, without the ones that are not set. */
export function pickCapabilities(source: Partial<Capabilities>): Capabilities {
  const picked: Record<string, unknown> = {};
  for (const key of CAPABILITY_KEYS) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked as Capabilities;
}

/**
 * Puts one layer on top of another. A value the upper layer sets replaces the lower one, lists
 * included. A `tools` list starts afresh, so it drops what was taken away below it; a
 * `deny_tools` list takes away from whatever list is below it, which stays.
 */
export function layerCapabilities(lower: Capabilities, upper: Capabilities): Capabilities {
  const merged: Capabilities = { ...lower, ...pickCapabilities(upper) };
  if (upper.tools !== undefined) delete merged.deny_tools;
  return merged;
}

/**
 * The built-in tools these values give a session, before anything is taken away: the `tools`
 * list, or the default one. `null` when the list says "every tool" (`ALL_TOOLS`), which no list
 * of names can stand for.
 */
export function listedTools(caps: Capabilities): string[] | null {
  if (caps.tools?.includes(ALL_TOOLS)) return null;
  if (caps.tools) return caps.tools;
  return caps.subagents === true ? [...DEFAULT_TOOLS, ...SUBAGENT_TOOLS] : [...DEFAULT_TOOLS];
}

/** Turns a zod failure into the one-line form used for every config file. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}
