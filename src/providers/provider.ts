import type { ResolvedProfile } from "../shared/config.ts";

export interface LaunchRequest {
  profile: ResolvedProfile;
  /** Session id chosen by dwa so it can match hook events to the agent. */
  sessionId: string;
  /** Display name, also the address other sessions use to message this one. */
  name: string;
  /** Agent definition to run as (for Claude Code: a `.claude/agents/<role>.md` file). */
  role?: string;
  /** First prompt, given when the agent is spawned with a task. */
  task?: string;
}

export interface Launch {
  argv: string[];
  env: Record<string, string>;
}

/** One coding-agent CLI. Claude Code is the only implementation for now. */
export interface Provider {
  id: string;
  buildLaunch(request: LaunchRequest): Launch;
}
