import { z } from "zod";
import { CLAUDE_COMMAND_ENV, DEFAULT_CLAUDE_COMMAND } from "./constants.ts";
import { expandPath, projectConfigPath, userConfigPath } from "./paths.ts";

type Env = Record<string, string | undefined>;

const ProfileSchema = z.strictObject({
  /** Executable that starts Claude Code, e.g. "claude" or "~/claude_work". */
  command: z.string().min(1),
  /** Extra arguments placed before the ones dwa adds. */
  args: z.array(z.string()).default([]),
  /** Extra environment variables for sessions using this profile. */
  env: z.record(z.string(), z.string()).default({}),
});

const ConfigSchema = z.strictObject({
  default_profile: z.string().optional(),
  profiles: z.record(z.string(), ProfileSchema).default({}),
});

export type Profile = z.infer<typeof ProfileSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export interface ResolvedProfile {
  /** Profile name, or "env" / "default" when no named profile was used. */
  name: string;
  /** Command with `~` and variables expanded. */
  command: string;
  args: string[];
  env: Record<string, string>;
}

export class ConfigError extends Error {}

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

/** Project settings override personal ones; profiles are merged by name. */
export function mergeConfig(user: Config, project: Config): Config {
  return {
    default_profile: project.default_profile ?? user.default_profile,
    profiles: { ...user.profiles, ...project.profiles },
  };
}

async function readConfig(path: string): Promise<Config> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { profiles: {} };
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
