import { z } from "zod";
import { CLAUDE_COMMAND_ENV, DEFAULT_CLAUDE_COMMAND } from "./constants.ts";
import { expandPath, projectConfigPath, userConfigPath } from "./paths.ts";
import { EFFORT_LEVELS } from "./roles.ts";

type Env = Record<string, string | undefined>;

const ProfileSchema = z.strictObject({
  /** Executable that starts Claude Code, e.g. "claude" or "~/claude_work". */
  command: z.string().min(1),
  /** Extra arguments placed before the ones dwa adds. */
  args: z.array(z.string()).default([]),
  /** Extra environment variables for sessions using this profile. */
  env: z.record(z.string(), z.string()).default({}),
});

const KeysSchema = z.strictObject({
  /**
   * Key pressed before a dwa shortcut, in tmux notation ("C-q" is Ctrl+Q). A prefix is the
   * default because Alt/Option shortcuts do not reach the terminal on keyboard layouts where
   * Option types characters (macOS with Polish, German, ...).
   */
  prefix: z
    .string()
    .regex(/^[\w-]+$/, "use tmux key notation such as C-q")
    .optional(),
});

/** Model for a session, as the Claude command's `--model` takes it (an alias or a full name). */
export const ModelSchema = z.string().min(1);
/** Effort for a session, passed with `--effort`. */
export const EffortSchema = z.enum(EFFORT_LEVELS);

/**
 * Model and effort for agents that say nothing themselves. An agent's own setting wins, then
 * its role file (`model:` / `effort:` in `.claude/agents/<role>.md`), then these. The main
 * session is not affected; set its model through the profile's `args`.
 */
const DefaultsSchema = z.strictObject({
  model: ModelSchema.optional(),
  effort: EffortSchema.optional(),
});

/** An agent started together with the workspace. */
const AgentSchema = z.strictObject({
  name: z.string().min(1),
  /** Agent definition to run as (a `.claude/agents/<role>.md` file). */
  role: z.string().optional(),
  profile: z.string().optional(),
  model: ModelSchema.optional(),
  effort: EffortSchema.optional(),
  /** First prompt for the session. */
  task: z.string().optional(),
});

const LayoutSchema = z.strictObject({
  /** Width of the status pane in columns. */
  status_width: z.number().int().min(16).max(80).optional(),
  /** Width of the agents pane in columns. */
  agents_width: z.number().int().min(16).max(80).optional(),
  /** Height of the agent pane opened under main, in percent of the centre column. */
  agent_height: z.number().int().min(10).max(90).optional(),
});

const ConfigSchema = z.strictObject({
  default_profile: z.string().optional(),
  profiles: z.record(z.string(), ProfileSchema).default({}),
  keys: KeysSchema.default({}),
  agents: z.array(AgentSchema).default([]),
  layout: LayoutSchema.default({}),
  defaults: DefaultsSchema.default({}),
});

export type Profile = z.infer<typeof ProfileSchema>;
export type Config = z.infer<typeof ConfigSchema>;
export type AgentConfig = z.infer<typeof AgentSchema>;
export type LayoutConfig = z.infer<typeof LayoutSchema>;

export interface ResolvedProfile {
  /** Profile name, or "env" / "default" when no named profile was used. */
  name: string;
  /** Command with `~` and variables expanded. */
  command: string;
  args: string[];
  env: Record<string, string>;
}

export class ConfigError extends Error {}

export const EMPTY_CONFIG: Config = {
  profiles: {},
  keys: {},
  agents: [],
  layout: {},
  defaults: {},
};

export function parseConfig(text: string, source: string): Config {
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (error) {
    throw new ConfigError(`${source}: invalid TOML: ${(error as Error).message}`);
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`${source}: ${issues}`);
  }
  return result.data;
}

/**
 * Project settings override personal ones. Profiles, keys and layout are merged field by field;
 * the list of agents to start is the project's when it has one, otherwise the personal one.
 */
export function mergeConfig(user: Config, project: Config): Config {
  return {
    default_profile: project.default_profile ?? user.default_profile,
    profiles: { ...user.profiles, ...project.profiles },
    keys: { ...user.keys, ...project.keys },
    agents: project.agents.length > 0 ? project.agents : user.agents,
    layout: { ...user.layout, ...project.layout },
    defaults: { ...user.defaults, ...project.defaults },
  };
}

async function readConfig(path: string): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) return EMPTY_CONFIG;
  return parseConfig(await file.text(), path);
}

export async function loadConfig(projectRoot: string, env: Env = process.env): Promise<Config> {
  const [user, project] = await Promise.all([
    readConfig(userConfigPath(env)),
    readConfig(projectConfigPath(projectRoot)),
  ]);
  return mergeConfig(user, project);
}

export interface ProfileSelection {
  /** Profile set for one agent (`dwa agent spawn --profile`). Highest priority. */
  agentProfile?: string;
  /** Profile chosen for the workspace (`dwa up --profile`). */
  workspaceProfile?: string;
}

/**
 * Picks the Claude command: agent profile, then workspace profile, then `$DWA_CLAUDE_COMMAND`,
 * then `default_profile`, then plain `claude`.
 */
export function resolveProfile(
  config: Config,
  selection: ProfileSelection = {},
  env: Env = process.env,
): ResolvedProfile {
  const named = (name: string): ResolvedProfile => {
    const profile = config.profiles[name];
    if (!profile) {
      const known = Object.keys(config.profiles).join(", ") || "none defined";
      throw new ConfigError(`Unknown profile "${name}" (available: ${known})`);
    }
    return {
      name,
      command: expandPath(profile.command, env),
      args: profile.args,
      env: profile.env,
    };
  };

  if (selection.agentProfile) return named(selection.agentProfile);
  if (selection.workspaceProfile) return named(selection.workspaceProfile);
  const override = env[CLAUDE_COMMAND_ENV];
  if (override) return { name: "env", command: expandPath(override, env), args: [], env: {} };
  if (config.default_profile) return named(config.default_profile);
  return { name: "default", command: DEFAULT_CLAUDE_COMMAND, args: [], env: {} };
}

/** Every distinct command a workspace might launch, for `dwa doctor`. */
export function allProfiles(config: Config, env: Env = process.env): ResolvedProfile[] {
  const names = Object.keys(config.profiles);
  if (names.length === 0) return [resolveProfile(config, {}, env)];
  return names.map((name) => resolveProfile(config, { agentProfile: name }, env));
}
