// Self-heal: a session that finds its role does not fit, or lacks a tool, a skill, an MCP server
// or a permission, reports it; a session of the built-in selfheal role looks into the reports
// about one role and proposes a change; the user decides; and only then does this daemon write
// the change and bring the reporters in line with it. No agent ever writes a role file here.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { CAPABILITY_KEYS, type Capabilities } from "../shared/capabilities.ts";
import { type Config, mergeConfig, parseConfig } from "../shared/config.ts";
import { APP_NAME } from "../shared/constants.ts";
import { diffLines } from "../shared/history.ts";
import { projectConfigPath, reportsDir, userConfigPath } from "../shared/paths.ts";
import type {
  FixDecision,
  FixFile,
  FixLine,
  FixMemory,
  FixResult,
  FixSummary,
  FixView,
  QuestionInfo,
} from "../shared/protocol.ts";
import {
  adoptRole,
  builtinRole,
  describeTarget,
  editValues,
  type FileTarget,
  noticeEdits,
  type RoleChanges,
  requireRole,
  saveValues,
} from "../shared/role-edit.ts";
import {
  diskFiles,
  findRole,
  missingOnThisMachine,
  projectSkillNames,
  type RoleContext,
  type RoleFiles,
  resolveLayers,
  resolveSession,
  roleKind,
} from "../shared/roles.ts";
import {
  bugReportText,
  type Change,
  type ChangeInput,
  describeChange,
  expandChanges,
  formatFile,
  maskSecrets,
  NO_REPORT_ROLES,
  SELFHEAL_ROLE,
  sessionOnlyPossible,
  slug,
  valuesAfter,
  warningOf,
  widens,
} from "../shared/selfheal.ts";
import type { CaseRow, ProposalRow, ReportRow, ReportState, Store } from "./db.ts";
import { WorkspaceError } from "./errors.ts";
import { USER, WORKSPACE } from "./messaging.ts";
import type { SessionSetup, Workspace } from "./workspace.ts";

/** How long a waiting reporter has to fetch its outcome before it is sent as a message. */
const SEEN_FALLBACK_MS = 8000;
/** A selfheal session is ended a moment after its case, so its last tool call can return. */
const STOP_DELAY_MS = 2000;

export interface SelfhealDeps {
  store: Store;
  workspace: Workspace;
  loadConfig: () => Promise<Config>;
  /** Where the personal folder is looked up; the process's own environment when left out. */
  env?: Record<string, string | undefined>;
  /** Role files to read instead of the disk's, in tests. */
  files?: RoleFiles;
  schedule?: (callback: () => void, ms: number) => void;
  now?: () => number;
}

/** What `report_gap` answers at once. */
export interface ReportReceipt {
  id: number;
  /** The session that looks into it. */
  selfheal: string;
  /** Whether that session was already at work on this role. */
  joined: boolean;
}

/** Where a report stands, for the reporter that waits for it. */
export interface ReportStatus {
  id: number;
  state: ReportState;
  outcome?: string;
  /** A question the selfheal session put to the reporter, which has to be answered first. */
  question?: QuestionInfo;
}

/** A file of a proposal with its changes worked out against the file as it is now. */
interface FilePlan {
  target: FileTarget;
  label: string;
  path: string;
  adopt: boolean;
  before: string;
  after: string;
  values: RoleChanges;
}

function hash(texts: string[]): string {
  return createHash("sha256").update(texts.join("\u0000")).digest("hex").slice(0, 16);
}

function fileKey(file: FileTarget): string {
  return formatFile(file);
}

function list(values: readonly string[] | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "none";
}

function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 16);
}

export class Selfheal {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly schedule: (callback: () => void, ms: number) => void;
  private readonly now: () => number;

  constructor(private readonly deps: SelfhealDeps) {
    this.schedule = deps.schedule ?? ((callback, ms) => void setTimeout(callback, ms));
    this.now = deps.now ?? Date.now;
    // Called inside the workspace's tmux queue: the work is only put in line here.
    deps.workspace.onAgentEvent((event) => {
      if (event.type !== "stopped") return;
      void this.serial(() => this.gone(event.agentId)).catch((error) => console.error(error));
    });
  }

  private get ctx(): RoleContext {
    return {
      projectRoot: this.deps.workspace.projectRoot,
      env: this.deps.env,
      files: this.deps.files,
    };
  }

  /** Reports, proposals and decisions must not interleave, so each runs after the one before. */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** The open case of the selfheal session that calls; refuses everyone else. */
  private requireCase(byId: string): CaseRow {
    const { store } = this.deps;
    const agent = byId === USER ? null : store.getRunning(byId);
    const found = agent?.role === SELFHEAL_ROLE ? store.openCaseOfAgent(agent.id) : null;
    if (!found) {
      throw new WorkspaceError(
        `Only the ${SELFHEAL_ROLE} session that ${APP_NAME} started for a report can do this, and only while its reports are open. To report a gap in your own setup, use report_gap.`,
      );
    }
    return found;
  }

  /**
   * Takes a report of a gap: from a session about itself, or from the user about a session or
   * a role (`target`). One selfheal session looks into all reports about one role, so a report
   * either starts that session or joins it.
   */
  report(input: {
    from: string;
    target?: string;
    what: string;
    tried?: string;
    blocking?: boolean;
  }): Promise<ReportReceipt> {
    return this.serial(async () => {
      const { store, workspace } = this.deps;
      const blocking = input.blocking === true && input.from !== USER;
      let setup: SessionSetup | null = null;
      let roleKey = "";
      let reporterName = "the user";
      if (input.from === USER) {
        const target = input.target ?? "";
        if (target === "") throw new WorkspaceError("Say which session or role this is about.");
        const state = await workspace.state();
        const session = [...(state.main ? [state.main] : []), ...state.agents].find(
          (agent) =>
            agent.name === target ||
            agent.id === target ||
            (target === "main" && agent.kind === "main"),
        );
        if (session) setup = await workspace.setup(session.id);
        else if (findRole(target, this.ctx)) roleKey = target;
        else
          throw new WorkspaceError(`There is no running session and no role called "${target}".`);
      } else {
        setup = await workspace.setup(input.from);
        if (!setup) throw new WorkspaceError("Only a running session can report a gap.");
        reporterName = setup.row.name;
        if (NO_REPORT_ROLES.includes(setup.row.role ?? "") || store.openCaseOfAgent(setup.row.id)) {
          throw new WorkspaceError(
            "This session does not report gaps: tell the user what you could not do instead.",
          );
        }
      }
      if (setup) roleKey = setup.layers.role ?? "";

      const existing = store.openReportBy(input.from, roleKey);
      if (existing) {
        // The same reporter about the same role: its first report stands, it only waits or not.
        store.setReportBlocking(existing.id, blocking);
        const open = store.getCase(existing.caseId);
        return {
          id: existing.id,
          selfheal: (open && store.getAgentName(open.agentId)) ?? SELFHEAL_ROLE,
          joined: true,
        };
      }

      let found = store.openCaseOf(roleKey);
      // A case whose session is gone carries on only while a proposal of it waits for the user.
      if (found && !store.getRunning(found.agentId) && !this.pending(found.id)) {
        this.cancel(found, "The session that looked into it ended before it was settled.");
        found = null;
      }
      const joined = found !== null;
      let caseId: number;
      let selfheal: string;
      if (found) {
        caseId = found.id;
        selfheal = store.getAgentName(found.agentId) ?? SELFHEAL_ROLE;
      } else {
        if (workspace.unknownRoles([SELFHEAL_ROLE]).length > 0) {
          throw new WorkspaceError(
            `There is no role "${SELFHEAL_ROLE}" here, which looks into reports. Tell the user what you could not do instead.`,
          );
        }
        const about = roleKey ? `the role "${roleKey}"` : "sessions without a role";
        const agent = await workspace.spawn({
          role: SELFHEAL_ROLE,
          name: `selfheal-${roleKey || "defaults"}`,
          task: `A report about ${about} came in. Call selfheal_context first: it holds the reports and everything you need to look into them. Then settle them with answer_report, propose_fix or file_bug.`,
        });
        caseId = store.addCase(roleKey, agent.id, this.now());
        selfheal = agent.name;
      }
      const id = store.addReport({
        caseId,
        reporterId: input.from,
        reporterName,
        subjectId: setup?.row.id ?? null,
        roleKey,
        what: input.what,
        tried: input.tried?.trim() ? input.tried : null,
        blocking,
        evidence: setup ? JSON.stringify(this.evidence(setup)) : null,
        createdAt: this.now(),
      });
      workspace.feed.add({
        kind: "selfheal",
        agentId: input.from === USER ? undefined : input.from,
        agentName: reporterName,
        refName: selfheal,
        title: `reported a gap${roleKey ? ` in role ${roleKey}` : ""}`,
        body: input.what,
      });
      if (joined && found && store.getRunning(found.agentId)) {
        workspace.messaging.send(
          WORKSPACE,
          selfheal,
          `Report #${id} from ${reporterName} joined your case. Call selfheal_context again before you settle anything.`,
        );
      }
      return { id, selfheal, joined };
    });
  }

  /** What a session was started with and was refused, without credentials, for the record. */
  private evidence(setup: SessionSetup): unknown {
    return maskSecrets({
      name: setup.row.name,
      role: setup.layers.role ?? null,
      launch: setup.launch ? { ...setup.launch, prompt: undefined } : null,
      request: setup.stored,
      own: setup.own,
      blocked: setup.blocked,
      refusals: this.deps.store.refusals(setup.row.id).map((refusal) => ({
        at: refusal.at,
        source: refusal.source,
        tool: refusal.tool,
        detail: refusal.detail,
      })),
    });
  }

  private pending(caseId: number): ProposalRow | null {
    return (
      this.deps.store.pendingProposals().find((proposal) => proposal.caseId === caseId) ?? null
    );
  }

  /**
   * Where a report stands, for the reporter that waits. Fetching a settled report counts as
   * having been told, so the outcome is not sent as a message as well.
   */
  status(id: number, byId: string): ReportStatus {
    const { store, workspace } = this.deps;
    const report = store.getReport(id);
    if (!report || report.reporterId !== byId) {
      throw new WorkspaceError(`You have no report #${id}.`);
    }
    if (report.state !== "open") {
      store.markReportSeen(id, this.now());
      return { id, state: report.state, outcome: report.outcome ?? "" };
    }
    const found = store.getCase(report.caseId);
    const question = found
      ? workspace.messaging
          .openQuestions()
          .find((asked) => asked.fromId === found.agentId && asked.toId === byId)
      : undefined;
    return { id, state: "open", ...(question ? { question } : {}) };
  }

  /**
   * Whether a reporter waits for its report. One that does fetches the outcome itself; one that
   * does not is told by message when it comes.
   */
  waiting(id: number, byId: string, on: boolean): void {
    const report = this.deps.store.getReport(id);
    if (report && report.reporterId === byId) this.deps.store.setReportBlocking(id, on);
  }

  /** Everything the selfheal session needs to look into its reports, as one text. */
  async context(byId: string): Promise<string> {
    const { store } = this.deps;
    const found = this.requireCase(byId);
    const config = await this.deps.loadConfig();
    const ctx = this.ctx;
    const files = ctx.files ?? diskFiles;
    const reports = store.reportsOf(found.id).filter((report) => report.state === "open");
    const out: string[] = [
      found.roleKey
        ? `# Reports about the role "${found.roleKey}"`
        : "# Reports about sessions without a role",
      "",
    ];
    for (const report of reports) {
      out.push(
        `## Report #${report.id} from ${report.reporterName}${report.blocking ? " (waits for the outcome)" : " (carries on meanwhile)"}`,
        "",
        `What: ${report.what}`,
      );
      if (report.tried) out.push(`Tried: ${report.tried}`);
      const setup = report.subjectId ? await this.deps.workspace.setup(report.subjectId) : null;
      if (report.subjectId && !setup) out.push("", "The session it is about has ended.");
      if (setup) out.push("", ...this.describeSetup(setup, report));
      out.push("");
    }
    if (reports.length === 0) out.push("No report is open.", "");

    if (found.roleKey) {
      const layers = resolveLayers({ config, role: found.roleKey }, ctx);
      out.push(`# What a new session of "${found.roleKey}" gets, and from where`, "");
      out.push(...this.describeCaps(layers.caps, layers.origins), "");
      out.push("# The role's files, nearest first", "");
      for (const loaded of [...layers.chain].reverse()) {
        const where =
          loaded.source === "builtin"
            ? `built into ${APP_NAME}; a fix copies it into the project first, and from then on it no longer follows ${APP_NAME}'s own updates`
            : loaded.source === "user"
              ? `personal file ${loaded.path}`
              : `project file ${loaded.path}`;
        out.push(
          `## ${loaded.name} (${where}); in a change: ${loaded.source === "user" ? "personal-role" : "role"}:${loaded.name}`,
          "",
          "```toml",
          (files.read(loaded.path) ?? "").trimEnd(),
          "```",
          "",
        );
      }
    }
    out.push("# [defaults]", "");
    out.push(`In the project's config (defaults): ${JSON.stringify(config.projectDefaults ?? {})}`);
    out.push(
      `In the user's personal config (personal-defaults): ${JSON.stringify(config.userDefaults ?? {})}`,
      "",
    );
    out.push("# What the config and the project offer", "");
    out.push(`MCP servers in the catalogue (key mcp): ${list(Object.keys(config.mcp))}`);
    out.push(`Plugins in the catalogue (key plugins): ${list(Object.keys(config.plugins))}`);
    out.push(`Profiles: ${list(Object.keys(config.profiles))}`);
    out.push(`Skills of the project (key skills): ${list(projectSkillNames(ctx))}`, "");
    const memory = store.memory(found.roleKey);
    if (memory.length > 0) {
      out.push("# Turned down by the user before, for this role", "");
      for (const item of memory) {
        const changes = (JSON.parse(item.changes) as Change[]).map(describeChange).join("; ");
        out.push(`- ${item.summary} (${changes}). The user's reason: ${item.reason}`);
      }
      out.push(
        "",
        "Do not propose the same again: answer the reporter with the user's reason instead.",
        "",
      );
    }
    return out.join("\n");
  }

  private describeCaps(caps: Capabilities, origins: Record<string, string | undefined>): string[] {
    const lines: string[] = [];
    for (const key of CAPABILITY_KEYS) {
      if (caps[key] === undefined) continue;
      lines.push(`- ${key} = ${JSON.stringify(caps[key])}   (from ${origins[key] ?? "?"})`);
    }
    return lines.length > 0 ? lines : ["- nothing is set: the built-in defaults hold"];
  }

  private describeSetup(setup: SessionSetup, report: ReportRow): string[] {
    const { launch } = setup;
    const lines: string[] = [];
    if (launch) {
      lines.push(
        `### What ${setup.row.name} was started with`,
        "",
        `- model ${launch.model ?? "default"}, effort ${launch.effort ?? "default"}, permission mode ${launch.permissionMode ?? "default"}`,
        `- tools: ${launch.tools ? list(launch.tools) : "every built-in tool"}; taken away: ${list(launch.denyTools)}`,
        `- allow rules: ${list(launch.allow)}`,
        `- deny rules: ${list(launch.deny)}`,
        `- MCP servers: ${list(Object.keys(launch.mcp))}; project servers left out: ${list(launch.offMcp)}`,
        `- plugins: ${list(launch.plugins.map((plugin) => plugin.name))}`,
        `- skills the Skill tool takes: ${list(launch.allowedSkills)}`,
        `- memory: ${launch.memory ? "on" : "off"}`,
      );
      if (setup.blocked.length > 0) {
        lines.push(`- switched off by the user since it started: ${list(setup.blocked)}`);
      }
      lines.push("");
    }
    lines.push(`### What ${setup.row.name} would get now, and from where`, "");
    lines.push(...this.describeCaps(setup.layers.caps, setup.layers.origins));
    const refusals = this.deps.store.refusals(setup.row.id).slice(-15);
    lines.push("", "### Calls that did not run (latest last)", "");
    if (refusals.length === 0) {
      lines.push(
        `- none on record. A tool that is not in the session's list at all leaves no trace here; go by what ${report.reporterName} wrote.`,
      );
    }
    for (const refusal of refusals) {
      const how =
        refusal.source === "blocked"
          ? "switched off by the user for this session"
          : refusal.source === "skill"
            ? "a skill the session was not given"
            : refusal.source === "not-run"
              ? "no result followed: refused by the permissions, or interrupted"
              : refusal.source;
      lines.push(
        `- ${clock(refusal.at)} ${refusal.tool}${refusal.detail ? `: ${refusal.detail}` : ""} (${how})`,
      );
    }
    return lines;
  }

  /** The file of a change that names none: the role under repair, or the project's defaults. */
  private fallback(found: CaseRow): FileTarget {
    return found.roleKey ? { kind: "role", name: found.roleKey } : { kind: "defaults" };
  }

  /**
   * Works out each file of a proposal against the file as it is now: its text before and
   * after. Throws when a change no longer fits or gives an invalid file. Writes nothing.
   */
  private async plan(changes: Change[]): Promise<FilePlan[]> {
    const ctx = this.ctx;
    const config = await this.deps.loadConfig();
    const files = ctx.files ?? diskFiles;
    const groups = new Map<string, Change[]>();
    for (const change of changes) {
      groups.set(fileKey(change.file), [...(groups.get(fileKey(change.file)) ?? []), change]);
    }
    const plans: FilePlan[] = [];
    for (const group of groups.values()) {
      const target = (group[0] as Change).file;
      let base: Record<string, unknown>;
      let text: { path: string; before: string } | undefined;
      let adopt = false;
      if (target.kind === "defaults") {
        base = {
          ...((target.source === "user" ? config.userDefaults : config.projectDefaults) ?? {}),
        };
      } else {
        let own: Record<string, unknown>;
        try {
          const entry = requireRole(target, ctx);
          own = Bun.TOML.parse(files.read(entry.path) ?? "") as Record<string, unknown>;
        } catch (error) {
          const builtin = target.source === undefined ? builtinRole(target.name, ctx) : null;
          if (!builtin) throw error;
          // A built-in role is never written to: the change goes into a copy in the project.
          adopt = true;
          const before = files.read(builtin.path) ?? "";
          own = Bun.TOML.parse(before) as Record<string, unknown>;
          text = { path: join(roleKind.dir("project", ctx), `${target.name}.toml`), before };
        }
        base = {
          prompt: own.prompt,
          description: own.description,
          when_to_use: own.when_to_use,
          ...resolveLayers({ config, role: target.name }, ctx).caps,
        };
      }
      const values = valuesAfter(base, group, {
        projectSkills: projectSkillNames(ctx),
      }) as RoleChanges;
      const edit = editValues(target, values, ctx, text);
      plans.push({
        target,
        label: describeTarget(target),
        path: edit.file.path,
        adopt,
        before: edit.before,
        after: edit.after,
        values,
      });
    }
    return plans;
  }

  /**
   * Checks that sessions still start once the plans are written: the roles concerned are
   * resolved with the new texts in the files' places, by the rules a start goes by, and what
   * they ask for has to be on this machine.
   */
  private async check(plans: FilePlan[], roles: string[]): Promise<void> {
    const ctx = this.ctx;
    const files = ctx.files ?? diskFiles;
    const texts = new Map(plans.map((plan) => [plan.path, plan.after]));
    const overlay: RoleContext = {
      ...ctx,
      files: {
        ...files,
        read: (file) => texts.get(file) ?? files.read(file),
        exists: (file) => texts.has(file) || files.exists(file),
        list: (dir) => [
          ...new Set([
            ...files.list(dir),
            ...[...texts.keys()]
              .filter((path) => dirname(path) === dir)
              .map((path) => path.slice(dir.length + 1)),
          ]),
        ],
      },
    };
    let config = await this.deps.loadConfig();
    if (plans.some((plan) => plan.target.kind === "defaults")) {
      const userPath = userConfigPath(this.deps.env);
      const projectPath = projectConfigPath(ctx.projectRoot);
      const read = (path: string) => texts.get(path) ?? files.read(path) ?? "";
      config = mergeConfig(
        parseConfig(read(userPath), userPath, dirname(userPath)),
        parseConfig(read(projectPath), projectPath, ctx.projectRoot),
      );
    }
    const named = plans.flatMap((plan) => (plan.target.kind === "role" ? [plan.target.name] : []));
    for (const role of new Set([...roles.filter(Boolean), ...named])) {
      const session = resolveSession({ config, role }, overlay);
      const missing = missingOnThisMachine(session, overlay);
      if (missing.length > 0) {
        throw new WorkspaceError(
          `A session of "${role}" could not start with this: ${missing.join("; ")}.`,
        );
      }
    }
  }

  /**
   * Takes what the selfheal session wants changed. It is checked as a start would check it and
   * then waits for the user; nothing is written here. A new proposal of a case takes the place
   * of the one that waits.
   */
  propose(
    byId: string,
    input: { summary: string; reason: string; changes: ChangeInput[] },
  ): Promise<{ id: number; lines: string[] }> {
    return this.serial(async () => {
      const { store, workspace } = this.deps;
      const found = this.requireCase(byId);
      const changes = expandChanges(input.changes, this.fallback(found));
      const plans = await this.plan(changes);
      if (plans.every((plan) => plan.before === plan.after)) {
        throw new WorkspaceError(
          "These changes leave every file as it is: the role already says so. If the reporter still lacks it, a nearer setting decides (see where each value comes from), or its session is behind its files.",
        );
      }
      await this.check(plans, [found.roleKey]);
      const id = store.addProposal({
        caseId: found.id,
        summary: input.summary,
        reason: input.reason,
        changes: JSON.stringify(changes),
        createdAt: this.now(),
      });
      const lines = changes.map(describeChange);
      workspace.feed.add({
        kind: "selfheal",
        agentId: byId,
        agentName: store.getAgentName(byId),
        title: `proposes a fix${found.roleKey ? ` for role ${found.roleKey}` : ""}: ${input.summary}`,
        body: [input.reason, "", ...lines.map((line) => `- ${line}`)].join("\n"),
        data: { proposal: id },
      });
      void workspace
        .notify(`${APP_NAME}: a fix waits for your decision (${input.summary})`)
        .catch(() => undefined);
      return { id, lines };
    });
  }

  /** Settles reports without a change: the reporter can do it with what it has, or cannot have it. */
  answer(byId: string, text: string, reportIds?: number[]): Promise<{ settled: number[] }> {
    return this.serial(async () => {
      const found = this.requireCase(byId);
      const open = this.openReports(found.id).filter(
        (report) => !reportIds || reportIds.includes(report.id),
      );
      if (open.length === 0) throw new WorkspaceError("None of these reports is open.");
      for (const report of open) this.settle(report, "answered", text);
      this.closeIfDone(found);
      return { settled: open.map((report) => report.id) };
    });
  }

  /**
   * Writes a report about dwa itself into the project's reports folder, which git does not see,
   * and settles the case's reports with it: no change to a role mends a defect in dwa.
   */
  fileBug(
    byId: string,
    input: { title: string; what: string; steps: string; expected?: string },
  ): Promise<{ path: string }> {
    return this.serial(async () => {
      const { store, workspace } = this.deps;
      const found = this.requireCase(byId);
      const reports = this.openReports(found.id);
      const at = new Date(this.now());
      const dir = reportsDir(workspace.projectRoot);
      mkdirSync(dir, { recursive: true });
      // A report can quote a session's task and setup, so the folder is kept out of git even
      // in a project that was set up before the folder existed.
      const ignore = join(dir, ".gitignore");
      if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
      const stamp = at
        .toISOString()
        .slice(0, 16)
        .replace(/[-:T]/g, "")
        .replace(/^(\d{8})/, "$1-");
      let path = join(dir, `${stamp}-${slug(input.title)}.md`);
      for (let n = 2; existsSync(path); n++) {
        path = join(dir, `${stamp}-${slug(input.title)}-${n}.md`);
      }
      const setup = reports
        .map((report) => `${report.reporterName}: ${report.evidence ?? "no session"}`)
        .join("\n");
      writeFileSync(
        path,
        bugReportText({
          title: input.title,
          what: input.what,
          steps: input.steps,
          expected: input.expected,
          reports: reports.map((report) => ({
            reporter: report.reporterName,
            role: report.roleKey,
            what: report.what,
            tried: report.tried ?? undefined,
          })),
          setup: setup || "none",
          version: pkg.version,
          at,
        }),
      );
      workspace.feed.add({
        kind: "selfheal",
        agentId: byId,
        agentName: store.getAgentName(byId),
        title: `filed a report about ${APP_NAME}: ${input.title}`,
        body: `${input.what}\n\n${path}`,
        data: { path },
      });
      try {
        workspace.messaging.send(
          byId,
          USER,
          `This looks like a defect in ${APP_NAME} itself, not in a role: ${input.title}\nThe report is at ${path}`,
        );
      } catch (error) {
        console.error(error);
      }
      for (const report of reports) {
        this.settle(
          report,
          "bug",
          `This is a defect in ${APP_NAME} itself, which no change to your role mends: ${input.title}. A report for the user was written to ${path}. ${input.what}`,
        );
      }
      this.closeIfDone(found);
      return { path };
    });
  }

  private openReports(caseId: number): ReportRow[] {
    return this.deps.store.reportsOf(caseId).filter((report) => report.state === "open");
  }

  /** The proposals that wait for the user, oldest first. */
  proposals(): FixSummary[] {
    return this.deps.store.pendingProposals().map((proposal) => this.summary(proposal));
  }

  private summary(proposal: ProposalRow): FixSummary {
    const { store } = this.deps;
    return {
      id: proposal.id,
      role: store.getCase(proposal.caseId)?.roleKey ?? "",
      summary: proposal.summary,
      reporters: store.reportsOf(proposal.caseId).map((report) => report.reporterName),
      createdAt: proposal.createdAt,
    };
  }

  /** The running sessions a proposal is for: the ones its open reports are about. */
  private subjects(caseId: number): { id: string; name: string; main: boolean }[] {
    const { store } = this.deps;
    const seen = new Map<string, { id: string; name: string; main: boolean }>();
    for (const report of this.openReports(caseId)) {
      const row = report.subjectId ? store.getRunning(report.subjectId) : null;
      if (row) seen.set(row.id, { id: row.id, name: row.name, main: row.kind === "main" });
    }
    return [...seen.values()];
  }

  /** Everything the approval shows, worked out against the files as they are now. */
  async view(id: number): Promise<FixView> {
    const { store } = this.deps;
    const proposal = store.getProposal(id);
    if (!proposal) throw new WorkspaceError(`There is no proposed fix #${id}.`);
    const changes = JSON.parse(proposal.changes) as Change[];
    const subjects = this.subjects(proposal.caseId);
    const lines: FixLine[] = changes.map((change) => ({
      id: change.id,
      file: describeTarget(change.file),
      text: describeChange(change),
      ...(change.why ? { why: change.why } : {}),
      widens: widens(change),
      ...(warningOf(change) ? { warning: warningOf(change) as string } : {}),
    }));
    let files: FixFile[] = [];
    let error: string | undefined;
    try {
      files = (await this.plan(changes)).map((plan) => ({
        label: plan.label,
        path: plan.path,
        adopt: plan.adopt,
        before: plan.before,
        after: plan.after,
        diff: diffLines(plan.before, plan.after),
      }));
    } catch (problem) {
      error = (problem as Error).message;
    }
    const noSessionOnly =
      subjects.length === 0
        ? "no session it was reported for is running"
        : !sessionOnlyPossible(changes)
          ? "it changes the prompt or the description, which only a role file holds"
          : undefined;
    return {
      ...this.summary(proposal),
      reason: proposal.reason,
      reports: store.reportsOf(proposal.caseId).map((report) => ({
        id: report.id,
        reporter: report.reporterName,
        what: report.what,
        ...(report.tried ? { tried: report.tried } : {}),
        gone: report.subjectId !== null && !store.getRunning(report.subjectId),
      })),
      lines,
      files,
      base: hash(files.flatMap((file) => [file.path, file.before])),
      sessions: subjects.map((subject) => subject.name),
      ...(noSessionOnly ? { noSessionOnly } : {}),
      main: subjects.some((subject) => subject.main),
      ...(error ? { error } : {}),
    };
  }

  /**
   * The user's decision. Applying writes the files through the role editor, with a version in
   * the history, and restarts the reporters when their turn ends; "session" gives the change
   * to the reporters alone and writes no file; a refusal is remembered for the role.
   */
  decide(decision: FixDecision): Promise<FixResult> {
    return this.serial(async () => {
      const { store, workspace } = this.deps;
      const proposal = store.getProposal(decision.id);
      if (proposal?.state !== "pending") {
        throw new WorkspaceError(`The proposed fix #${decision.id} is not waiting for a decision.`);
      }
      const found = store.getCase(proposal.caseId);
      if (!found) throw new WorkspaceError(`The proposed fix #${decision.id} has no case.`);
      const changes = JSON.parse(proposal.changes) as Change[];
      const lines = changes.map(describeChange).join("; ");
      const reports = this.openReports(found.id);
      const now = this.now();

      if (decision.action === "refuse") {
        const reason = decision.reason?.trim() || "no reason given";
        store.decideProposal(proposal.id, "refused", { reason }, now);
        store.addMemory({
          roleKey: found.roleKey,
          summary: proposal.summary,
          changes: proposal.changes,
          reason,
          createdAt: now,
        });
        for (const report of reports) {
          this.settle(
            report,
            "refused",
            `The user turned the fix down (${lines}). Their reason: ${reason}. Carry on without it, and say in your result what you could not do.`,
          );
        }
        this.finish(found, proposal, `turned down: ${reason}`);
        return { message: `Turned down. ${APP_NAME} remembers it for this role.`, behind: [] };
      }

      const subjects = this.subjects(found.id);
      const restartMain = decision.restart !== "later";
      const targets = subjects.filter((subject) => !subject.main || restartMain);
      let message: string;

      if (decision.action === "session") {
        if (subjects.length === 0 || !sessionOnlyPossible(changes)) {
          throw new WorkspaceError("This fix cannot be given to the reporting sessions alone.");
        }
        const skills = projectSkillNames(this.ctx);
        for (const subject of subjects) {
          await workspace.overrideSession(
            subject.id,
            (base) => {
              const next = valuesAfter(base, changes, { projectSkills: skills });
              // Laid over one session: a key that would be taken out of a file is left alone.
              return Object.fromEntries(
                Object.entries(next).filter(([, value]) => value !== null),
              ) as Capabilities;
            },
            subject.main && !restartMain ? "later" : "turn-end",
          );
        }
        store.decideProposal(proposal.id, "applied", { as: "session" }, now);
        const later = subjects.filter((subject) => subject.main && !restartMain);
        message = `Given to ${subjects.map((subject) => subject.name).join(", ")} alone; no file was changed.`;
        if (later.length > 0) message += " The main session has it after you restart it.";
        for (const report of reports) {
          const waits = later.some((subject) => subject.id === report.subjectId);
          this.settle(
            report,
            "applied",
            `The user approved the fix for your session alone (${lines}). ${
              waits ? "It holds after the user restarts this session." : this.restartNote(report)
            }`,
          );
        }
        this.finish(found, proposal, "applied to the session");
        return { message, behind: later.map((subject) => subject.name) };
      }

      // A role changed in an editor gets its version in the history before it is changed here.
      if (!this.deps.files) noticeEdits(this.ctx);
      const plans = await this.plan(changes);
      const base = hash(plans.flatMap((plan) => [plan.path, plan.before]));
      if (decision.base !== undefined && decision.base !== base) {
        throw new WorkspaceError(
          "The files changed since you looked at this fix. Open it again to see it against the files as they are now.",
        );
      }
      await this.check(plans, [found.roleKey]);
      const written: string[] = [];
      const source = `selfheal, fix #${proposal.id}`;
      for (const plan of plans) {
        if (plan.before === plan.after) continue;
        if (plan.adopt && plan.target.kind === "role") {
          adoptRole(plan.target.name, this.ctx, { now: new Date(now) });
        }
        const version = saveValues(plan.target, plan.values, source, this.ctx, new Date(now));
        written.push(`${plan.label} (v${version.n})`);
      }
      store.decideProposal(proposal.id, "applied", { as: "role" }, now);
      const refreshed = await workspace
        .refresh({ targets: targets.map((subject) => subject.id), when: "turn-end" })
        .catch(() => ({ results: [] }));
      const failed = refreshed.results.filter((result) => result.error);
      const left = subjects.filter((subject) => subject.main && !restartMain);
      message = `Written: ${written.join(", ") || "nothing"}.`;
      if (failed.length > 0) {
        message += ` Could not restart ${failed.map((result) => `${result.name} (${result.error})`).join(", ")}; the change is saved.`;
      }
      if (left.length > 0) message += " The main session keeps its old setup until you restart it.";
      for (const report of reports) {
        const waits = left.some((subject) => subject.id === report.subjectId);
        this.settle(
          report,
          "applied",
          `The user approved the fix (${lines}); it is written to ${written.join(", ")}. ${
            waits
              ? "It holds for you after the user restarts this session."
              : this.restartNote(report)
          }`,
        );
      }
      this.finish(found, proposal, `applied: ${written.join(", ")}`);
      return { message, behind: left.map((subject) => subject.name) };
    });
  }

  private restartNote(report: ReportRow): string {
    if (report.reporterId === USER)
      return "The sessions it is for are restarted when their turn ends.";
    return `${APP_NAME} restarts your session with it when this turn ends: end the turn now, and carry on with your task after the restart.`;
  }

  /** Ends a report: the reporter, the feed and, for an agent of the main session, that one are told. */
  private settle(report: ReportRow, state: ReportState, outcome: string): void {
    const { store, workspace } = this.deps;
    if (!store.settleReport(report.id, state, outcome, this.now())) return;
    const text = `Report #${report.id} (${report.what.split("\n")[0]?.slice(0, 80)}): ${outcome}`;
    workspace.feed.add({
      kind: "selfheal",
      agentId: report.reporterId === USER ? undefined : report.reporterId,
      agentName: report.reporterName,
      title: `report #${report.id} ${state}`,
      body: outcome,
    });
    const tell = () => {
      try {
        if (report.reporterId === USER) workspace.messaging.send(WORKSPACE, USER, text);
        else if (store.getRunning(report.reporterId)) {
          workspace.messaging.send(WORKSPACE, report.reporterName, text);
        }
      } catch (error) {
        console.error(error);
      }
    };
    if (report.blocking && report.reporterId !== USER) {
      // Its tool call fetches the outcome; the message is for a call that is no longer there.
      this.schedule(() => {
        if (store.getReport(report.id)?.seenAt === null) tell();
      }, SEEN_FALLBACK_MS);
    } else tell();
    // The main session hears how it ended for an agent it started, once, as a plain message.
    const main = store.running().find((row) => row.kind === "main");
    if (
      main &&
      report.reporterId !== USER &&
      report.reporterId !== main.id &&
      store.handover(report.reporterId)?.spawnedBy === main.id
    ) {
      try {
        workspace.messaging.send(
          WORKSPACE,
          main.name,
          `${report.reporterName} reported a gap in its setup (${report.what.split("\n")[0]?.slice(0, 120)}). Outcome: ${state}. ${state === "applied" ? `${report.reporterName} may restart and then carries on.` : "It carries on as it is."} No reply is needed.`,
        );
      } catch (error) {
        console.error(error);
      }
    }
  }

  /** After a decision: it goes into the feed, and the case ends. */
  private finish(found: CaseRow, proposal: ProposalRow, how: string): void {
    this.deps.workspace.feed.add({
      kind: "selfheal",
      agentName: "the user",
      title: `fix #${proposal.id} ${how}`,
      body: proposal.summary,
      data: { proposal: proposal.id },
    });
    this.closeIfDone(found);
  }

  /** Ends a case once nothing of it is open, and with it its session. */
  private closeIfDone(found: CaseRow): void {
    const { store, workspace } = this.deps;
    if (this.openReports(found.id).length > 0 || this.pending(found.id)) return;
    store.closeCase(found.id, this.now());
    const row = store.getRunning(found.agentId);
    if (!row) return;
    this.schedule(() => {
      workspace.stop(row.id).catch(() => undefined);
    }, STOP_DELAY_MS);
  }

  /** Ends a case that cannot be settled any more; its reporters are told. */
  private cancel(found: CaseRow, why: string): void {
    for (const report of this.openReports(found.id)) {
      this.settle(report, "cancelled", `${why} Report it again if you still need it.`);
    }
    this.deps.store.closeCase(found.id, this.now());
  }

  /** A session ended: a selfheal session leaves its reports unsettled, a reporter its report. */
  private async gone(agentId: string): Promise<void> {
    const { store, workspace } = this.deps;
    const own = store.openCaseOfAgent(agentId);
    if (own && !this.pending(own.id)) {
      this.cancel(own, "The session that looked into it ended before it was settled.");
    }
    for (const open of store.openCases()) {
      if (open.agentId === agentId) continue;
      const left = this.openReports(open.id).filter((report) => report.reporterId === agentId);
      if (left.length === 0) continue;
      // A proposal that waits still mends the role, so its reports stay with it.
      if (this.pending(open.id)) continue;
      for (const report of left) this.settle(report, "cancelled", "The reporter ended.");
      if (this.openReports(open.id).length === 0) this.closeIfDone(open);
      else if (store.getRunning(open.agentId)) {
        workspace.messaging.send(
          WORKSPACE,
          store.getAgentName(open.agentId) ?? "",
          `${left[0]?.reporterName} ended; its report is closed. Call selfheal_context again for what is left.`,
        );
      }
    }
  }

  /** After a daemon restart: cases whose session did not survive are ended. */
  resume(): Promise<void> {
    return this.serial(async () => {
      const { store } = this.deps;
      for (const open of store.openCases()) {
        if (!store.getRunning(open.agentId) && !this.pending(open.id)) {
          this.cancel(open, `${APP_NAME} was restarted before it was settled.`);
        }
      }
    });
  }

  /** The proposals the user turned down that still count. */
  memory(role?: string): FixMemory[] {
    return this.deps.store.memory(role).map((item) => ({
      id: item.id,
      role: item.roleKey,
      summary: item.summary,
      reason: item.reason,
      createdAt: item.createdAt,
    }));
  }

  /** Forgets turned-down proposals, for one role or for all, so they can be proposed again. */
  clearMemory(role?: string): number {
    return this.deps.store.clearMemory(this.now(), role);
  }
}
