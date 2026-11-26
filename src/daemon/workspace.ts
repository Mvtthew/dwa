import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { listServerTools } from "../mcp/list-tools.ts";
import type { Provider } from "../providers/provider.ts";
import {
  type Capabilities,
  layerCapabilities,
  parseCapabilities,
  pickCapabilities,
} from "../shared/capabilities.ts";
import {
  type Config,
  ConfigError,
  EffortSchema,
  type ResolvedProfile,
  resolveProfile,
} from "../shared/config.ts";
import { APP_NAME, DEFAULT_KEY_PREFIX } from "../shared/constants.ts";
import { expandPath, projectConfigPath, userConfigPath } from "../shared/paths.ts";
import type {
  AgentInfo,
  AgentKind,
  Applied,
  HookRequest,
  PopupKind,
  RefreshRequest,
  RefreshResult,
  RestartWhen,
  SessionRef,
  SpawnRequest,
  StatuslineRequest,
  Telemetry,
  ToolsInfo,
  ToolsSaveRequest,
  ToolsSaveResult,
  UpRequest,
  WorkspaceState,
} from "../shared/protocol.ts";
import { describeTarget, noticeEdits, saveValues } from "../shared/role-edit.ts";
import { guideEntries, roleGuideList, roleGuidePrompt } from "../shared/role-guide.ts";
import {
  diskFiles,
  findRole,
  findSkill,
  missingOnThisMachine,
  type ResolvedSession,
  type ResolvedSkill,
  type RoleContext,
  type RoleFiles,
  resolveLayers,
  resolveSession,
  type SessionSummary,
  summarizeSession,
  UnknownRoleError,
} from "../shared/roles.ts";
import { type Scope, scopeLabel } from "../shared/scope.ts";
import { SKILL_FILE, skillHeader } from "../shared/skill-file.ts";
import { skillGuideEntries, skillGuidePrompt, skillTask } from "../shared/skill-guide.ts";
import {
  applyToolChanges,
  BLOCKED_FILE,
  blockedReason,
  liveBlocks,
  SKILLS_FILE,
  type ToolSources,
  toolView,
} from "../shared/tools.ts";
import { popupArgs, selfCommand, tmuxQuote } from "../tmux/conf.ts";
import type { TmuxRunner } from "../tmux/driver.ts";
import {
  createWorkspace,
  DEFAULT_LAYOUT,
  focusPane,
  hasSession,
  killPane,
  listPanes,
  openUnderMain,
  type PaneCommand,
  type PaneStatus,
  respawnPane,
  returnToPool,
  SESSION,
  spawnPoolWindow,
} from "../tmux/layout.ts";
import { parseStatusline, reduceHook, sessionLine, snippet } from "./activity.ts";
import type { AgentRow, Store } from "./db.ts";
import { reportSuffix } from "./delegation.ts";
import { WorkspaceError } from "./errors.ts";
import { Messaging, USER } from "./messaging.ts";
import { MAX_REMINDERS, workflowRuns } from "./workflows.ts";

export { WorkspaceError };

const NAME_PATTERN = /^[A-Za-z0-9][\w.-]{0,39}$/;
const META_PROFILE = "workspace_profile";
const META_AGENT_HEIGHT = "agent_height";
const META_STARTED_AT = "started_at";
const META_SHELL_PANE = "shell_pane";
/** The id of the newest message to the user when they last cleared them. */
const META_INBOX_CLEARED = "inbox_cleared";
/** Messages to the user a state carries: what the status pane and its dialog show. */
const INBOX_SIZE = 20;
const SHELL_NAME = "shell";

/** What a session was asked to be started with; kept so it can be started again the same way. */
interface StoredRequest {
  role?: string;
  main?: boolean;
  overrides?: Capabilities;
  narrowOnly?: boolean;
  /** Profile asked for with the agent, when one was. */
  profile?: string;
}

/** Meta key: capability values per role for this run of the workspace, as JSON. */
const META_ROLE_RUN = "role_run";
/** How long a server's tool list and the "behind its files" check are trusted. */
const TOOLS_TTL_MS = 5 * 60_000;
const BEHIND_TTL_MS = 2000;

function parseJson<T>(text: string | null): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export interface WorkspaceDeps {
  store: Store;
  run: TmuxRunner;
  provider: Provider;
  projectRoot: string;
  /** Path of the daemon socket, handed to every pane as DWA_SOCKET. */
  socketPath: string;
  /** Command that runs the dwa CLI, used for the status and agents panes and for hooks. */
  selfArgv: string[];
  /** Directory for generated per-session files (`<project>/.dwa/run`). */
  runDir: string;
  /** Writes a generated file; replaced in tests. */
  writeFile?: (path: string, content: string) => void;
  loadConfig: () => Promise<Config>;
  /** Makes a link to a skill's directory inside a session's generated plugin; replaced in tests. */
  linkDir?: (target: string, path: string) => void;
  /** Finds the Claude config directory a wrapper command sets; replaced in tests. */
  wrapperConfigDir?: (command: string, env: Record<string, string | undefined>) => string | null;
  /** How role files, skills and commands are looked up; replaced in tests. */
  roleFiles?: RoleFiles;
  /** Asks an MCP server for its tool names; replaced in tests. */
  listTools?: (server: unknown) => Promise<string[]>;
  /** Shortcut prefix in tmux notation, shown in the status pane. */
  keyPrefix?: string;
  env?: Record<string, string | undefined>;
  newId?: () => string;
  /** Timer used for the paste fallback of message delivery; replaced in tests. */
  schedule?: (callback: () => void, ms: number) => void;
  /** Timer used for giving a session its task; replaced in tests. */
  taskTimer?: (callback: () => void, ms: number) => void;
  now?: () => number;
}

/**
 * How long after a session's dwa tools connected its task is typed in. In the spike a prompt
 * pasted right at the connection had the tools in every run (docs/spikes.md, S8); this adds
 * a margin.
 */
const TASK_SETTLE_MS = 500;

/** When a session gets its task although its dwa tools never reported in. */
const TASK_FALLBACK_MS = 20_000;

/** In the middle of a turn, or not ready yet: a restart now would interrupt it. */
function isBusy(agent: { activity: string }): boolean {
  return ["working", "needs_user", "starting"].includes(agent.activity);
}

/** The servers of an MCP config file: under `mcpServers`, or the file itself. Empty when unreadable. */
function mcpServers(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return {};
    const servers = "mcpServers" in parsed ? parsed.mcpServers : parsed;
    return servers && typeof servers === "object" ? (servers as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The Claude config directory a wrapper script sets, read from the script itself: profiles are
 * often small scripts that export `CLAUDE_CONFIG_DIR` and then run the real command, and that
 * value is not in dwa's own environment. Null for anything that is not such a script.
 */
export function wrapperConfigDir(
  command: string,
  env: Record<string, string | undefined>,
): string | null {
  try {
    // A wrapper is a few lines; the real executable is far larger and is not read.
    if (!existsSync(command) || statSync(command).size > 16_384) return null;
    const match = /^\s*(?:export\s+)?CLAUDE_CONFIG_DIR=(["']?)([^"'\s;]+)\1/m.exec(
      readFileSync(command, "utf8"),
    );
    return match?.[2] ? expandPath(match[2], { HOME: homedir(), ...env }) : null;
  } catch {
    return null;
  }
}

/** What other parts of the daemon can react to: a finished turn, or a session that is gone. */
export interface AgentEvent {
  type: "turn_ended" | "stopped";
  agentId: string;
}

/** The application service behind the CLI, the UI panes and (later) the MCP tools. */
export class Workspace {
  private queue: Promise<unknown> = Promise.resolve();
  /** Latest statusline figures per agent. Refreshed every few seconds, so not persisted. */
  private readonly telemetry = new Map<string, Telemetry>();
  /** What each running session was started with, in short form; null when it was not recorded. */
  private readonly capabilities = new Map<string, SessionSummary | null>();
  /** What to tell a session once it is back after a restart or a change, by agent id. */
  private readonly notes = new Map<string, string>();
  /** Tool names of MCP servers, by server definition; null when the server did not answer. */
  private readonly serverTools = new Map<string, { at: number; tools: string[] | null }>();
  /** Ids of the sessions whose files changed since their start, and when that was worked out. */
  private behind: { at: number; ids: Set<string> } = { at: 0, ids: new Set() };
  readonly messaging: Messaging;
  private readonly env: Record<string, string | undefined>;
  private readonly newId: () => string;
  private readonly now: () => number;
  private readonly listeners: Array<(event: AgentEvent) => void> = [];
  /** Ids of the sessions that were started for a task and have not been given it yet. */
  private readonly awaitingTask = new Set<string>();
  private readonly taskTimer: (callback: () => void, ms: number) => void;

  constructor(private readonly deps: WorkspaceDeps) {
    this.env = deps.env ?? process.env;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? Date.now;
    // Not kept alive for: a daemon that is shutting down does not wait to hand out a task.
    this.taskTimer = deps.taskTimer ?? ((callback, ms) => void setTimeout(callback, ms).unref());
    this.messaging = new Messaging({
      store: deps.store,
      run: deps.run,
      now: this.now,
      keyPrefix: deps.keyPrefix ?? DEFAULT_KEY_PREFIX,
      schedule: deps.schedule,
    });
  }

  /**
   * Registers a listener for agent events. It is called while a tmux operation may be in
   * progress, so it must return at once and never wait for another call on this workspace.
   */
  onAgentEvent(listener: (event: AgentEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(error);
      }
    }
  }

  /** Records that a session is gone and lets everything that depended on it know. */
  private markStopped(agentId: string): void {
    this.deps.store.markStopped(agentId, this.now());
    this.telemetry.delete(agentId);
    this.capabilities.delete(agentId);
    this.awaitingTask.delete(agentId);
    this.messaging.agentStopped(agentId);
    this.emit({ type: "stopped", agentId });
  }

  get projectRoot(): string {
    return this.deps.projectRoot;
  }

  /** tmux changes must not interleave, so every operation runs after the previous one ends. */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  state(): Promise<WorkspaceState> {
    return this.serial(() => this.snapshot());
  }

  up(request: UpRequest = {}): Promise<WorkspaceState> {
    return this.serial(async () => {
      const before = await this.snapshot();
      if (before.up && before.main) return before;
      // A session without a live main pane cannot be repaired in place; start clean.
      if (await hasSession(this.deps.run)) await this.killServer();

      const config = await this.deps.loadConfig();
      const profile = resolveProfile(config, { workspaceProfile: request.profile }, this.env);
      const session = this.resolve("main", { config, main: true });
      this.deps.store.setMeta(META_PROFILE, request.profile ?? null);
      this.deps.store.setMeta(META_STARTED_AT, String(this.now()));
      this.deps.store.setMeta(META_SHELL_PANE, null);
      // Values saved "for the next agents of the role" belong to one run of the workspace.
      this.deps.store.setMeta(META_ROLE_RUN, null);

      const id = this.newId();
      const sessionId = this.newId();
      const launch = this.deps.provider.buildLaunch({
        profile,
        sessionId,
        name: "main",
        session,
        ...this.sessionFiles(id, "main", session, profile),
      });
      const panes = await createWorkspace(this.deps.run, {
        cwd: this.deps.projectRoot,
        left: this.uiPane("status", "status"),
        main: {
          argv: launch.argv,
          env: { ...launch.env, ...this.paneEnv(id) },
          title: "main",
        },
        right: this.uiPane("agents", "agents"),
        sizes: {
          statusWidth: config.layout.status_width ?? DEFAULT_LAYOUT.statusWidth,
          agentsWidth: config.layout.agents_width ?? DEFAULT_LAYOUT.agentsWidth,
          agentHeight: config.layout.agent_height ?? DEFAULT_LAYOUT.agentHeight,
        },
      });
      this.insert(
        { id, kind: "main", name: "main", profile: profile.name, sessionId, role: session.role },
        panes.main,
        session,
        { main: true },
      );
      this.deps.store.setMeta(
        META_AGENT_HEIGHT,
        config.layout.agent_height ? String(config.layout.agent_height) : null,
      );

      // Agents listed in the config start with the workspace. One that cannot be started
      // (bad name, unknown profile) is reported and does not stop the others.
      for (const agent of config.agents) {
        try {
          await this.spawnNow(agent);
        } catch (error) {
          const message = `Could not start agent "${agent.name}": ${(error as Error).message}`;
          console.error(message);
          await this.deps.run(["display-message", "-d", "5000", message]).catch(() => undefined);
        }
      }
      return this.snapshot();
    });
  }

  spawn(request: SpawnRequest = {}): Promise<AgentInfo> {
    return this.serial(async () => {
      try {
        return await this.spawnNow(request);
      } catch (error) {
        // An agent that named a role that does not exist is told where the roles are listed.
        if (error instanceof UnknownRoleError && request.from) {
          throw new ConfigError(
            `${error.message} Call list_roles to see the roles and what each is for.`,
          );
        }
        throw error;
      }
    });
  }

  private async spawnNow(request: SpawnRequest): Promise<AgentInfo> {
    {
      const state = await this.requireUp();
      // A skill to run as an agent: its file becomes the task, and the role it names (`agent`
      // in its front matter) is used when the request has none and the workspace has that role.
      const skill = request.skill === undefined ? null : this.skillToRun(request.skill);
      const role = request.role ?? (skill ? this.roleOfSkill(skill) : undefined);
      const name = this.uniqueName(request.name ?? skill?.name ?? role ?? "agent", state);
      const config = await this.deps.loadConfig();
      const profile = resolveProfile(
        config,
        {
          agentProfile: request.profile,
          workspaceProfile: this.deps.store.getMeta(META_PROFILE) ?? undefined,
        },
        this.env,
      );

      if (request.effort !== undefined && !EffortSchema.safeParse(request.effort).success) {
        throw new WorkspaceError(
          `Invalid effort "${request.effort}": use ${EffortSchema.options.join(", ")}.`,
        );
      }
      const { narrowOnly, ...values } = request;
      // An empty model (a form left blank) means "not set". The values are checked here because
      // a request can come from anywhere: the CLI, the menu, an agent's tool call.
      const overrides = parseCapabilities(
        pickCapabilities({ ...values, model: request.model || undefined } as Partial<Capabilities>),
        "Agent settings",
      );
      const stored: StoredRequest = {
        role,
        overrides,
        narrowOnly,
        profile: request.profile,
      };
      const session = this.resolve(name, this.sessionRequest(config, stored));
      // A session another one starts for a task owes it the result (`Delegation`). The task
      // says so, and is stored that way, so that a session started afresh reads it again.
      const asked = skill ? skillTask(skill, request.task) : request.task;
      const spawner = request.from && asked ? this.deps.store.getRunning(request.from) : null;
      const keep = request.keep === true;
      const task = spawner && asked ? `${asked}${reportSuffix(spawner.name, keep)}` : asked;

      const id = this.newId();
      const sessionId = this.newId();
      const launch = this.deps.provider.buildLaunch({
        profile,
        sessionId,
        name,
        session,
        ...this.sessionFiles(id, name, session, profile),
      });
      const paneId = await spawnPoolWindow(this.deps.run, {
        cwd: this.deps.projectRoot,
        name,
        command: { argv: launch.argv, env: { ...launch.env, ...this.paneEnv(id) }, title: name },
      });
      const row = this.insert(
        {
          id,
          kind: "agent",
          name,
          profile: profile.name,
          sessionId,
          role,
          task,
        },
        paneId,
        session,
        stored,
      );
      if (spawner) this.deps.store.setSpawner(row.id, spawner.id, keep);
      if (task) this.awaitTask(row.id);
      return {
        ...row,
        telemetry: null,
        waitingOn: null,
        open: false,
        capabilities: this.capabilitiesOf(row.id),
      };
    }
  }

  /** Shows an agent's session under main. `target` is a name, an id or a 1-based list position. */
  open(target: string): Promise<AgentInfo> {
    return this.serial(async () => {
      const state = await this.requireUp();
      const agent = this.find(state, target);
      if (!agent.open) {
        await this.clearSlot(state);
        await this.showUnderMain(state, agent.paneId);
      }
      await focusPane(this.deps.run, agent.paneId);
      return { ...agent, open: true };
    });
  }

  /** Shows an agent's session under main, or hides it when it is the one shown. */
  toggle(target: string): Promise<AgentInfo> {
    return this.serial(async () => {
      const state = await this.requireUp();
      const agent = this.find(state, target);
      await this.clearSlot(state);
      if (agent.open) {
        await focusPane(this.deps.run, state.main.paneId);
        return { ...agent, open: false };
      }
      await this.showUnderMain(state, agent.paneId);
      await focusPane(this.deps.run, agent.paneId);
      return { ...agent, open: true };
    });
  }

  /** Sends whatever is shown under main back to the pool; main gets the full height again. */
  close(): Promise<void> {
    return this.serial(async () => {
      const state = await this.requireUp();
      await this.clearSlot(state);
      await focusPane(this.deps.run, state.main.paneId);
    });
  }

  /**
   * Shows a plain shell under main, in the slot agents open in, or hides it. The shell is started
   * the first time and keeps running in the background while hidden, like an agent's session.
   */
  toggleShell(): Promise<{ open: boolean }> {
    return this.serial(async () => {
      const { run, store } = this.deps;
      const state = await this.requireUp();
      const wasOpen = state.shell?.open === true;
      await this.clearSlot(state);
      if (wasOpen) {
        await focusPane(run, state.main.paneId);
        return { open: false };
      }
      let pane = state.shell ? store.getMeta(META_SHELL_PANE) : null;
      if (!pane) {
        pane = await spawnPoolWindow(run, {
          cwd: this.deps.projectRoot,
          name: SHELL_NAME,
          command: { argv: [this.env.SHELL || "/bin/sh"], title: SHELL_NAME },
        });
        store.setMeta(META_SHELL_PANE, pane);
      }
      await this.showUnderMain(state, pane);
      await focusPane(run, pane);
      return { open: true };
    });
  }

  /** Opens a wizard, the questions or the menu in a popup over the attached terminal. Returns at once. */
  popup(kind: PopupKind, subject?: string): void {
    const self = selfCommand(this.deps.selfArgv, this.deps.projectRoot);
    // Not queued and not awaited: the command only returns when the popup is closed.
    this.deps.run(popupArgs(self, kind, subject)).catch(() => undefined);
  }

  /** Gives the main session the whole window, or the layout back when it already has it. */
  zoomMain(): Promise<void> {
    return this.serial(async () => {
      const state = await this.requireUp();
      await focusPane(this.deps.run, state.main.paneId);
      await this.deps.run(["resize-pane", "-Z", "-t", state.main.paneId]);
    });
  }

  /** Detaches the attached terminal. Everything keeps running. */
  detach(): Promise<void> {
    return this.serial(async () => {
      await this.requireUp();
      await this.deps.run(["detach-client", "-s", SESSION]).catch(() => undefined);
    });
  }

  /** Empties the slot under main: the open agent, or the shell, goes back to the pool. */
  private async clearSlot(state: WorkspaceState): Promise<void> {
    const current = state.agents.find((agent) => agent.open);
    if (current) await returnToPool(this.deps.run, { agent: current.paneId, name: current.name });
    const shell = state.shell?.open ? this.deps.store.getMeta(META_SHELL_PANE) : null;
    if (shell) await returnToPool(this.deps.run, { agent: shell, name: SHELL_NAME });
  }

  private async showUnderMain(state: { main: AgentInfo }, pane: string): Promise<void> {
    const height = Number(this.deps.store.getMeta(META_AGENT_HEIGHT)) || undefined;
    await openUnderMain(this.deps.run, {
      main: state.main.paneId,
      agent: pane,
      heightPercent: height,
    });
  }

  focusMain(): Promise<void> {
    return this.serial(async () => {
      const state = await this.requireUp();
      await focusPane(this.deps.run, state.main.paneId);
    });
  }

  stop(target: string): Promise<AgentInfo> {
    return this.serial(async () => {
      const state = await this.requireUp();
      const agent = this.find(state, target);
      await killPane(this.deps.run, agent.paneId);
      this.markStopped(agent.id);
      return { ...agent, state: "stopped", open: false };
    });
  }

  /**
   * A session started for a task gets it as its first prompt, but not as a launch argument:
   * it is typed in once the session's dwa tools have connected (`ready`), or after a while
   * when they never report in, so that the task is not lost with them.
   */
  private awaitTask(agentId: string): void {
    this.awaitingTask.add(agentId);
    this.taskTimer(() => this.giveTask(agentId), TASK_FALLBACK_MS);
  }

  /** A session's dwa MCP server reports that the session has connected to it. */
  ready(agentId: string): void {
    if (!this.awaitingTask.has(agentId)) return;
    this.taskTimer(() => this.giveTask(agentId), TASK_SETTLE_MS);
  }

  private giveTask(agentId: string): void {
    if (!this.awaitingTask.delete(agentId)) return;
    const row = this.deps.store.getRunning(agentId);
    if (row?.task) void this.messaging.prompt(row, row.task);
  }

  /** Applies a lifecycle event reported by a session's hook. Unknown or stopped agents are ignored. */
  hook(request: HookRequest): { deny?: string } {
    const { store } = this.deps;
    const row = store.getRunning(request.agentId);
    if (!row) return {};
    const input = (
      typeof request.input === "object" && request.input !== null ? request.input : {}
    ) as Record<string, unknown>;
    const change = reduceHook(request.event, input);
    const now = this.now();
    store.addEvent({
      agentId: row.id,
      at: now,
      event: request.event,
      summary: change?.detail ?? snippet(input.tool_name) ?? snippet(input.notification_type),
    });
    if (change && (change.activity !== row.activity || change.detail !== row.detail)) {
      // Keep the time of the last real change, so "idle for 5 min" stays meaningful.
      const since = change.activity === row.activity ? row.activitySince : now;
      store.setActivity(row.id, change.activity, change.detail, since);
    }
    if (request.event === "UserPromptSubmit") store.setHadTurn(row.id, true);
    if (request.event === "SessionStart") {
      // Sent only now: before, the mailbox of the process that was replaced would take it.
      const note = this.notes.get(row.id);
      this.notes.delete(row.id);
      if (note) this.messaging.send(USER, row.name, note);
    }
    if (request.event === "Stop") {
      // A restart that was waiting for the turn to end. Only queued here, never awaited.
      if (store.pendingRestart(row.id)) {
        void this.serial(() => this.restartNow(row.id)).catch((error) => {
          const message = `Could not restart ${row.name}: ${(error as Error).message}`;
          console.error(message);
          this.deps.run(["display-message", "-d", "5000", message]).catch(() => undefined);
        });
      }
      this.emit({ type: "turn_ended", agentId: row.id });
    }
    if (request.event === "PreToolUse" && typeof input.tool_name === "string") {
      const blocks = parseJson<string[]>(store.getBlocked(row.id)) ?? [];
      // The hook decides this from the session's own file; this answer is for a session
      // whose file is missing.
      const reason = blockedReason(input.tool_name, blocks);
      if (reason) return { deny: reason };
    }
    return {};
  }

  /**
   * The roles a session can hand work to as they are now, for `list_roles`. `agentId` is the
   * session that asks; its own role is left out.
   */
  roleList(agentId?: string): string {
    const launch = agentId
      ? parseJson<ResolvedSession>(this.deps.store.getLaunch(agentId))
      : undefined;
    return roleGuideList(guideEntries(this.roleContext(), { except: launch?.role }));
  }

  /** A progress note an agent reports about its own work. */
  progress(agentId: string, summary: string, percent?: number): void {
    const row = this.deps.store.getRunning(agentId);
    if (!row) throw new WorkspaceError("Unknown agent.");
    const note = snippet(summary) ?? "";
    const text =
      typeof percent === "number"
        ? `${Math.round(Math.max(0, Math.min(100, percent)))}% ${note}`
        : note;
    this.deps.store.setProgress(agentId, text.trim() || null);
    this.deps.store.addEvent({ agentId, at: this.now(), event: "Progress", summary: text });
  }

  /** Stores the figures from a session's statusline and returns the line the session shows. */
  statusline(request: StatuslineRequest): string {
    const row = this.deps.store.getRunning(request.agentId);
    if (!row) return "";
    const telemetry = parseStatusline(request.data, this.now());
    if (telemetry) this.telemetry.set(request.agentId, telemetry);
    return sessionLine(row.role, this.telemetry.get(request.agentId) ?? null);
  }

  /** Shows a short message in the attached terminal, e.g. why a shortcut did nothing. */
  notify(message: string): Promise<void> {
    return this.serial(async () => {
      // Fails when no terminal is attached; there is nobody to tell then.
      await this.deps.run(["display-message", "-d", "3000", message]).catch(() => undefined);
    });
  }

  /** Ends every session and the private tmux server. */
  down(): Promise<void> {
    return this.serial(() => this.killServer());
  }

  private async killServer(): Promise<void> {
    try {
      await this.deps.run(["kill-server"]);
    } catch {
      // no server running
    }
    for (const row of this.deps.store.running()) this.markStopped(row.id);
    this.deps.store.setMeta(META_SHELL_PANE, null);
  }

  /** Brings the stored state in line with the panes that actually exist, then returns it. */
  private async snapshot(): Promise<WorkspaceState> {
    const { store, run, projectRoot } = this.deps;
    const up = await hasSession(run);
    const panes = new Map<string, PaneStatus>();
    if (up) for (const pane of await listPanes(run)) panes.set(pane.paneId, pane);

    const live: AgentInfo[] = [];
    for (const row of store.running()) {
      const pane = panes.get(row.paneId);
      if (!pane || pane.dead) {
        // The session ended on its own (or the server is gone). Dead panes are kept by
        // remain-on-exit, so remove an agent's leftover pane.
        if (pane && row.kind === "agent") await killPane(run, row.paneId).catch(() => undefined);
        this.markStopped(row.id);
        continue;
      }
      live.push({
        ...row,
        telemetry: this.telemetry.get(row.id) ?? null,
        waitingOn: null,
        open: row.kind === "agent" && pane.inWorkspace,
        capabilities: this.capabilitiesOf(row.id),
        pendingRestart: store.pendingRestart(row.id) || undefined,
      });
    }
    if (up) {
      const behind = await this.behindIds(live);
      for (const agent of live) if (behind.has(agent.id)) agent.outOfDate = true;
    }

    // The shell is gone once the user exits it; its dead pane is removed like an agent's.
    const shellPane = up ? store.getMeta(META_SHELL_PANE) : null;
    let shell: WorkspaceState["shell"] = null;
    if (shellPane) {
      const pane = panes.get(shellPane);
      if (pane && !pane.dead) {
        shell = { open: pane.inWorkspace };
      } else {
        if (pane) await killPane(run, shellPane).catch(() => undefined);
        store.setMeta(META_SHELL_PANE, null);
      }
    }

    const questions = this.messaging.openQuestions();
    for (const agent of live) {
      agent.waitingOn = questions.find((question) => question.fromId === agent.id)?.to ?? null;
      const owed = store.handover(agent.id);
      if (owed && owed.finishedAt === null && owed.reminders <= MAX_REMINDERS) {
        agent.reportDue = true;
      }
    }

    return {
      projectRoot,
      keyPrefix: this.deps.keyPrefix ?? DEFAULT_KEY_PREFIX,
      up,
      main: live.find((agent) => agent.kind === "main") ?? null,
      agents: live.filter((agent) => agent.kind === "agent"),
      questions,
      // Only messages from this run of the workspace; older ones belong to sessions that are gone.
      inbox: this.messaging.inbox(
        INBOX_SIZE,
        Number(store.getMeta(META_STARTED_AT)) || 0,
        Number(store.getMeta(META_INBOX_CLEARED)) || 0,
      ),
      workflows: workflowRuns(store),
      shell,
    };
  }

  private async requireUp(): Promise<WorkspaceState & { main: AgentInfo }> {
    const state = await this.snapshot();
    if (!state.up || !state.main) {
      throw new WorkspaceError("The workspace is not running. Start it with `dwa up`.");
    }
    return state as WorkspaceState & { main: AgentInfo };
  }

  private find(state: WorkspaceState, target: string): AgentInfo {
    const byName = state.agents.find((agent) => agent.name === target || agent.id === target);
    if (byName) return byName;
    if (/^\d+$/.test(target)) {
      const byIndex = state.agents[Number(target) - 1];
      if (byIndex) return byIndex;
    }
    const names = state.agents.map((agent) => agent.name).join(", ") || "none running";
    throw new WorkspaceError(`No agent "${target}" (running: ${names})`);
  }

  private uniqueName(wanted: string, state: WorkspaceState): string {
    if (!NAME_PATTERN.test(wanted) || wanted === "main") {
      throw new WorkspaceError(
        `Invalid agent name "${wanted}": use letters, digits, ".", "_" or "-" (up to 40 characters), and not "main".`,
      );
    }
    const taken = new Set(state.agents.map((agent) => agent.name));
    if (!taken.has(wanted)) return wanted;
    for (let n = 2; ; n++) {
      const candidate = `${wanted}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  private insert(
    agent: {
      id: string;
      kind: AgentKind;
      name: string;
      profile: string;
      sessionId: string;
      role?: string;
      task?: string;
    },
    paneId: string,
    session: ResolvedSession,
    request: StoredRequest,
  ): AgentRow {
    const row: AgentRow = {
      id: agent.id,
      kind: agent.kind,
      name: agent.name,
      role: agent.role ?? null,
      profile: agent.profile,
      sessionId: agent.sessionId,
      paneId,
      state: "running",
      task: agent.task ?? null,
      createdAt: this.now(),
      activity: "starting",
      detail: null,
      activitySince: this.now(),
      progress: null,
    };
    this.deps.store.insertAgent(row);
    this.deps.store.setLaunch(row.id, JSON.stringify(session));
    this.deps.store.setRequest(row.id, JSON.stringify(request));
    // Its first prompt, the task included, is typed in later; the hook then says so.
    this.deps.store.setHadTurn(row.id, false);
    this.capabilities.set(row.id, summarizeSession(session));
    return row;
  }

  /**
   * `[defaults]` as one config file has them, without the other layer: what is saved into the
   * project's file must not carry the user's personal defaults into the repository, and the
   * personal file must not take the project's.
   */
  private ownDefaults(source: Scope = "project"): Capabilities {
    const files = this.deps.roleFiles ?? diskFiles;
    const text = files.read(
      source === "user" ? userConfigPath(this.env) : projectConfigPath(this.deps.projectRoot),
    );
    if (text === null) return {};
    try {
      const parsed = Bun.TOML.parse(text) as { defaults?: Partial<Capabilities> };
      return pickCapabilities(parsed.defaults ?? {});
    } catch {
      return {};
    }
  }

  /**
   * Sets what a running session is refused. The list is also written next to the session's
   * other files, where its hook reads it, so a refusal holds while this daemon is down or slow.
   */
  private setBlocks(agentId: string, blocks: string[]): void {
    this.deps.store.setBlocked(agentId, blocks.length > 0 ? JSON.stringify(blocks) : null);
    const file = join(this.deps.runDir, "agents", agentId, BLOCKED_FILE);
    const text = JSON.stringify(blocks);
    if (this.deps.writeFile) this.deps.writeFile(file, text);
    else {
      mkdirSync(dirname(file), { recursive: true });
      // Written whole and moved into place: the hook must never read half a list.
      writeFileSync(`${file}.tmp`, text);
      renameSync(`${file}.tmp`, file);
    }
  }

  /** Capability values per role that hold until the workspace stops. */
  private roleRun(): Record<string, Capabilities> {
    return parseJson<Record<string, Capabilities>>(this.deps.store.getMeta(META_ROLE_RUN)) ?? {};
  }

  /** The layers a session is resolved from, for a new session or one that is running. */
  private sessionRequest(
    config: Config,
    stored: StoredRequest,
    agent?: Capabilities,
  ): Parameters<typeof resolveSession>[0] {
    return {
      config,
      role: stored.role,
      main: stored.main,
      overrides: stored.overrides,
      narrowOnly: stored.narrowOnly,
      roleRun: stored.role ? this.roleRun()[stored.role] : undefined,
      agent,
    };
  }

  private storedRequest(row: { id: string; kind: AgentKind; role: string | null }): StoredRequest {
    return (
      parseJson<StoredRequest>(this.deps.store.getRequest(row.id)) ??
      // A session from before requests were stored: what its row still says.
      (row.kind === "main" ? { main: true } : { role: row.role ?? undefined })
    );
  }

  private agentOverrides(agentId: string): Capabilities {
    return parseJson<Capabilities>(this.deps.store.getOverrides(agentId)) ?? {};
  }

  /** A running session by name, id or list position; "main" is the main session. */
  private findSession(state: WorkspaceState, target: string): AgentInfo {
    if (state.main && (target === "main" || target === state.main.id)) return state.main;
    return this.find(state, target);
  }

  private ref(agent: AgentInfo): SessionRef {
    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      kind: agent.kind,
      activity: agent.activity,
    };
  }

  /**
   * The sessions that would be started differently now than they were: their role files or
   * the config changed, or values were saved for them that they do not have yet.
   */
  private async behindIds(live: AgentInfo[]): Promise<Set<string>> {
    if (this.now() - this.behind.at < BEHIND_TTL_MS) return this.behind.ids;
    const ids = new Set<string>();
    try {
      const config = await this.deps.loadConfig();
      for (const agent of live) {
        if (this.differs(agent, config).kind !== "unchanged") ids.add(agent.id);
      }
    } catch {
      // A config that does not parse is reported by `config check`, not by marking sessions.
    }
    this.behind = { at: this.now(), ids };
    return ids;
  }

  /**
   * How a running session differs from `wanted`, or from what it would be started with now:
   * not at all, in a way its hook can make up for by refusing calls (`blocks` is then the whole
   * list to refuse), or in a way that takes a restart.
   */
  private differs(
    agent: AgentInfo,
    config: Config,
    wanted?: ResolvedSession,
  ): { kind: "unchanged" } | { kind: "live"; blocks: string[] } | { kind: "restart" } {
    const before = parseJson<ResolvedSession>(this.deps.store.getLaunch(agent.id));
    if (!before) return { kind: "unchanged" };
    let now = wanted;
    if (!now) {
      try {
        const request = this.sessionRequest(
          config,
          this.storedRequest(agent),
          this.agentOverrides(agent.id),
        );
        now = resolveSession(request, this.roleContext());
      } catch {
        // Files that cannot be resolved right now do not make a session look changed.
        return { kind: "unchanged" };
      }
    }
    const blocks = liveBlocks(before, now);
    if (blocks === null) return { kind: "restart" };
    const current = parseJson<string[]>(this.deps.store.getBlocked(agent.id)) ?? [];
    return JSON.stringify(blocks) === JSON.stringify(current)
      ? { kind: "unchanged" }
      : { kind: "live", blocks };
  }

  /** What the tools dialog shows for a session. Asking MCP servers may take a moment. */
  /**
   * Takes the messages sent to the user so far out of what is shown. Nothing is deleted: only
   * the point from which messages are listed moves.
   */
  clearInbox(): void {
    const { store } = this.deps;
    const last = store.lastMessageTo(USER);
    if (last) store.setMeta(META_INBOX_CLEARED, String(last.id));
  }

  async toolsInfo(target: string): Promise<ToolsInfo> {
    const state = await this.serial(() => this.requireUp());
    const agent = this.findSession(state, target);
    const config = await this.deps.loadConfig();
    const stored = this.storedRequest(agent);
    const layers = resolveLayers(
      this.sessionRequest(config, stored, this.agentOverrides(agent.id)),
      this.roleContext(),
    );
    const chain = [...layers.chain].reverse();
    // Every target says where its file is: one is in the repository, the other is the user's own.
    const files: ToolsInfo["files"] = chain.map(({ name, source }, index) => ({
      label:
        `Role ${name}  (${scopeLabel(source)}` +
        (index === 0 ? ")" : `; ${chain[0]?.name} starts from it; changes both)`),
      file: { kind: "role", name, source },
    }));
    files.push({
      label: "[defaults] in the project's config.toml  (every role without its own value)",
      file: { kind: "defaults" },
    });
    files.push({
      label: "Personal defaults  (your config.toml, for every project; the project's values win)",
      file: { kind: "defaults", source: "user" },
    });
    const view = toolView(layers.caps, layers.origins, await this.toolSources(config, agent.id));
    // An allow list gets the Skill tool by itself when the role lists skills.
    const skill = view.tools.find((tool) => tool.name === "Skill");
    if (skill && view.mode === "only" && (layers.caps.skills?.length ?? 0) > 0) {
      skill.on = true;
      skill.fixed = "needed for its skills";
    }
    return {
      agent: this.ref(agent),
      view,
      files,
      outOfDate: this.differs(agent, config).kind !== "unchanged",
    };
  }

  private async toolSources(config: Config, agentId: string): Promise<ToolSources> {
    const project = this.projectMcpServers();
    const servers: Record<string, unknown> = { ...project, ...config.mcp };
    const ask =
      this.deps.listTools ??
      ((server: unknown) => listServerTools(server, { cwd: this.deps.projectRoot, env: this.env }));
    const serverTools: Record<string, string[] | null> = {};
    await Promise.all(
      Object.entries(servers).map(async ([name, server]) => {
        const key = JSON.stringify(server);
        const known = this.serverTools.get(key);
        if (known && this.now() - known.at < TOOLS_TTL_MS) {
          serverTools[name] = known.tools;
          return;
        }
        const tools = await ask(server).catch(() => null);
        this.serverTools.set(key, { at: this.now(), tools });
        serverTools[name] = tools;
      }),
    );
    return {
      projectServers: Object.keys(project),
      catalogue: Object.keys(config.mcp),
      serverTools,
      seen: this.deps.store.toolsUsed(agentId),
    };
  }

  /**
   * Saves what was switched in the tools dialog: for one session, for its role until the
   * workspace stops, or into a file. The first two also bring the session up to date; a save
   * into a file leaves the running sessions alone and says which ones are now behind.
   */
  async saveTools(request: ToolsSaveRequest): Promise<ToolsSaveResult> {
    return this.serial(async () => {
      const state = await this.requireUp();
      const agent = this.findSession(state, request.target);
      const config = await this.deps.loadConfig();
      const ctx = this.roleContext();
      const stored = this.storedRequest(agent);
      const sources = { catalogue: Object.keys(config.mcp) };
      const own = this.agentOverrides(agent.id);

      if (request.scope === "file") {
        const file = request.file ?? { kind: "defaults" as const };
        const base =
          file.kind === "defaults"
            ? this.ownDefaults(file.source)
            : resolveLayers({ config, role: file.name }, ctx).caps;
        const delta = applyToolChanges(base, request.changes, sources);
        if (Object.keys(delta).length === 0) {
          return {
            applied: "unchanged",
            behind: [],
            note: `${describeTarget(file)} already says so.`,
          };
        }
        const version = saveValues(file, delta, "tools dialog", ctx, new Date(this.now()));
        this.behind.at = 0;
        const after = await this.deps.loadConfig();
        const behind = state.agents
          .concat(state.main)
          .filter((session) => this.differs(session, after).kind !== "unchanged");
        const reached = applyToolChanges(
          resolveLayers(this.sessionRequest(after, stored, own), ctx).caps,
          request.changes,
          sources,
        );
        return {
          applied: "unchanged",
          version: version.n,
          behind: behind.map((session) => this.ref(session)),
          note:
            Object.keys(reached).length > 0 && !behind.some((session) => session.id === agent.id)
              ? `This does not reach ${agent.name}: a nearer setting decides these values for it.`
              : undefined,
        };
      }

      let nextOwn = own;
      let nextRun: Record<string, Capabilities> | undefined;
      if (request.scope === "run") {
        if (!stored.role) throw new WorkspaceError(`${agent.name} has no role to save this for.`);
        const run = this.roleRun();
        const base = resolveLayers(
          { config, role: stored.role, roleRun: run[stored.role] },
          ctx,
        ).caps;
        const delta = applyToolChanges(base, request.changes, sources);
        nextRun = { ...run, [stored.role]: layerCapabilities(run[stored.role] ?? {}, delta) };
        // Where this session has a value of its own for the same list, that one decides for
        // it, so the change is made there as well.
        const mine = resolveLayers(
          { ...this.sessionRequest(config, stored, own), roleRun: nextRun[stored.role] },
          ctx,
        ).caps;
        nextOwn = layerCapabilities(own, applyToolChanges(mine, request.changes, sources));
      } else {
        const base = resolveLayers(this.sessionRequest(config, stored, own), ctx).caps;
        nextOwn = layerCapabilities(own, applyToolChanges(base, request.changes, sources));
      }

      // Worked out before anything is stored, so a refused or postponed change leaves no trace.
      const wanted = resolveSession(
        {
          ...this.sessionRequest(config, stored, nextOwn),
          roleRun:
            nextRun && stored.role ? nextRun[stored.role] : this.roleRun()[stored.role ?? ""],
        },
        ctx,
      );
      const restart = this.differs(agent, config, wanted).kind === "restart";
      const busy = isBusy(agent);
      if (restart && !request.when && (busy || agent.kind === "main")) {
        return { applied: "ask", reason: busy ? "working" : "main", behind: [] };
      }
      const previousRun = this.deps.store.getMeta(META_ROLE_RUN);
      if (nextRun) this.deps.store.setMeta(META_ROLE_RUN, JSON.stringify(nextRun));
      this.deps.store.setOverrides(agent.id, JSON.stringify(nextOwn));
      this.behind.at = 0;
      let applied: Applied;
      try {
        applied = await this.bringUpToDate(agent, config, request.when);
      } catch (error) {
        // The session could not be changed, so what was saved for it is taken back.
        this.deps.store.setMeta(META_ROLE_RUN, previousRun);
        this.deps.store.setOverrides(agent.id, JSON.stringify(own));
        this.behind.at = 0;
        throw error;
      }
      const others = nextRun
        ? state.agents.filter(
            (other) => other.id !== agent.id && this.differs(other, config).kind !== "unchanged",
          )
        : [];
      return {
        applied,
        behind: others.map((session) => this.ref(session)),
        note:
          others.length > 0
            ? `Running with the old setup: ${others.map((other) => other.name).join(", ")}.`
            : undefined,
      };
    });
  }

  /** Brings running sessions in line with their files and saved values. */
  refresh(request: RefreshRequest): Promise<RefreshResult> {
    return this.serial(async () => {
      const state = await this.requireUp();
      const config = await this.deps.loadConfig();
      const results: RefreshResult["results"] = [];
      for (const target of request.targets) {
        let name = target;
        try {
          const agent = this.findSession(state, target);
          name = agent.name;
          results.push({
            name,
            applied: await this.bringUpToDate(agent, config, request.when ?? "turn-end"),
          });
        } catch (error) {
          results.push({ name, applied: "unchanged", error: (error as Error).message });
        }
      }
      this.behind.at = 0;
      return { results };
    });
  }

  /** Restarts a session with its conversation, whether or not anything changed for it. */
  restart(target: string, when: RestartWhen = "now"): Promise<Applied> {
    return this.serial(async () => {
      const agent = this.findSession(await this.requireUp(), target);
      if (when === "turn-end" && isBusy(agent)) {
        this.deps.store.setPendingRestart(agent.id, true);
        return "pending";
      }
      await this.restartNow(agent.id);
      return "restarted";
    });
  }

  /** Applies whatever a session is behind on. Called inside the queue. */
  private async bringUpToDate(
    agent: AgentInfo,
    config: Config,
    when: RestartWhen | undefined,
  ): Promise<Applied> {
    const difference = this.differs(agent, config);
    if (difference.kind === "unchanged") return "unchanged";
    if (difference.kind === "live") {
      // The session keeps running as it was started; its hook refuses what was taken away.
      const before = parseJson<string[]>(this.deps.store.getBlocked(agent.id)) ?? [];
      const back = before.filter((name) => !difference.blocks.includes(name));
      this.setBlocks(agent.id, difference.blocks);
      if (back.length > 0) {
        // It was told these were switched off, and would not try them again by itself.
        this.messaging.send(
          USER,
          agent.name,
          `${APP_NAME}: you can use ${back.join(", ")} again in this session. No reply is needed.`,
        );
      }
      this.capabilities.delete(agent.id);
      return "live";
    }
    if (when === "turn-end" && isBusy(agent)) {
      this.deps.store.setPendingRestart(agent.id, true);
      return "pending";
    }
    await this.restartNow(agent.id);
    return "restarted";
  }

  private profileOf(config: Config, stored: StoredRequest): ResolvedProfile {
    return resolveProfile(
      config,
      {
        agentProfile: stored.profile,
        workspaceProfile: this.deps.store.getMeta(META_PROFILE) ?? undefined,
      },
      this.env,
    );
  }

  /**
   * Starts a session again in its own pane, from the files as they are now and with the same
   * conversation. It keeps its id, its name and its place. Called inside the queue.
   */
  private async restartNow(agentId: string): Promise<void> {
    const { store } = this.deps;
    const row = store.getRunning(agentId);
    if (!row) return;
    const config = await this.deps.loadConfig();
    const stored = this.storedRequest(row);
    const profile = this.profileOf(config, stored);
    const session = this.resolve(
      row.name,
      this.sessionRequest(config, stored, this.agentOverrides(agentId)),
    );
    // A session that never had a prompt has no conversation to resume, and the Claude command
    // exits when asked to. It is started afresh under a new session id instead.
    const resume = store.hadTurn(agentId);
    const sessionId = resume ? row.sessionId : this.newId();
    const launch = this.deps.provider.buildLaunch({
      profile,
      sessionId,
      resume,
      name: row.name,
      session,
      ...this.sessionFiles(agentId, row.name, session, profile),
    });
    await respawnPane(this.deps.run, {
      pane: row.paneId,
      cwd: this.deps.projectRoot,
      command: {
        argv: launch.argv,
        env: { ...launch.env, ...this.paneEnv(agentId) },
        title: row.name,
      },
    });
    // Only now: a restart that could not be made stays pending and is tried at the next turn end.
    store.setPendingRestart(agentId, false);
    if (!resume) store.setSessionId(agentId, sessionId);
    store.setLaunch(agentId, JSON.stringify(session));
    this.setBlocks(agentId, []);
    store.setActivity(agentId, "starting", null, this.now());
    store.addEvent({ agentId, at: this.now(), event: "Restart", summary: null });
    this.capabilities.set(agentId, summarizeSession(session));
    this.telemetry.delete(agentId);
    this.behind.at = 0;
    if (!resume) {
      // Started afresh, it gets its task again: the first start never took it up.
      if (row.task) this.awaitTask(agentId);
      return;
    }
    // The model still remembers the tools it had before, so it is told what it has now, once
    // the new process reports in.
    // Exactly what the launch gives it: the Skill tool a role with skills gets, and every
    // server in its MCP file, not only the ones its role lists by name.
    const skills = (session.skills?.length ?? 0) > 0 && !session.tools?.includes("Skill");
    const tools = session.tools
      ? `only ${[...session.tools, ...(skills ? ["Skill"] : [])].join(", ")}`
      : session.denyTools.length > 0
        ? `all except ${session.denyTools.join(", ")}`
        : "all";
    const servers = [
      APP_NAME,
      ...new Set([...Object.keys(this.projectMcpServers(session)), ...Object.keys(session.mcp)]),
    ];
    const lines = [
      `built-in tools: ${tools}`,
      `MCP servers: ${servers.join(", ")} (the ${APP_NAME} tools work as before)`,
      ...(session.deny.length > 0 ? [`refused: ${session.deny.join(", ")}`] : []),
    ];
    this.notes.set(
      agentId,
      `${APP_NAME} restarted this session with changed settings; the conversation was kept. ` +
        `What you have now: ${lines.join("; ")}. Tools you remember from before may be gone. ` +
        "If you were in the middle of something, carry on with it; otherwise no reply is needed.",
    );
  }

  /** Those of the given role names that have no role file. Reads files only, so it does not queue. */
  unknownRoles(roles: string[]): string[] {
    const ctx = this.roleContext();
    return [...new Set(roles)].filter((role) => findRole(role, ctx) === null);
  }

  /** The skill a spawn request names, from the places a role's skills are looked for. */
  private skillToRun(name: string): ResolvedSkill {
    const skill = NAME_PATTERN.test(name) ? findSkill(name, this.roleContext()) : null;
    if (!skill) {
      throw new WorkspaceError(
        `Unknown skill "${name}": there is no ${name}/${SKILL_FILE} in the project's or the workspace's skill folders. A built-in skill has no file and cannot be started this way.`,
      );
    }
    return skill;
  }

  /** The role a skill names for its agent, when the workspace has a role of that name. */
  private roleOfSkill(skill: ResolvedSkill): string | undefined {
    const ctx = this.roleContext();
    const text = (ctx.files ?? diskFiles).read(join(skill.path, SKILL_FILE)) ?? "";
    const wanted = skillHeader(text).agent;
    if (wanted === undefined) return undefined;
    try {
      return findRole(wanted, ctx) ? wanted : undefined;
    } catch {
      // A role file that does not parse: the session starts without a role instead.
      return undefined;
    }
  }

  private roleContext(): RoleContext {
    return { projectRoot: this.deps.projectRoot, env: this.env, files: this.deps.roleFiles };
  }

  /**
   * What a new session is started with. Refuses a session whose role asks for something this
   * machine does not have, so it never starts with less than its role says.
   */
  private resolve(name: string, request: Parameters<typeof resolveSession>[0]): ResolvedSession {
    const ctx = this.roleContext();
    // A role changed in an editor gets its version in the history before it is used.
    if (!this.deps.roleFiles) noticeEdits(ctx);
    const session = resolveSession(request, ctx);
    const missing = missingOnThisMachine(session, ctx);
    if (missing.length > 0) {
      throw new WorkspaceError(`Cannot start "${name}": ${missing.join("; ")}.`);
    }
    return session;
  }

  /** The short form of what a session was started with, kept in memory after the first look. */
  private capabilitiesOf(agentId: string): SessionSummary | null {
    const known = this.capabilities.get(agentId);
    if (known !== undefined) return known;
    let summary: SessionSummary | null = null;
    const stored = this.deps.store.getLaunch(agentId);
    if (stored) {
      try {
        summary = summarizeSession(JSON.parse(stored) as ResolvedSession);
        // What was switched off while it ran is refused like a deny rule, and shown as one.
        const blocks = parseJson<string[]>(this.deps.store.getBlocked(agentId)) ?? [];
        if (blocks.length > 0) summary = { ...summary, deny: [...summary.deny, ...blocks] };
      } catch {
        summary = null;
      }
    }
    this.capabilities.set(agentId, summary);
    return summary;
  }

  /**
   * Writes the per-session files that connect a session to this daemon and give it what its
   * role lists: settings (hooks, statusline, mailbox, permission rules), the MCP config (the dwa
   * tools and the role's servers), the text appended to its system prompt, and a plugin holding
   * the skills dwa hands to this session.
   */
  private sessionFiles(
    agentId: string,
    name: string,
    session: ResolvedSession,
    profile: ResolvedProfile,
  ) {
    const { provider, selfArgv, runDir } = this.deps;
    const self = selfArgv.map(tmuxQuote).join(" ");
    const write =
      this.deps.writeFile ??
      ((file, content) => {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
      });
    const dir = join(runDir, "agents", agentId);
    const settingsPath = join(dir, "settings.json");
    const mcpConfigPath = join(dir, "mcp.json");
    const systemPromptPath = join(dir, "prompt.md");
    write(
      settingsPath,
      JSON.stringify(
        provider.buildSettings(
          {
            hook: `${self} hook`,
            statusline: `${self} statusline`,
            mailbox: `${self} mailbox`,
          },
          session,
          { personalMemory: this.personalMemory(profile) },
        ),
        null,
        2,
      ),
    );
    const [command = "", ...args] = selfArgv;
    write(
      mcpConfigPath,
      JSON.stringify(
        provider.buildMcpConfig(
          { command, args: [...args, "mcp"], env: this.paneEnv(agentId) },
          session,
          { ...this.pluginMcpServers(session), ...this.projectMcpServers(session) },
        ),
        null,
        2,
      ),
    );
    // The list of roles is made here and not kept with the session, so a restart gets the
    // roles as they are now and a role that changes does not make this session out of date.
    const roleGuide = session.roleList
      ? roleGuidePrompt(guideEntries(this.roleContext(), { except: session.role }))
      : undefined;
    const skillGuide = session.agentSkills
      ? skillGuidePrompt(skillGuideEntries(session.agentSkills, this.roleContext()))
      : undefined;
    write(systemPromptPath, provider.systemPrompt(name, session, { roleGuide, skillGuide }));
    // Read by the session's hook on every call of the Skill tool (`skillVerdict`).
    write(join(dir, SKILLS_FILE), JSON.stringify(session.allowedSkills));
    return {
      settingsPath,
      mcpConfigPath,
      systemPromptPath,
      skillPluginPath: this.skillPlugin(dir, session, write),
    };
  }

  /**
   * Skills from the dwa skill folders reach a session as a plugin made for it: a manifest and
   * a link to each skill's directory. Project skills need none of this; Claude Code loads them.
   * Returns the plugin's directory, or nothing when the session has no such skill.
   */
  private skillPlugin(
    dir: string,
    session: ResolvedSession,
    write: (path: string, content: string) => void,
  ): string | undefined {
    const skills = (session.skills ?? []).filter((skill) => skill.source !== "project");
    const plugin = join(dir, "skills-plugin");
    // Links from an earlier start of this session would keep a skill its role dropped.
    if (!this.deps.linkDir) rmSync(plugin, { recursive: true, force: true });
    if (skills.length === 0) return undefined;
    const link =
      this.deps.linkDir ??
      ((target, path) => {
        mkdirSync(dirname(path), { recursive: true });
        // A restart writes the session's files again; the link may be there from the start.
        rmSync(path, { force: true });
        symlinkSync(target, path, "dir");
      });
    write(
      join(plugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: APP_NAME,
        version: pkg.version,
        description: "Skills for this session",
      }),
    );
    for (const skill of skills) link(skill.path, join(plugin, "skills", skill.name));
    return plugin;
  }

  /**
   * The personal instruction files to keep out of a session: `CLAUDE.md` in every place the
   * profile's Claude config may be. Skipping the user's settings does not skip this file.
   */
  private personalMemory(profile: ResolvedProfile): string[] {
    const dirs = [
      profile.configDir,
      profile.env.CLAUDE_CONFIG_DIR,
      this.env.CLAUDE_CONFIG_DIR,
      (this.deps.wrapperConfigDir ?? wrapperConfigDir)(profile.command, this.env),
      join(homedir(), ".claude"),
    ];
    const files = dirs.flatMap((configDir) => (configDir ? [join(configDir, "CLAUDE.md")] : []));
    return [...new Set(files)];
  }

  /**
   * The MCP servers the session's plugins bring. A plugin's own servers are not started when
   * only the generated MCP config counts, so they are copied into it.
   */
  private pluginMcpServers(session: ResolvedSession): Record<string, unknown> {
    const files = this.deps.roleFiles ?? diskFiles;
    const servers: Record<string, unknown> = {};
    for (const plugin of session.plugins) {
      const text = files.read(join(plugin.path, ".mcp.json"));
      if (text === null) continue;
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder plugins use for their own directory
      Object.assign(servers, mcpServers(text.replaceAll("${CLAUDE_PLUGIN_ROOT}", plugin.path)));
    }
    return servers;
  }

  /**
   * The MCP servers the project defines for everyone in `.mcp.json`. They are part of the
   * project, so a session has them next to what its role lists, unless `off_mcp` names them.
   */
  private projectMcpServers(session?: ResolvedSession): Record<string, unknown> {
    const files = this.deps.roleFiles ?? diskFiles;
    const text = files.read(join(this.deps.projectRoot, ".mcp.json"));
    const servers = text === null ? {} : mcpServers(text);
    // A session stored before `off_mcp` existed has no list.
    const off = session?.offMcp ?? [];
    return Object.fromEntries(Object.entries(servers).filter(([name]) => !off.includes(name)));
  }

  private paneEnv(agentId?: string): Record<string, string> {
    const env: Record<string, string> = {
      DWA_PROJECT: this.deps.projectRoot,
      DWA_SOCKET: this.deps.socketPath,
    };
    if (agentId) env.DWA_AGENT_ID = agentId;
    return env;
  }

  private uiPane(view: string, title: string): PaneCommand {
    return { argv: [...this.deps.selfArgv, "ui", view], env: this.paneEnv(), title };
  }
}
