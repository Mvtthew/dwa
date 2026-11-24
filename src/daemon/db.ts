import { Database } from "bun:sqlite";
import type { AgentKind, AgentState } from "../shared/protocol.ts";

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
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
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
);
`;

const COLUMNS = `id, kind, name, role, profile, session_id AS sessionId, pane_id AS paneId,
  state, task, created_at AS createdAt`;

/** Persistent state of one project's workspace. Pass ":memory:" in tests. */
export class Store {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  insertAgent(row: AgentRow): void {
    this.db
      .query(
        `INSERT INTO agents (id, kind, name, role, profile, session_id, pane_id, state, task, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  markStopped(id: string, now: number): void {
    this.db.query("UPDATE agents SET state = 'stopped', stopped_at = ? WHERE id = ?").run(now, id);
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
