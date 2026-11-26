import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  type Capabilities,
  ConfigError,
  capabilityFields,
  EffortSchema,
  formatIssues,
  layerCapabilities,
  ModelSchema,
  NAME_PATTERN,
  refuseBothToolLists,
} from "./capabilities.ts";
import { APP_NAME, CLAUDE_COMMAND_ENV, DEFAULT_CLAUDE_COMMAND } from "./constants.ts";
import { expandPath, projectConfigPath, userConfigPath } from "./paths.ts";

export { ConfigError, EffortSchema, ModelSchema };

type Env = Record<string, string | undefined>;

const ProfileSchema = z.strictObject({
  /** Executable that starts Claude Code, e.g. "claude" or "~/claude_work". */
  command: z.string().min(1),
  /** Extra arguments placed before the ones dwa adds. */
  args: z.array(z.string()).default([]),
  /** Extra environment variables for sessions using this profile. */
  env: z.record(z.string(), z.string()).default({}),
  /**
   * The Claude config directory this command uses, when it is not `~/.claude` and dwa cannot
   * tell (a wrapper that sets `CLAUDE_CONFIG_DIR` in a way it cannot read). Only used to keep
   * the personal `CLAUDE.md` in it out of sessions; nothing is written there.
   */
  config_dir: z.string().min(1).optional(),
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

/**
 * What every session gets unless its role says otherwise: the lowest layer under the role files
 * in `.dwa/roles/`. The main session is a role too, so these apply to it as well.
 */
const DefaultsSchema = z.strictObject(capabilityFields).superRefine(refuseBothToolLists);

/**
 * The main session. It runs as a role (`.dwa/roles/main.toml` unless another is named here);
 * a model or effort given here wins over the role's.
 */
const MainSchema = z.strictObject({
  role: z.string().regex(NAME_PATTERN).optional(),
  model: ModelSchema.optional(),
  effort: EffortSchema.optional(),
});

/** An MCP server roles can list by name. The fields are those of Claude Code's MCP config. */
const McpServerSchema = z.union([
  z.strictObject({
    type: z.literal("stdio").optional(),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  }),
  z.strictObject({
    type: z.enum(["http", "sse"]),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).default({}),
  }),
]);

/** A plugin roles can list by name: a directory, relative to the project (or to the personal config directory). */
const PluginSchema = z.strictObject({
  path: z.string().min(1),
});

const catalogue = <T extends z.ZodType>(entry: T) =>
  z.record(z.string().regex(NAME_PATTERN, "use letters, digits, '.', '_' and '-' only"), entry);

/** An agent started together with the workspace. */
const AgentSchema = z
  .strictObject({
    name: z.string().min(1),
    /** Role to run as (a `.dwa/roles/<role>.toml` file). */
    role: z.string().optional(),
    profile: z.string().optional(),
    /** First prompt for the session. */
    task: z.string().optional(),
    /** Anything set here replaces what the role says, for this agent only. */
    ...capabilityFields,
  })
  .superRefine(refuseBothToolLists);

const LayoutSchema = z.strictObject({
  /** Width of the status pane in columns. */
  status_width: z.number().int().min(16).max(80).optional(),
  /** Width of the agents pane in columns. */
  agents_width: z.number().int().min(16).max(80).optional(),
  /** Width of the event feed on the right, in columns. */
  feed_width: z.number().int().min(16).max(80).optional(),
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
  main: MainSchema.default({}),
  mcp: catalogue(McpServerSchema)
    .refine((servers) => !(APP_NAME in servers), `"${APP_NAME}" is the workspace's own server`)
    .default({}),
  plugins: catalogue(PluginSchema).default({}),
});

export type Profile = z.infer<typeof ProfileSchema>;
export type Config = z.infer<typeof ConfigSchema> & {
  /**
   * `[defaults]` of the personal config alone, kept when the two files are merged so a value
   * can be traced to the file it is written in. Not a key of either file.
   */
  userDefaults?: Capabilities;
  /** `[defaults]` of the project's config alone, for the same reason. */
  projectDefaults?: Capabilities;
};
export type AgentConfig = z.infer<typeof AgentSchema>;
export type LayoutConfig = z.infer<typeof LayoutSchema>;
export type McpServerConfig = z.infer<typeof McpServerSchema>;
export type PluginConfig = z.infer<typeof PluginSchema>;

export interface ResolvedProfile {
  /** Profile name, or "env" / "default" when no named profile was used. */
  name: string;
  /** Command with `~` and variables expanded. */
  command: string;
  args: string[];
  env: Record<string, string>;
  /** The profile's `config_dir`, expanded; absent when it is not set. */
  configDir?: string;
}

export const EMPTY_CONFIG: Config = {
  profiles: {},
  keys: {},
  agents: [],
  layout: {},
  defaults: {},
  main: {},
  mcp: {},
  plugins: {},
};

/**
 * Parses one config file. With `base` (the directory relative paths in this file start from),
 * plugin paths come back absolute, so they still mean the same after the two files are merged.
 */
export function parseConfig(text: string, source: string, base?: string): Config {
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (error) {
    throw new ConfigError(`${source}: invalid TOML: ${(error as Error).message}`);
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) throw new ConfigError(`${source}: ${formatIssues(result.error)}`);
  const config = result.data;
  if (base === undefined) return config;
  const plugins = Object.fromEntries(
    Object.entries(config.plugins).map(([name, plugin]) => [
      name,
      { ...plugin, path: resolve(base, expandPath(plugin.path)) },
    ]),
  );
  return { ...config, plugins };
}

/**
 * Project settings override personal ones. Profiles, keys, layout and the two catalogues are
 * merged entry by entry; the list of agents to start is the project's when it has one, otherwise
 * the personal one.
 */
export function mergeConfig(user: Config, project: Config): Config {
  return {
    default_profile: project.default_profile ?? user.default_profile,
    profiles: { ...user.profiles, ...project.profiles },
    keys: { ...user.keys, ...project.keys },
    agents: project.agents.length > 0 ? project.agents : user.agents,
    layout: { ...user.layout, ...project.layout },
    // Layered like roles are, so one file's allow list and the other's deny list of tools
    // do not both survive.
    defaults: layerCapabilities(user.defaults, project.defaults),
    userDefaults: user.defaults,
    projectDefaults: project.defaults,
    main: { ...user.main, ...project.main },
    mcp: { ...user.mcp, ...project.mcp },
    plugins: { ...user.plugins, ...project.plugins },
  };
}

async function readConfig(path: string, base: string): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) return EMPTY_CONFIG;
  return parseConfig(await file.text(), path, base);
}

export async function loadConfig(projectRoot: string, env: Env = process.env): Promise<Config> {
  const [user, project] = await Promise.all([
    readConfig(userConfigPath(env), dirname(userConfigPath(env))),
    readConfig(projectConfigPath(projectRoot), projectRoot),
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
      configDir: profile.config_dir ? expandPath(profile.config_dir, env) : undefined,
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
