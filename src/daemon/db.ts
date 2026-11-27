import { Database } from "bun:sqlite";
import type {
  AgentActivity,
  AgentKind,
  AgentState,
  WorkflowRunState,
  WorkflowStepState,
} from "../shared/protocol.ts";

export interface AgentRow {
  id: string;
  kind: AgentKind;
  name: string;
  role: string | null;
  profile: string;
  sessionId: string;
  paneId: string;
  state: AgentState;
  task: string | null;
  createdAt: number;
  activity: AgentActivity;
  detail: string | null;
  activitySince: number;
  /** Latest progress note the agent reported itself. */
  progress: string | null;
}

/**
 * What a session that another session started with `spawn_agent` owes: a result for whoever
 * started it. Sessions the user started, those of the config and workflow steps have no such row.
 */
export interface HandoverRow {
  id: string;
  name: string;
  state: AgentState;
  /** The first line of what the session last said. */
  detail: string | null;
  /** The id of the session that started it. */
  spawnedBy: string;
  /** 1 when the session stays open after it has reported. */
  keep: number;
  /** When it last reported a result; null while it still owes one. */
  finishedAt: number | null;
  /** Times it was reminded to report since someone last spoke to it. */
  reminders: number;
}

/** `fromId` / `toId` are agent ids, or "user". */
export interface MessageRow {
  id: number;
  fromId: string;
  toId: string;
  body: string;
  createdAt: number;
  deliveredAt: number | null;
}

export interface QuestionRow {
  id: number;
  fromId: string;
  toId: string;
  question: string;
  /** JSON array of suggested answers, or null. */
  options: string | null;
  state: "open" | "answered" | "cancelled";
  answer: string | null;
  answeredBy: string | null;
  createdAt: number;
  answeredAt: number | null;
}

/** One item of the event feed, as stored. `data` is JSON whose shape depends on the kind. */
export interface FeedRow {
  id: number;
  at: number;
  kind: string;
  agentId: string | null;
  agentName: string | null;
  refId: string | null;
  refName: string | null;
  title: string;
  body: string;
  data: string | null;
  /** True for an item about the main session. */
  fromMain: number | null;
}

export type NewFeedRow = Omit<FeedRow, "id" | "fromMain">;

export interface EventRow {
  agentId: string;
  at: number;
  event: string;
  summary: string | null;
}

export interface WorkflowRunRow {
  id: number;
  name: string;
  /** JSON of the definition as it was when the run started; later edits of the file do not apply. */
  definition: string;
  input: string;
  state: WorkflowRunState;
  /** An agent id, or "user". */
  startedBy: string;
  createdAt: number;
  finishedAt: number | null;
}

export interface WorkflowStepRow {
  runId: number;
  stepId: string;
  /** 1 on the first pass. A review that sends work back adds a row with the next number. */
  attempt: number;
  state: WorkflowStepState;
  agentId: string | null;
  result: string | null;
  error: string | null;
  /** Reminders sent because the agent ended a turn without completing the step. */
  reminders: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Review feedback this attempt has to deal with (for a review step: what it asked for last time). */
  feedback: string | null;
  /** The question to the user a rejected review step waits on. */
  questionId: number | null;
}

/** A call a session made that did not run because something refused it. */
export interface RefusalRow {
  id: number;
  agentId: string;
  at: number;
  /** `blocked` and `skill` are the hook's own refusals, `permission` the Claude command's. */
  source: string;
  tool: string;
  detail: string | null;
}

/** The selfheal session that looks into the reports about one role. */
export interface CaseRow {
  id: number;
  /** The role under repair; empty for sessions without a role. */
  roleKey: string;
  agentId: string;
  state: "open" | "closed";
  createdAt: number;
  closedAt: number | null;
}

export type ReportState = "open" | "answered" | "applied" | "refused" | "bug" | "cancelled";

/** One report of a gap, from a session or from the user. */
export interface ReportRow {
  id: number;
  caseId: number;
  /** An agent's id, or `user`. */
  reporterId: string;
  reporterName: string;
  /** The session the report is about; null for a role nobody runs. */
  subjectId: string | null;
  roleKey: string;
  what: string;
  tried: string | null;
  blocking: boolean;
  state: ReportState;
  outcome: string | null;
  /** What the subject was started with and was refused, as JSON, taken when it reported. */
  evidence: string | null;
  seenAt: number | null;
  createdAt: number;
  closedAt: number | null;
}

export type ProposalState = "pending" | "applied" | "refused" | "stale" | "superseded";

/** What a selfheal session wants changed, waiting for the user or decided. */
export interface ProposalRow {
  id: number;
  caseId: number;
  state: ProposalState;
  summary: string;
  reason: string;
  /** `Change[]` as JSON. */
  changes: string;
  decidedAs: string | null;
  refusalReason: string | null;
  createdAt: number;
  decidedAt: number | null;
}

/** A proposal the user turned down, kept so the same one is not made twice. */
export interface MemoryRow {
  id: number;
  roleKey: string;
  summary: string;
  changes: string;
  reason: string;
  createdAt: number;
  clearedAt: number | null;
}

/** Applied in order; `PRAGMA user_version` records how many have run. Only ever append. */
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS agents (
     id          TEXT PRIMARY KEY,
     kind        TEXT NOT NULL,
     name        TEXT NOT NULL,
     role        TEXT,
     profile     TEXT NOT NULL,
     session_id  TEXT NOT NULL,
     pane_id     TEXT NOT NULL,
     state       TEXT NOT NULL,
     task        TEXT,
     created_at  INTEGER NOT NULL,
     stopped_at  INTEGER
   );
   CREATE TABLE IF NOT EXISTS meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
  `ALTER TABLE agents ADD COLUMN activity TEXT NOT NULL DEFAULT 'starting';
   ALTER TABLE agents ADD COLUMN detail TEXT;
   ALTER TABLE agents ADD COLUMN activity_since INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE events (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     agent_id  TEXT NOT NULL,
     at        INTEGER NOT NULL,
     event     TEXT NOT NULL,
     summary   TEXT
   );
   CREATE INDEX events_agent ON events (agent_id, id);`,
  `ALTER TABLE agents ADD COLUMN progress TEXT;
   CREATE TABLE messages (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     from_id       TEXT NOT NULL,
     to_id         TEXT NOT NULL,
     body          TEXT NOT NULL,
     created_at    INTEGER NOT NULL,
     delivered_at  INTEGER
   );
   CREATE INDEX messages_to ON messages (to_id, delivered_at);
   CREATE TABLE questions (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     from_id      TEXT NOT NULL,
     to_id        TEXT NOT NULL,
     question     TEXT NOT NULL,
     options      TEXT,
     state        TEXT NOT NULL,
     answer       TEXT,
     answered_by  TEXT,
     created_at   INTEGER NOT NULL,
     answered_at  INTEGER
   );
   CREATE INDEX questions_state ON questions (state);`,
  `CREATE TABLE workflow_runs (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     name         TEXT NOT NULL,
     definition   TEXT NOT NULL,
     input        TEXT NOT NULL,
     state        TEXT NOT NULL,
     started_by   TEXT NOT NULL,
     created_at   INTEGER NOT NULL,
     finished_at  INTEGER
   );
   CREATE INDEX workflow_runs_state ON workflow_runs (state);
   CREATE TABLE workflow_steps (
     run_id       INTEGER NOT NULL,
     step_id      TEXT NOT NULL,
     attempt      INTEGER NOT NULL DEFAULT 1,
     state        TEXT NOT NULL,
     agent_id     TEXT,
     result       TEXT,
     error        TEXT,
     reminders    INTEGER NOT NULL DEFAULT 0,
     started_at   INTEGER,
     finished_at  INTEGER,
     PRIMARY KEY (run_id, step_id, attempt)
   );
   CREATE INDEX workflow_steps_agent ON workflow_steps (agent_id);`,
  `ALTER TABLE workflow_steps ADD COLUMN feedback TEXT;
   ALTER TABLE workflow_steps ADD COLUMN question_id INTEGER;`,
  "ALTER TABLE agents ADD COLUMN launch TEXT;",
  `ALTER TABLE agents ADD COLUMN request TEXT;
   ALTER TABLE agents ADD COLUMN overrides TEXT;
   ALTER TABLE agents ADD COLUMN pending_restart INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE agents ADD COLUMN blocked TEXT;`,
  // NULL for sessions from before this column: they are taken to have a conversation.
  "ALTER TABLE agents ADD COLUMN had_turn INTEGER;",
  // Set for a session another session started: see `HandoverRow`.
  `ALTER TABLE agents ADD COLUMN spawned_by TEXT;
   ALTER TABLE agents ADD COLUMN keep INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE agents ADD COLUMN finished_at INTEGER;
   ALTER TABLE agents ADD COLUMN reminders INTEGER NOT NULL DEFAULT 0;`,
  // Not used any more: it held the whole reply for a dialog that is gone. Migrations stay.
  "ALTER TABLE agents ADD COLUMN detail_text TEXT;",
  // The event feed: what happened across the sessions, for the feed pane (`FeedRow`).
  `CREATE TABLE feed (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     at          INTEGER NOT NULL,
     kind        TEXT NOT NULL,
     agent_id    TEXT,
     agent_name  TEXT,
     ref_id      TEXT,
     ref_name    TEXT,
     title       TEXT NOT NULL,
     body        TEXT NOT NULL DEFAULT '',
     data        TEXT
   );`,
  // Self-heal: calls a session was refused, reports of a gap, the case that looks into the
  // reports about one role, what it proposes, and the proposals the user turned down.
  `CREATE TABLE refusals (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     agent_id  TEXT NOT NULL,
     at        INTEGER NOT NULL,
     source    TEXT NOT NULL,
     tool      TEXT NOT NULL,
     detail    TEXT
   );
   CREATE INDEX refusals_agent ON refusals (agent_id, id);
   CREATE TABLE selfheal_cases (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     role_key    TEXT NOT NULL,
     agent_id    TEXT NOT NULL,
     state       TEXT NOT NULL,
     created_at  INTEGER NOT NULL,
     closed_at   INTEGER
   );
   CREATE TABLE selfheal_reports (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     case_id        INTEGER NOT NULL,
     reporter_id    TEXT NOT NULL,
     reporter_name  TEXT NOT NULL,
     subject_id     TEXT,
     role_key       TEXT NOT NULL,
     what           TEXT NOT NULL,
     tried          TEXT,
     blocking       INTEGER NOT NULL DEFAULT 0,
     state          TEXT NOT NULL,
     outcome        TEXT,
     evidence       TEXT,
     seen_at        INTEGER,
     created_at     INTEGER NOT NULL,
     closed_at      INTEGER
   );
   CREATE TABLE selfheal_proposals (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     case_id         INTEGER NOT NULL,
     state           TEXT NOT NULL,
     summary         TEXT NOT NULL,
     reason          TEXT NOT NULL,
     changes         TEXT NOT NULL,
     decided_as      TEXT,
     refusal_reason  TEXT,
     created_at      INTEGER NOT NULL,
     decided_at      INTEGER
   );
   CREATE TABLE selfheal_memory (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     role_key    TEXT NOT NULL,
     summary     TEXT NOT NULL,
     changes     TEXT NOT NULL,
     reason      TEXT NOT NULL,
     created_at  INTEGER NOT NULL,
     cleared_at  INTEGER
   );`,
];

const HANDOVER_COLUMNS = `id, name, state, detail, spawned_by AS spawnedBy, keep,
  finished_at AS finishedAt, reminders`;

const COLUMNS = `id, kind, name, role, profile, session_id AS sessionId, pane_id AS paneId,
  state, task, created_at AS createdAt, activity, detail, activity_since AS activitySince,
  progress`;

const MESSAGE_COLUMNS = `id, from_id AS fromId, to_id AS toId, body, created_at AS createdAt,
  delivered_at AS deliveredAt`;

const QUESTION_COLUMNS = `id, from_id AS fromId, to_id AS toId, question, options, state, answer,
  answered_by AS answeredBy, created_at AS createdAt, answered_at AS answeredAt`;

const RUN_COLUMNS = `id, name, definition, input, state, started_by AS startedBy,
  created_at AS createdAt, finished_at AS finishedAt`;

const STEP_COLUMNS = `run_id AS runId, step_id AS stepId, attempt, state, agent_id AS agentId,
  result, error, reminders, started_at AS startedAt, finished_at AS finishedAt, feedback,
  question_id AS questionId`;

const REFUSAL_COLUMNS = "id, agent_id AS agentId, at, source, tool, detail";

const CASE_COLUMNS = `id, role_key AS roleKey, agent_id AS agentId, state,
  created_at AS createdAt, closed_at AS closedAt`;

const REPORT_COLUMNS = `id, case_id AS caseId, reporter_id AS reporterId,
  reporter_name AS reporterName, subject_id AS subjectId, role_key AS roleKey, what, tried,
  blocking, state, outcome, evidence, seen_at AS seenAt, created_at AS createdAt,
  closed_at AS closedAt`;

const PROPOSAL_COLUMNS = `id, case_id AS caseId, state, summary, reason, changes,
  decided_as AS decidedAs, refusal_reason AS refusalReason, created_at AS createdAt,
  decided_at AS decidedAt`;

const MEMORY_COLUMNS = `id, role_key AS roleKey, summary, changes, reason,
  created_at AS createdAt, cleared_at AS clearedAt`;

/** Refusals kept for one session; older ones are dropped. */
export const MAX_REFUSALS = 50;

/** Events kept in the log; older ones are dropped. */
const MAX_EVENTS = 5000;

/** Items kept in the feed; older ones are dropped. */
export const MAX_FEED = 2000;

const FEED_COLUMNS = `feed.id, feed.at, feed.kind, feed.agent_id AS agentId,
  feed.agent_name AS agentName, feed.ref_id AS refId, feed.ref_name AS refName, feed.title,
  feed.data, agents.kind = 'main' AS fromMain`;

/** Persistent state of one project's workspace. Pass ":memory:" in tests. */
export class Store {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    const { user_version: version } = this.db.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    for (let index = version; index < MIGRATIONS.length; index++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[index] ?? "");
        this.db.exec(`PRAGMA user_version = ${index + 1}`);
      })();
    }
  }

  insertAgent(row: AgentRow): void {
    this.db
      .query(
        `INSERT INTO agents (id, kind, name, role, profile, session_id, pane_id, state, task,
           created_at, activity, detail, activity_since, progress)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.kind,
        row.name,
        row.role,
        row.profile,
        row.sessionId,
        row.paneId,
        row.state,
        row.task,
        row.createdAt,
        row.activity,
        row.detail,
        row.activitySince,
        row.progress,
      );
  }

  /** Records what a session was started with (the resolved session, as JSON). */
  setLaunch(id: string, launch: string): void {
    this.db.query("UPDATE agents SET launch = ? WHERE id = ?").run(launch, id);
  }

  getLaunch(id: string): string | null {
    const row = this.db.query("SELECT launch FROM agents WHERE id = ?").get(id) as {
      launch: string | null;
    } | null;
    return row?.launch ?? null;
  }

  /** What a session was asked to be started with, so it can be started again the same way. */
  setRequest(id: string, request: string): void {
    this.db.query("UPDATE agents SET request = ? WHERE id = ?").run(request, id);
  }

  getRequest(id: string): string | null {
    const row = this.db.query("SELECT request FROM agents WHERE id = ?").get(id) as {
      request: string | null;
    } | null;
    return row?.request ?? null;
  }

  /** Capability values changed for one session while it ran. */
  setOverrides(id: string, overrides: string | null): void {
    this.db.query("UPDATE agents SET overrides = ? WHERE id = ?").run(overrides, id);
  }

  getOverrides(id: string): string | null {
    const row = this.db.query("SELECT overrides FROM agents WHERE id = ?").get(id) as {
      overrides: string | null;
    } | null;
    return row?.overrides ?? null;
  }

  /** Tools a running session still has but is refused, as a JSON list of names. */
  setBlocked(id: string, blocked: string | null): void {
    this.db.query("UPDATE agents SET blocked = ? WHERE id = ?").run(blocked, id);
  }

  getBlocked(id: string): string | null {
    const row = this.db.query("SELECT blocked FROM agents WHERE id = ?").get(id) as {
      blocked: string | null;
    } | null;
    return row?.blocked ?? null;
  }

  /** Whether the session has a conversation yet: it does from its first prompt on. */
  setHadTurn(id: string, had: boolean): void {
    this.db.query("UPDATE agents SET had_turn = ? WHERE id = ?").run(had ? 1 : 0, id);
  }

  /** False only when the session is known to have had no prompt yet. */
  hadTurn(id: string): boolean {
    const row = this.db.query("SELECT had_turn AS had FROM agents WHERE id = ?").get(id) as {
      had: number | null;
    } | null;
    return row?.had !== 0;
  }

  /** Marks a session to be restarted when its turn ends. */
  setPendingRestart(id: string, pending: boolean): void {
    this.db.query("UPDATE agents SET pending_restart = ? WHERE id = ?").run(pending ? 1 : 0, id);
  }

  pendingRestart(id: string): boolean {
    const row = this.db
      .query("SELECT pending_restart AS pending FROM agents WHERE id = ?")
      .get(id) as { pending: number } | null;
    return row?.pending === 1;
  }

  /** A restarted session lives in the same row under a new session id. */
  setSessionId(id: string, sessionId: string): void {
    this.db.query("UPDATE agents SET session_id = ? WHERE id = ?").run(sessionId, id);
  }

  /** Names of the tools a session has called, as far as its events go back. */
  toolsUsed(id: string): string[] {
    const rows = this.db
      .query(
        "SELECT DISTINCT summary FROM events WHERE agent_id = ? AND event = 'PreToolUse' AND summary IS NOT NULL",
      )
      .all(id) as { summary: string }[];
    return rows.map((row) => row.summary);
  }

  /** Running sessions, main first, then agents oldest first. */
  running(): AgentRow[] {
    return this.db
      .query(
        `SELECT ${COLUMNS} FROM agents WHERE state = 'running'
         ORDER BY kind = 'main' DESC, created_at, rowid`,
      )
      .all() as AgentRow[];
  }

  getRunning(id: string): AgentRow | null {
    return this.db
      .query(`SELECT ${COLUMNS} FROM agents WHERE id = ? AND state = 'running'`)
      .get(id) as AgentRow | null;
  }

  markStopped(id: string, now: number): void {
    this.db.query("UPDATE agents SET state = 'stopped', stopped_at = ? WHERE id = ?").run(now, id);
  }

  setActivity(id: string, activity: AgentActivity, detail: string | null, now: number): void {
    this.db
      .query("UPDATE agents SET activity = ?, detail = ?, activity_since = ? WHERE id = ?")
      .run(activity, detail, now, id);
  }

  setProgress(id: string, progress: string | null): void {
    this.db.query("UPDATE agents SET progress = ? WHERE id = ?").run(progress, id);
  }

  /** Records that another session started this one and is owed its result. */
  setSpawner(id: string, spawnedBy: string, keep: boolean): void {
    this.db
      .query("UPDATE agents SET spawned_by = ?, keep = ? WHERE id = ?")
      .run(spawnedBy, keep ? 1 : 0, id);
  }

  /** The session as one that owes a result, running or not; null when nobody started it. */
  handover(id: string): HandoverRow | null {
    return this.db
      .query(`SELECT ${HANDOVER_COLUMNS} FROM agents WHERE id = ? AND spawned_by IS NOT NULL`)
      .get(id) as HandoverRow | null;
  }

  /** Running sessions this one started that have not reported a result yet, oldest first. */
  owedTo(spawnerId: string): HandoverRow[] {
    return this.db
      .query(
        `SELECT ${HANDOVER_COLUMNS} FROM agents
         WHERE spawned_by = ? AND state = 'running' AND finished_at IS NULL
         ORDER BY created_at, rowid`,
      )
      .all(spawnerId) as HandoverRow[];
  }

  /** Sessions that reported and were to end, but still run (the daemon stopped in between). */
  reportedAndRunning(): HandoverRow[] {
    return this.db
      .query(
        `SELECT ${HANDOVER_COLUMNS} FROM agents
         WHERE spawned_by IS NOT NULL AND state = 'running' AND keep = 0
           AND finished_at IS NOT NULL`,
      )
      .all() as HandoverRow[];
  }

  /** The session of this name or id that `spawnerId` started and that is gone; the latest one. */
  lastStoppedHandover(target: string, spawnerId: string): HandoverRow | null {
    return this.db
      .query(
        `SELECT ${HANDOVER_COLUMNS} FROM agents
         WHERE (name = ? OR id = ?) AND spawned_by = ? AND state = 'stopped'
         ORDER BY stopped_at DESC, rowid DESC LIMIT 1`,
      )
      .get(target, target, spawnerId) as HandoverRow | null;
  }

  setFinished(id: string, now: number): void {
    this.db.query("UPDATE agents SET finished_at = ?, reminders = 0 WHERE id = ?").run(now, id);
  }

  /** Counts one more reminder to report and returns the new count. */
  addHandoverReminder(id: string): number {
    const row = this.db
      .query("UPDATE agents SET reminders = reminders + 1 WHERE id = ? RETURNING reminders")
      .get(id) as { reminders: number } | null;
    return row?.reminders ?? 0;
  }

  resetHandoverReminders(id: string): void {
    this.db.query("UPDATE agents SET reminders = 0 WHERE id = ?").run(id);
  }

  /** The newest message addressed to someone, delivered or not. */
  lastMessageTo(toId: string): MessageRow | null {
    return this.db
      .query(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE to_id = ? ORDER BY id DESC LIMIT 1`)
      .get(toId) as MessageRow | null;
  }

  /** Any agent by id, running or not (for naming the sender of an old message). */
  getAgentName(id: string): string | null {
    const row = this.db.query("SELECT name FROM agents WHERE id = ?").get(id) as {
      name: string;
    } | null;
    return row?.name ?? null;
  }

  addMessage(message: { fromId: string; toId: string; body: string; createdAt: number }): number {
    const { lastInsertRowid } = this.db
      .query("INSERT INTO messages (from_id, to_id, body, created_at) VALUES (?, ?, ?, ?)")
      .run(message.fromId, message.toId, message.body, message.createdAt);
    return Number(lastInsertRowid);
  }

  /** Messages not yet handed to their recipient, oldest first. */
  pendingMessages(toId: string): MessageRow[] {
    return this.db
      .query(
        `SELECT ${MESSAGE_COLUMNS} FROM messages
         WHERE to_id = ? AND delivered_at IS NULL ORDER BY id`,
      )
      .all(toId) as MessageRow[];
  }

  markDelivered(ids: number[], now: number): void {
    const mark = this.db.query("UPDATE messages SET delivered_at = ? WHERE id = ?");
    this.db.transaction(() => {
      for (const id of ids) mark.run(now, id);
    })();
  }

  /**
   * Latest messages addressed to someone, sent at or after `since` and with an id above `after`,
   * newest first.
   */
  recentMessages(toId: string, limit: number, since = 0, after = 0): MessageRow[] {
    return this.db
      .query(
        `SELECT ${MESSAGE_COLUMNS} FROM messages
         WHERE to_id = ? AND created_at >= ? AND id > ? ORDER BY id DESC LIMIT ?`,
      )
      .all(toId, since, after, limit) as MessageRow[];
  }

  addQuestion(question: {
    fromId: string;
    toId: string;
    question: string;
    options: string[] | null;
    createdAt: number;
  }): number {
    const { lastInsertRowid } = this.db
      .query(
        `INSERT INTO questions (from_id, to_id, question, options, state, created_at)
         VALUES (?, ?, ?, ?, 'open', ?)`,
      )
      .run(
        question.fromId,
        question.toId,
        question.question,
        question.options ? JSON.stringify(question.options) : null,
        question.createdAt,
      );
    return Number(lastInsertRowid);
  }

  getQuestion(id: number): QuestionRow | null {
    return this.db
      .query(`SELECT ${QUESTION_COLUMNS} FROM questions WHERE id = ?`)
      .get(id) as QuestionRow | null;
  }

  /** Questions nobody has answered yet, oldest first. They never expire. */
  openQuestions(): QuestionRow[] {
    return this.db
      .query(`SELECT ${QUESTION_COLUMNS} FROM questions WHERE state = 'open' ORDER BY id`)
      .all() as QuestionRow[];
  }

  /** Closes an open question. Returns false when it was already closed. */
  closeQuestion(
    id: number,
    result: { state: "answered" | "cancelled"; answer: string | null; by: string; now: number },
  ): boolean {
    const { changes } = this.db
      .query(
        `UPDATE questions SET state = ?, answer = ?, answered_by = ?, answered_at = ?
         WHERE id = ? AND state = 'open'`,
      )
      .run(result.state, result.answer, result.by, result.now, id);
    return changes > 0;
  }

  addEvent(event: EventRow): void {
    const { lastInsertRowid } = this.db
      .query("INSERT INTO events (agent_id, at, event, summary) VALUES (?, ?, ?, ?)")
      .run(event.agentId, event.at, event.event, event.summary);
    if (Number(lastInsertRowid) % 500 === 0) {
      this.db.query("DELETE FROM events WHERE id <= ?").run(Number(lastInsertRowid) - MAX_EVENTS);
    }
  }

  addFeed(item: NewFeedRow): number {
    const { lastInsertRowid } = this.db
      .query(
        `INSERT INTO feed (at, kind, agent_id, agent_name, ref_id, ref_name, title, body, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.at,
        item.kind,
        item.agentId,
        item.agentName,
        item.refId,
        item.refName,
        item.title,
        item.body,
        item.data,
      );
    const id = Number(lastInsertRowid);
    if (id % 100 === 0) this.db.query("DELETE FROM feed WHERE id <= ?").run(id - MAX_FEED);
    return id;
  }

  /**
   * Feed items after `after`, oldest first, at most `limit`. Without `after` the latest `limit`.
   * Nothing up to `floor` is given either way.
   * The body is cut to `preview` characters.
   */
  feedAfter(after: number, limit: number, preview: number, floor = 0): FeedRow[] {
    const columns = `${FEED_COLUMNS}, substr(feed.body, 1, ${Math.max(0, Math.floor(preview))}) AS body`;
    const from = "FROM feed LEFT JOIN agents ON agents.id = feed.agent_id";
    if (after > 0) {
      return this.db
        .query(`SELECT ${columns} ${from} WHERE feed.id > ? ORDER BY feed.id LIMIT ?`)
        .all(Math.max(after, floor), limit) as FeedRow[];
    }
    const rows = this.db
      .query(`SELECT ${columns} ${from} WHERE feed.id > ? ORDER BY feed.id DESC LIMIT ?`)
      .all(floor, limit) as FeedRow[];
    return rows.reverse();
  }

  /** The id of the newest feed item, of one kind when given; 0 when there is none. */
  lastFeedId(kind?: string): number {
    const row = (
      kind === undefined
        ? this.db.query("SELECT max(id) AS id FROM feed").get()
        : this.db.query("SELECT max(id) AS id FROM feed WHERE kind = ?").get(kind)
    ) as { id: number | null } | null;
    return row?.id ?? 0;
  }

  feedItem(id: number): FeedRow | null {
    return (
      (this.db
        .query(
          `SELECT ${FEED_COLUMNS}, feed.body FROM feed LEFT JOIN agents ON agents.id = feed.agent_id WHERE feed.id = ?`,
        )
        .get(id) as FeedRow | null) ?? null
    );
  }

  /** Most recent events first. */
  recentEvents(limit: number): EventRow[] {
    return this.db
      .query("SELECT agent_id AS agentId, at, event, summary FROM events ORDER BY id DESC LIMIT ?")
      .all(limit) as EventRow[];
  }

  /** Stores a run with all its steps pending. `stepIds` are in the order of the definition. */
  addWorkflowRun(
    run: { name: string; definition: string; input: string; startedBy: string; createdAt: number },
    stepIds: string[],
  ): number {
    return this.db.transaction(() => {
      const { lastInsertRowid } = this.db
        .query(
          `INSERT INTO workflow_runs (name, definition, input, state, started_by, created_at)
           VALUES (?, ?, ?, 'running', ?, ?)`,
        )
        .run(run.name, run.definition, run.input, run.startedBy, run.createdAt);
      const id = Number(lastInsertRowid);
      const add = this.db.query(
        "INSERT INTO workflow_steps (run_id, step_id, state) VALUES (?, ?, 'pending')",
      );
      for (const stepId of stepIds) add.run(id, stepId);
      return id;
    })();
  }

  getWorkflowRun(id: number): WorkflowRunRow | null {
    return this.db
      .query(`SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE id = ?`)
      .get(id) as WorkflowRunRow | null;
  }

  runningWorkflowRuns(): WorkflowRunRow[] {
    return this.db
      .query(`SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE state = 'running' ORDER BY id`)
      .all() as WorkflowRunRow[];
  }

  /** Runs in progress plus the latest `finished` ended ones, newest first. */
  visibleWorkflowRuns(finished: number): WorkflowRunRow[] {
    return this.db
      .query(
        `SELECT ${RUN_COLUMNS} FROM workflow_runs
         WHERE state = 'running' OR id IN (
           SELECT id FROM workflow_runs WHERE state != 'running' ORDER BY id DESC LIMIT ?
         )
         ORDER BY id DESC`,
      )
      .all(finished) as WorkflowRunRow[];
  }

  /** A run's steps in the order of its definition. */
  /** Each step of a run at its latest attempt. Earlier attempts are history. */
  workflowSteps(runId: number): WorkflowStepRow[] {
    return this.db
      .query(
        `SELECT ${STEP_COLUMNS} FROM workflow_steps AS s
         WHERE run_id = ? AND attempt = (
           SELECT MAX(i.attempt) FROM workflow_steps AS i
           WHERE i.run_id = s.run_id AND i.step_id = s.step_id
         )
         ORDER BY rowid`,
      )
      .all(runId) as WorkflowStepRow[];
  }

  workflowStepAttempt(runId: number, stepId: string, attempt: number): WorkflowStepRow | null {
    return this.db
      .query(
        `SELECT ${STEP_COLUMNS} FROM workflow_steps
         WHERE run_id = ? AND step_id = ? AND attempt = ?`,
      )
      .get(runId, stepId, attempt) as WorkflowStepRow | null;
  }

  /** The step attempt that waits on a question to the user, if any. */
  stepOfQuestion(questionId: number): WorkflowStepRow | null {
    return this.db
      .query(`SELECT ${STEP_COLUMNS} FROM workflow_steps WHERE question_id = ?`)
      .get(questionId) as WorkflowStepRow | null;
  }

  /**
   * Adds the next attempt of a step that was sent back: pending, or running at once when the
   * session that did the previous attempt carries on.
   */
  addStepAttempt(
    runId: number,
    stepId: string,
    attempt: number,
    start: { agentId?: string; feedback?: string; now: number },
  ): void {
    this.db
      .query(
        `INSERT INTO workflow_steps (run_id, step_id, attempt, state, agent_id, feedback, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        stepId,
        attempt,
        start.agentId ? "running" : "pending",
        start.agentId ?? null,
        start.feedback ?? null,
        start.agentId ? start.now : null,
      );
  }

  setStepQuestion(runId: number, stepId: string, attempt: number, questionId: number): void {
    this.db
      .query(
        "UPDATE workflow_steps SET question_id = ? WHERE run_id = ? AND step_id = ? AND attempt = ?",
      )
      .run(questionId, runId, stepId, attempt);
  }

  /** Ends a rejected review step once it is decided. Returns false when it was not rejected any more. */
  resolveRejectedStep(
    runId: number,
    stepId: string,
    attempt: number,
    outcome: { state: "done" | "failed"; result?: string; error?: string; now: number },
  ): boolean {
    const { changes } = this.db
      .query(
        `UPDATE workflow_steps SET state = ?, result = ?, error = ?, finished_at = ?
         WHERE run_id = ? AND step_id = ? AND attempt = ? AND state = 'rejected'`,
      )
      .run(
        outcome.state,
        outcome.result ?? null,
        outcome.error ?? null,
        outcome.now,
        runId,
        stepId,
        attempt,
      );
    return changes > 0;
  }

  /** The step an agent is working on, if any. */
  runningStepOf(agentId: string): WorkflowStepRow | null {
    return this.db
      .query(`SELECT ${STEP_COLUMNS} FROM workflow_steps WHERE agent_id = ? AND state = 'running'`)
      .get(agentId) as WorkflowStepRow | null;
  }

  /** Marks a pending step as running. Returns false when it was not pending any more. */
  startStep(runId: number, stepId: string, now: number): boolean {
    const { changes } = this.db
      .query(
        `UPDATE workflow_steps SET state = 'running', started_at = ?
         WHERE run_id = ? AND step_id = ? AND state = 'pending'`,
      )
      .run(now, runId, stepId);
    return changes > 0;
  }

  setStepAgent(runId: number, stepId: string, agentId: string): void {
    this.db
      .query(
        "UPDATE workflow_steps SET agent_id = ? WHERE run_id = ? AND step_id = ? AND state = 'running'",
      )
      .run(agentId, runId, stepId);
  }

  /** Ends a running step. Returns false when it had already ended. */
  finishStep(
    runId: number,
    stepId: string,
    outcome: {
      state: "done" | "failed" | "rejected";
      result?: string;
      error?: string;
      now: number;
    },
  ): boolean {
    const { changes } = this.db
      .query(
        `UPDATE workflow_steps SET state = ?, result = ?, error = ?, finished_at = ?
         WHERE run_id = ? AND step_id = ? AND state = 'running'`,
      )
      .run(
        outcome.state,
        outcome.result ?? null,
        outcome.error ?? null,
        outcome.now,
        runId,
        stepId,
      );
    return changes > 0;
  }

  /** Steps that never started will not start any more. */
  skipPendingSteps(runId: number, now: number): void {
    this.db
      .query(
        `UPDATE workflow_steps SET state = 'skipped', finished_at = ?
         WHERE run_id = ? AND state = 'pending'`,
      )
      .run(now, runId);
  }

  /** Counts one more reminder for a step and returns the new total. */
  addStepReminder(runId: number, stepId: string): number {
    const row = this.db
      .query(
        `UPDATE workflow_steps SET reminders = reminders + 1
         WHERE run_id = ? AND step_id = ? AND state = 'running' RETURNING reminders`,
      )
      .get(runId, stepId) as { reminders: number } | null;
    return row?.reminders ?? 0;
  }

  /** Ends a run. Returns false when it had already ended. */
  /** Replaces the definition a run works from (a JSON snapshot), after an edit. */
  setWorkflowDefinition(id: number, definition: string): void {
    this.db.query("UPDATE workflow_runs SET definition = ? WHERE id = ?").run(definition, id);
  }

  /** Removes a step from a run, with every attempt of it. */
  deleteWorkflowStep(runId: number, stepId: string): void {
    this.db.query("DELETE FROM workflow_steps WHERE run_id = ? AND step_id = ?").run(runId, stepId);
  }

  finishWorkflowRun(id: number, state: WorkflowRunState, now: number): boolean {
    const { changes } = this.db
      .query(
        "UPDATE workflow_runs SET state = ?, finished_at = ? WHERE id = ? AND state = 'running'",
      )
      .run(state, now, id);
    return changes > 0;
  }

  /** Records a call that was refused and keeps the session's latest `MAX_REFUSALS`. */
  addRefusal(refusal: Omit<RefusalRow, "id">): void {
    this.db
      .query("INSERT INTO refusals (agent_id, at, source, tool, detail) VALUES (?, ?, ?, ?, ?)")
      .run(refusal.agentId, refusal.at, refusal.source, refusal.tool, refusal.detail);
    this.db
      .query(
        `DELETE FROM refusals WHERE agent_id = ?1 AND id NOT IN
           (SELECT id FROM refusals WHERE agent_id = ?1 ORDER BY id DESC LIMIT ?2)`,
      )
      .run(refusal.agentId, MAX_REFUSALS);
  }

  /** A session's refused calls, oldest first. */
  refusals(agentId: string): RefusalRow[] {
    return this.db
      .query(`SELECT ${REFUSAL_COLUMNS} FROM refusals WHERE agent_id = ? ORDER BY id`)
      .all(agentId) as RefusalRow[];
  }

  addCase(roleKey: string, agentId: string, now: number): number {
    const result = this.db
      .query(
        "INSERT INTO selfheal_cases (role_key, agent_id, state, created_at) VALUES (?, ?, 'open', ?)",
      )
      .run(roleKey, agentId, now);
    return Number(result.lastInsertRowid);
  }

  getCase(id: number): CaseRow | null {
    return this.db
      .query(`SELECT ${CASE_COLUMNS} FROM selfheal_cases WHERE id = ?`)
      .get(id) as CaseRow | null;
  }

  /** The case that is open for a role, if there is one. */
  openCaseOf(roleKey: string): CaseRow | null {
    return this.db
      .query(
        `SELECT ${CASE_COLUMNS} FROM selfheal_cases WHERE role_key = ? AND state = 'open'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(roleKey) as CaseRow | null;
  }

  /** The open case a selfheal session works on, if it has one. */
  openCaseOfAgent(agentId: string): CaseRow | null {
    return this.db
      .query(
        `SELECT ${CASE_COLUMNS} FROM selfheal_cases WHERE agent_id = ? AND state = 'open'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(agentId) as CaseRow | null;
  }

  openCases(): CaseRow[] {
    return this.db
      .query(`SELECT ${CASE_COLUMNS} FROM selfheal_cases WHERE state = 'open' ORDER BY id`)
      .all() as CaseRow[];
  }

  /** Hands a case to another session, when the one that had it is gone. */
  setCaseAgent(id: number, agentId: string): void {
    this.db.query("UPDATE selfheal_cases SET agent_id = ? WHERE id = ?").run(agentId, id);
  }

  closeCase(id: number, now: number): void {
    this.db
      .query("UPDATE selfheal_cases SET state = 'closed', closed_at = ? WHERE id = ?")
      .run(now, id);
  }

  addReport(report: {
    caseId: number;
    reporterId: string;
    reporterName: string;
    subjectId: string | null;
    roleKey: string;
    what: string;
    tried: string | null;
    blocking: boolean;
    evidence: string | null;
    createdAt: number;
  }): number {
    const result = this.db
      .query(
        `INSERT INTO selfheal_reports (case_id, reporter_id, reporter_name, subject_id, role_key,
           what, tried, blocking, state, evidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(
        report.caseId,
        report.reporterId,
        report.reporterName,
        report.subjectId,
        report.roleKey,
        report.what,
        report.tried,
        report.blocking ? 1 : 0,
        report.evidence,
        report.createdAt,
      );
    return Number(result.lastInsertRowid);
  }

  private report(
    row: (Omit<ReportRow, "blocking"> & { blocking: number }) | null,
  ): ReportRow | null {
    return row ? { ...row, blocking: row.blocking === 1 } : null;
  }

  getReport(id: number): ReportRow | null {
    return this.report(
      this.db.query(`SELECT ${REPORT_COLUMNS} FROM selfheal_reports WHERE id = ?`).get(id) as never,
    );
  }

  /** The reports of a case, oldest first. */
  reportsOf(caseId: number): ReportRow[] {
    const rows = this.db
      .query(`SELECT ${REPORT_COLUMNS} FROM selfheal_reports WHERE case_id = ? ORDER BY id`)
      .all(caseId) as never[];
    return rows.map((row) => this.report(row) as ReportRow);
  }

  /** The report a session or the user has open about a role, if any. */
  openReportBy(reporterId: string, roleKey: string): ReportRow | null {
    return this.report(
      this.db
        .query(
          `SELECT ${REPORT_COLUMNS} FROM selfheal_reports
           WHERE reporter_id = ? AND role_key = ? AND state = 'open' ORDER BY id DESC LIMIT 1`,
        )
        .get(reporterId, roleKey) as never,
    );
  }

  /** Ends a report that is open. False when it was settled before. */
  settleReport(id: number, state: ReportState, outcome: string, now: number): boolean {
    const result = this.db
      .query(
        `UPDATE selfheal_reports SET state = ?, outcome = ?, closed_at = ?
         WHERE id = ? AND state = 'open'`,
      )
      .run(state, outcome, now, id);
    return result.changes > 0;
  }

  setReportBlocking(id: number, blocking: boolean): void {
    this.db
      .query("UPDATE selfheal_reports SET blocking = ? WHERE id = ?")
      .run(blocking ? 1 : 0, id);
  }

  markReportSeen(id: number, now: number): void {
    this.db
      .query("UPDATE selfheal_reports SET seen_at = ? WHERE id = ? AND seen_at IS NULL")
      .run(now, id);
  }

  addProposal(proposal: {
    caseId: number;
    summary: string;
    reason: string;
    changes: string;
    createdAt: number;
  }): number {
    // One proposal at a time for a case: a new one takes the place of the one that waits.
    this.db
      .query(
        "UPDATE selfheal_proposals SET state = 'superseded', decided_at = ? WHERE case_id = ? AND state = 'pending'",
      )
      .run(proposal.createdAt, proposal.caseId);
    const result = this.db
      .query(
        `INSERT INTO selfheal_proposals (case_id, state, summary, reason, changes, created_at)
         VALUES (?, 'pending', ?, ?, ?, ?)`,
      )
      .run(
        proposal.caseId,
        proposal.summary,
        proposal.reason,
        proposal.changes,
        proposal.createdAt,
      );
    return Number(result.lastInsertRowid);
  }

  getProposal(id: number): ProposalRow | null {
    return this.db
      .query(`SELECT ${PROPOSAL_COLUMNS} FROM selfheal_proposals WHERE id = ?`)
      .get(id) as ProposalRow | null;
  }

  /** Proposals waiting for the user, oldest first. */
  pendingProposals(): ProposalRow[] {
    return this.db
      .query(
        `SELECT ${PROPOSAL_COLUMNS} FROM selfheal_proposals WHERE state = 'pending' ORDER BY id`,
      )
      .all() as ProposalRow[];
  }

  countPendingProposals(): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM selfheal_proposals WHERE state = 'pending'")
      .get() as { n: number };
    return row.n;
  }

  /** Decides a proposal that waits. False when it was decided before. */
  decideProposal(
    id: number,
    state: ProposalState,
    decided: { as?: string; reason?: string },
    now: number,
  ): boolean {
    const result = this.db
      .query(
        `UPDATE selfheal_proposals SET state = ?, decided_as = ?, refusal_reason = ?, decided_at = ?
         WHERE id = ? AND state = 'pending'`,
      )
      .run(state, decided.as ?? null, decided.reason ?? null, now, id);
    return result.changes > 0;
  }

  addMemory(memory: Omit<MemoryRow, "id" | "clearedAt">): void {
    this.db
      .query(
        "INSERT INTO selfheal_memory (role_key, summary, changes, reason, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(memory.roleKey, memory.summary, memory.changes, memory.reason, memory.createdAt);
  }

  /** The turned-down proposals that still count, for one role or for all; oldest first. */
  memory(roleKey?: string): MemoryRow[] {
    return (
      roleKey === undefined
        ? this.db.query(
            `SELECT ${MEMORY_COLUMNS} FROM selfheal_memory WHERE cleared_at IS NULL ORDER BY id`,
          )
        : this.db.query(
            `SELECT ${MEMORY_COLUMNS} FROM selfheal_memory
             WHERE cleared_at IS NULL AND role_key = ?1 ORDER BY id`,
          )
    ).all(...(roleKey === undefined ? [] : [roleKey])) as MemoryRow[];
  }

  /** Stops turned-down proposals from counting. No row is deleted. Returns how many. */
  clearMemory(now: number, roleKey?: string): number {
    const result =
      roleKey === undefined
        ? this.db
            .query("UPDATE selfheal_memory SET cleared_at = ? WHERE cleared_at IS NULL")
            .run(now)
        : this.db
            .query(
              "UPDATE selfheal_memory SET cleared_at = ? WHERE cleared_at IS NULL AND role_key = ?",
            )
            .run(now, roleKey);
    return result.changes;
  }

  getMeta(key: string): string | null {
    const row = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as {
      value: string;
    } | null;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) {
      this.db.query("DELETE FROM meta WHERE key = ?").run(key);
    } else {
      this.db
        .query(
          "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(key, value);
    }
  }

  close(): void {
    this.db.close();
  }
}
