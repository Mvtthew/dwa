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
  /** Built-in tools the session has; nothing else exists for it. Not together with `deny_tools`. */
  tools: RulesSchema.optional(),
  /** Built-in tools removed from the session. Not together with `tools`. */
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
   * Lets the session read and write the Claude command's own per-project memory, which is kept
   * in the user's Claude config. Off unless set, like the rest of the user's own setup.
   */
  memory: z.boolean().optional(),
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
 * included. The two tool lists are one choice: setting either drops the other from below.
 */
export function layerCapabilities(lower: Capabilities, upper: Capabilities): Capabilities {
  const merged: Capabilities = { ...lower, ...pickCapabilities(upper) };
  if (upper.tools !== undefined) delete merged.deny_tools;
  if (upper.deny_tools !== undefined) delete merged.tools;
  return merged;
}

/** Turns a zod failure into the one-line form used for every config file. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}
