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
];

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

/** Events kept in the log; older ones are dropped. */
const MAX_EVENTS = 5000;

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

  /** Latest messages addressed to someone and sent at or after `since`, newest first. */
  recentMessages(toId: string, limit: number, since = 0): MessageRow[] {
    return this.db
      .query(
        `SELECT ${MESSAGE_COLUMNS} FROM messages
         WHERE to_id = ? AND created_at >= ? ORDER BY id DESC LIMIT ?`,
      )
      .all(toId, since, limit) as MessageRow[];
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
  finishWorkflowRun(id: number, state: WorkflowRunState, now: number): boolean {
    const { changes } = this.db
      .query(
        "UPDATE workflow_runs SET state = ?, finished_at = ? WHERE id = ? AND state = 'running'",
      )
      .run(state, now, id);
    return changes > 0;
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
