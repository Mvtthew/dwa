import { Database } from "bun:sqlite";
import type { AgentActivity, AgentKind, AgentState } from "../shared/protocol.ts";

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
];

const COLUMNS = `id, kind, name, role, profile, session_id AS sessionId, pane_id AS paneId,
  state, task, created_at AS createdAt, activity, detail, activity_since AS activitySince,
  progress`;

const MESSAGE_COLUMNS = `id, from_id AS fromId, to_id AS toId, body, created_at AS createdAt,
  delivered_at AS deliveredAt`;

const QUESTION_COLUMNS = `id, from_id AS fromId, to_id AS toId, question, options, state, answer,
  answered_by AS answeredBy, created_at AS createdAt, answered_at AS answeredAt`;

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

  /** Latest messages addressed to someone, newest first. */
  recentMessages(toId: string, limit: number): MessageRow[] {
    return this.db
      .query(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE to_id = ? ORDER BY id DESC LIMIT ?`)
      .all(toId, limit) as MessageRow[];
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
