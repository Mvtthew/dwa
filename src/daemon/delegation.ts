import { snippet } from "./activity.ts";
import type { HandoverRow, Store } from "./db.ts";
import { WorkspaceError } from "./errors.ts";
import { USER, WORKSPACE } from "./messaging.ts";
import { checkLength, MAX_REMINDERS } from "./workflows.ts";
import type { Workspace } from "./workspace.ts";

export interface DelegationDeps {
  store: Store;
  workspace: Workspace;
  now?: () => number;
}

/** How the message that carries a result begins. */
const RESULT_OF = "Result of ";

/**
 * What is added to the task of a session another session starts: who waits for the result and
 * how to hand it over. It is part of the stored task, so a session started afresh reads it again.
 */
export function reportSuffix(spawner: string, keep: boolean): string {
  const after = keep
    ? "Your session stays open after that; report each later task the same way."
    : "Your session ends after that.";
  return [
    "",
    "",
    "---",
    `[dwa] "${spawner}" started you for this task and is waiting for its result. When the work is finished, call the dwa tool "finish_task" with the result; make it complete and self-contained, it is all "${spawner}" gets. ${after} If you cannot finish, call "finish_task" and say what stopped you. If you need a decision first, put the question to "${spawner}" with "ask", not to the user: "${spawner}" answers it or takes it to the user. Ending your turn does not finish the task.`,
  ].join("\n");
}

/**
 * Work handed over outside workflows: a session that another session started with
 * `spawn_agent` owes it a result, reports it with `finish_task`, and ends unless it was
 * started to be kept.
 *
 * Like a workflow step, such a session finishes only by saying so (or by being stopped). The
 * end of a turn is not the end of the task; it earns a reminder, and after a few the one who
 * waits is told. Nothing here ever stops a session that has not reported. Everything is in the
 * agent's row, so it holds across a daemon restart.
 *
 * Only rows with a spawner are touched: the user's own agents, those of the config and
 * workflow steps are none of this class's business.
 */
export class Delegation {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  /** Sessions whose spawner is stopping them itself: it need not be told that they stopped. */
  private readonly quiet = new Set<string>();

  constructor(private readonly deps: DelegationDeps) {
    this.now = deps.now ?? Date.now;
    // Listeners run inside the workspace's tmux queue: only enqueue here, never wait.
    deps.workspace.onAgentEvent((event) => {
      const handle =
        event.type === "turn_ended"
          ? () => this.turnEnded(event.agentId)
          : () => this.agentStopped(event.agentId);
      this.serial(handle).catch((error) => console.error(error));
    });
  }

  private serial<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Resolves when everything queued so far has been handled. */
  settled(): Promise<void> {
    return this.serial(() => undefined);
  }

  /** After a daemon start: ends the sessions that had reported when the daemon went away. */
  async resume(): Promise<void> {
    for (const row of this.deps.store.reportedAndRunning()) this.stop(row.id);
  }

  /**
   * A session reports the result of the task it was started for. The result goes to whoever
   * waits for it, the user gets a line about it, and the session ends unless it is kept.
   * Returns what to tell the session.
   */
  finish(agentId: string, result: string): Promise<string> {
    return this.serial(() => {
      const { store, workspace } = this.deps;
      if (store.runningStepOf(agentId)) {
        throw new WorkspaceError(
          'This session is a step of a workflow: hand over its result with "complete_step".',
        );
      }
      const row = store.handover(agentId);
      if (row?.state !== "running") {
        throw new WorkspaceError(
          "Nobody is waiting for a result from this session (it was not started with spawn_agent). Use send_message to tell someone what you did.",
        );
      }
      const keep = row.keep === 1;
      if (row.finishedAt !== null && !keep) return "Already reported; this session is ending.";
      if (result.trim() === "") throw new WorkspaceError("The result is empty.");
      checkLength(result, "result");
      if (!keep) {
        // Ending now would cancel a question someone is blocked on.
        const waiting = store.openQuestions().find((question) => question.toId === agentId);
        if (waiting) {
          throw new WorkspaceError(
            `Question #${waiting.id} from ${workspace.messaging.nameOf(waiting.fromId)} is waiting for your answer; answer it first.`,
          );
        }
      }

      const to = this.recipient(row);
      const spawner = workspace.messaging.nameOf(row.spawnedBy);
      const lines = [
        keep
          ? `${RESULT_OF}"${row.name}" (its session stays open; end it with stop_agent when you need it no more):`
          : `${RESULT_OF}"${row.name}" (its session has ended):`,
      ];
      if (to !== row.spawnedBy) {
        lines.push(`It was started by "${spawner}", which has ended, so its result comes to you.`);
      }
      lines.push("", result);
      const children = keep ? [] : store.owedTo(agentId).map((child) => child.name);
      if (children.length > 0) {
        lines.push(
          "",
          `Still running, started by "${row.name}": ${children.join(", ")}. Their results will come to you.`,
        );
      }
      workspace.messaging.send(agentId, to, lines.join("\n"));
      if (to !== USER) {
        const line = snippet(result) ?? "";
        workspace.messaging.send(agentId, USER, `${keep ? "reported" : "finished"}: ${line}`);
      }
      store.setFinished(agentId, this.now());
      const whom = to === USER ? "the user" : workspace.messaging.nameOf(to);
      if (keep) return `Result delivered to ${whom}. This session stays open.`;
      this.stop(agentId);
      return `Result delivered to ${whom}. This session ends now.`;
    });
  }

  /**
   * What became of a session that is no longer running, for the one that waits for it
   * (`wait_for`). A result that has not reached the caller yet is handed over here, since a
   * message would only arrive once the caller's turn is over.
   */
  outcome(target: string, callerId: string): string {
    const { store } = this.deps;
    const row = store.lastStoppedHandover(target, callerId);
    if (!row) return `${target} is not running.`;
    if (row.finishedAt === null) return `${row.name} stopped without a result.`;
    const result = store
      .pendingMessages(callerId)
      .find((message) => message.fromId === row.id && message.body.startsWith(RESULT_OF));
    if (!result) {
      return `${row.name} finished and its session ended. Its result was sent to you as a message.`;
    }
    store.markDelivered([result.id], this.now());
    return result.body;
  }

  /**
   * Called before a session is stopped on someone's request (`by` is an agent id or the
   * user). The one who started a session does not need a message that it stopped.
   */
  expectStop(agentId: string, by: string): void {
    const row = this.deps.store.handover(agentId);
    if (row && row.spawnedBy === by && row.finishedAt === null) this.quiet.add(agentId);
  }

  /**
   * Who gets what a session has to say about its task: the session that started it while that
   * runs, otherwise the nearest one up the chain that still does, in the end the user.
   */
  private recipient(row: HandoverRow): string {
    return this.runningAncestor(row) ?? USER;
  }

  private runningAncestor(row: HandoverRow): string | null {
    const { store } = this.deps;
    const seen = new Set<string>([row.id]);
    let id: string | null = row.spawnedBy;
    while (id !== null && !seen.has(id)) {
      if (store.getRunning(id)) return id;
      seen.add(id);
      id = store.handover(id)?.spawnedBy ?? null;
    }
    return null;
  }

  /** A turn ended. A session that still owes its result is reminded; after a few times the one who waits is told. */
  private turnEnded(agentId: string): void {
    const { store, workspace } = this.deps;
    const row = store.handover(agentId);
    if (row?.state !== "running" || row.finishedAt !== null) return;
    if (store.runningStepOf(agentId)) return;
    // Waiting for an answer, or for sessions it started itself, is not being idle.
    if (store.openQuestions().some((question) => question.fromId === agentId)) return;
    if (store.owedTo(agentId).length > 0) return;
    // Someone has spoken to it since the last reminder, so the count starts again.
    const last = store.lastMessageTo(agentId);
    if (row.reminders > 0 && last && last.fromId !== WORKSPACE) {
      store.resetHandoverReminders(agentId);
    }
    const count = store.addHandoverReminder(agentId);
    const spawner = workspace.messaging.nameOf(row.spawnedBy);
    try {
      if (count <= MAX_REMINDERS) {
        workspace.messaging.send(
          WORKSPACE,
          agentId,
          `The task "${spawner}" started you for is still open. If the work is finished, call "finish_task" with the result. If you cannot finish it, call "finish_task" and say what stopped you. If you are waiting for someone, use "ask" instead of ending your turn.`,
        );
      } else if (count === MAX_REMINDERS + 1) {
        const said = row.detail ? ` It last said: ${row.detail}` : "";
        workspace.messaging.send(
          WORKSPACE,
          this.recipient(row),
          `Agent "${row.name}" is idle and has not reported a result with "finish_task".${said}\nSend it a message to get it going again, or end it with stop_agent.`,
        );
      }
    } catch (error) {
      console.error(error);
    }
  }

  /** A session is gone. If it still owed its result, a session that waits for it is told. */
  private agentStopped(agentId: string): void {
    const row = this.deps.store.handover(agentId);
    if (!row || row.finishedAt !== null) return;
    if (this.quiet.delete(agentId)) return;
    // Never the user: they see it go, and stopping the workspace would fill the inbox.
    const to = this.runningAncestor(row);
    if (to === null) return;
    try {
      this.deps.workspace.messaging.send(
        WORKSPACE,
        to,
        `Agent "${row.name}" stopped without reporting a result.`,
      );
    } catch (error) {
      console.error(error);
    }
  }

  /** Not awaited: the reply to the session's own tool call should not wait for its pane to die. */
  private stop(agentId: string): void {
    if (!this.deps.store.getRunning(agentId)) return;
    this.deps.workspace.stop(agentId).catch(() => undefined);
  }
}
