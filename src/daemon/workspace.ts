import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Provider } from "../providers/provider.ts";
import { type Config, resolveProfile } from "../shared/config.ts";
import type {
  AgentInfo,
  AgentKind,
  HookRequest,
  SpawnRequest,
  StatuslineRequest,
  Telemetry,
  UpRequest,
  WorkspaceState,
} from "../shared/protocol.ts";
import { tmuxQuote } from "../tmux/conf.ts";
import type { TmuxRunner } from "../tmux/driver.ts";
import {
  createWorkspace,
  focusPane,
  hasSession,
  killPane,
  listPanes,
  openUnderMain,
  type PaneCommand,
  type PaneStatus,
  returnToPool,
  spawnPoolWindow,
} from "../tmux/layout.ts";
import { parseStatusline, reduceHook, snippet } from "./activity.ts";
import type { AgentRow, Store } from "./db.ts";

/** An error caused by the request (unknown agent, workspace not up), reported to the caller as is. */
export class WorkspaceError extends Error {}

const NAME_PATTERN = /^[A-Za-z0-9][\w.-]{0,39}$/;
const META_PROFILE = "workspace_profile";

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
  env?: Record<string, string | undefined>;
  newId?: () => string;
  now?: () => number;
}

/** The application service behind the CLI, the UI panes and (later) the MCP tools. */
export class Workspace {
  private queue: Promise<unknown> = Promise.resolve();
  /** Latest statusline figures per agent. Refreshed every few seconds, so not persisted. */
  private readonly telemetry = new Map<string, Telemetry>();
  private readonly env: Record<string, string | undefined>;
  private readonly newId: () => string;
  private readonly now: () => number;

  constructor(private readonly deps: WorkspaceDeps) {
    this.env = deps.env ?? process.env;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.now = deps.now ?? Date.now;
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
      this.deps.store.setMeta(META_PROFILE, request.profile ?? null);

      const id = this.newId();
      const sessionId = this.newId();
      const launch = this.deps.provider.buildLaunch({
        profile,
        sessionId,
        name: "main",
        settingsPath: this.writeSettings(id),
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
      });
      this.insert({ id, kind: "main", name: "main", profile: profile.name, sessionId }, panes.main);
      return this.snapshot();
    });
  }

  spawn(request: SpawnRequest = {}): Promise<AgentInfo> {
    return this.serial(async () => {
      const state = await this.requireUp();
      const name = this.uniqueName(request.name ?? request.role ?? "agent", state);
      const config = await this.deps.loadConfig();
      const profile = resolveProfile(
        config,
        {
          agentProfile: request.profile,
          workspaceProfile: this.deps.store.getMeta(META_PROFILE) ?? undefined,
        },
        this.env,
      );

      const id = this.newId();
      const sessionId = this.newId();
      const launch = this.deps.provider.buildLaunch({
        profile,
        sessionId,
        name,
        role: request.role,
        task: request.task,
        settingsPath: this.writeSettings(id),
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
          role: request.role,
          task: request.task,
        },
        paneId,
      );
      return { ...row, telemetry: null, open: false };
    });
  }

  /** Shows an agent's session under main. `target` is a name, an id or a 1-based list position. */
  open(target: string): Promise<AgentInfo> {
    return this.serial(async () => {
      const state = await this.requireUp();
      const agent = this.find(state, target);
      if (!agent.open) {
        const current = state.agents.find((other) => other.open);
        if (current) {
          await returnToPool(this.deps.run, { agent: current.paneId, name: current.name });
        }
        await openUnderMain(this.deps.run, { main: state.main.paneId, agent: agent.paneId });
      }
      await focusPane(this.deps.run, agent.paneId);
      return { ...agent, open: true };
    });
  }

  /** Sends the open agent back to the pool; main gets the full height again. */
  close(): Promise<void> {
    return this.serial(async () => {
      const state = await this.requireUp();
      const current = state.agents.find((agent) => agent.open);
      if (current) await returnToPool(this.deps.run, { agent: current.paneId, name: current.name });
      await focusPane(this.deps.run, state.main.paneId);
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
      this.deps.store.markStopped(agent.id, this.now());
      return { ...agent, state: "stopped", open: false };
    });
  }

  /** Applies a lifecycle event reported by a session's hook. Unknown or stopped agents are ignored. */
  hook(request: HookRequest): void {
    const { store } = this.deps;
    const row = store.getRunning(request.agentId);
    if (!row) return;
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
  }

  /** Stores the figures from a session's statusline. */
  statusline(request: StatuslineRequest): void {
    if (!this.deps.store.getRunning(request.agentId)) return;
    const telemetry = parseStatusline(request.data, this.now());
    if (telemetry) this.telemetry.set(request.agentId, telemetry);
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
    for (const row of this.deps.store.running()) this.deps.store.markStopped(row.id, this.now());
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
        store.markStopped(row.id, this.now());
        this.telemetry.delete(row.id);
        continue;
      }
      live.push({
        ...row,
        telemetry: this.telemetry.get(row.id) ?? null,
        open: row.kind === "agent" && pane.inWorkspace,
      });
    }

    return {
      projectRoot,
      up,
      main: live.find((agent) => agent.kind === "main") ?? null,
      agents: live.filter((agent) => agent.kind === "agent"),
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
    };
    this.deps.store.insertAgent(row);
    return row;
  }

  /** Writes the per-session settings file that points the session's hooks at this daemon. */
  private writeSettings(agentId: string): string {
    const self = this.deps.selfArgv.map(tmuxQuote).join(" ");
    const settings = this.deps.provider.buildSettings({
      hook: `${self} hook`,
      statusline: `${self} statusline`,
    });
    const path = join(this.deps.runDir, "agents", agentId, "settings.json");
    const write =
      this.deps.writeFile ??
      ((file, content) => {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
      });
    write(path, JSON.stringify(settings, null, 2));
    return path;
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
