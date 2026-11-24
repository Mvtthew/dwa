import type { MessageInfo, QuestionInfo } from "../shared/protocol.ts";
import type { TmuxRunner } from "../tmux/driver.ts";
import { snippet } from "./activity.ts";
import type { AgentRow, QuestionRow, Store } from "./db.ts";
import { WorkspaceError } from "./errors.ts";

/** The id used for the person at the keyboard, as sender or recipient. */
export const USER = "user";

/** How long a message waits for the mailbox hook before it is pasted into an idle session. */
const PASTE_FALLBACK_MS = 3000;

export interface MessagingDeps {
  store: Store;
  run: TmuxRunner;
  now: () => number;
  /** Shortcut prefix, for the hint shown when a question for the user arrives. */
  keyPrefix: string;
  /** Replaced in tests to run the paste fallback at once (or never). */
  schedule?: (callback: () => void, ms: number) => void;
}

type MailboxWaiter = (messages: string[]) => void;
type QuestionWaiter = (question: QuestionRow) => void;

/**
 * Messages and questions between agents and the user.
 *
 * Delivery to a session goes through its mailbox hook: a background hook that waits here and,
 * when a message arrives, wakes the session with it (docs/spikes.md, S3). If no hook is waiting
 * and the session is idle, the text is pasted into its prompt instead. Questions are stored and
 * never expire; whoever asked waits until an answer or a cancellation.
 */
export class Messaging {
  private readonly mailboxes = new Map<string, MailboxWaiter>();
  private readonly questionWaiters = new Map<number, Set<QuestionWaiter>>();
  private readonly schedule: (callback: () => void, ms: number) => void;

  constructor(private readonly deps: MessagingDeps) {
    this.schedule = deps.schedule ?? ((callback, ms) => void setTimeout(callback, ms));
  }

  /** Resolves "user", an agent name or an agent id to an id. Agents must be running. */
  resolve(target: string): string {
    if (target === USER) return USER;
    const agent = this.deps.store.running().find((row) => row.name === target || row.id === target);
    if (!agent) {
      const names = this.deps.store
        .running()
        .map((row) => row.name)
        .join(", ");
      throw new WorkspaceError(
        `No running agent "${target}". Use "user" or one of: ${names || "none"}.`,
      );
    }
    return agent.id;
  }

  nameOf(id: string): string {
    return id === USER ? USER : (this.deps.store.getAgentName(id) ?? "unknown");
  }

  /** Sends a message. Returns once it is stored; delivery follows on its own. */
  send(fromId: string, to: string, body: string): { id: number; to: string } {
    if (body.trim() === "") throw new WorkspaceError("The message is empty.");
    const toId = this.resolve(to);
    if (toId === fromId) throw new WorkspaceError("A message to yourself would go nowhere.");
    const id = this.deps.store.addMessage({ fromId, toId, body, createdAt: this.deps.now() });
    if (toId === USER) {
      // The user reads these in the status pane; there is nothing to wake.
      this.deps.store.markDelivered([id], this.deps.now());
      this.notifyUser(`${this.nameOf(fromId)}: ${snippet(body, 80) ?? ""}`);
    } else {
      this.flush(toId);
    }
    return { id, to: this.nameOf(toId) };
  }

  /** Stores a question and tells its addressee. The caller then waits with `waitQuestion`. */
  ask(fromId: string, to: string, question: string, options: string[] | null): QuestionRow {
    if (question.trim() === "") throw new WorkspaceError("The question is empty.");
    const toId = this.resolve(to);
    if (toId === fromId) throw new WorkspaceError("You cannot ask yourself.");
    const { store } = this.deps;
    const id = store.addQuestion({ fromId, toId, question, options, createdAt: this.deps.now() });
    const from = this.nameOf(fromId);
    if (toId === USER) {
      this.notifyUser(
        `${from} asks: ${snippet(question, 60) ?? ""}  (${this.deps.keyPrefix} then q)`,
      );
    } else {
      const lines = [`Question #${id}: ${question}`];
      if (options?.length) lines.push(`Suggested answers: ${options.join(" | ")}`);
      lines.push(
        `${from} is waiting for your answer. Give it with the dwa "answer" tool (question_id: ${id}).`,
      );
      store.addMessage({ fromId, toId, body: lines.join("\n"), createdAt: this.deps.now() });
      this.flush(toId);
    }
    return store.getQuestion(id) as QuestionRow;
  }

  /** Answers an open question. Only its addressee or the user may answer. */
  answer(id: number, byId: string, answer: string): QuestionRow {
    const question = this.requireQuestion(id);
    if (byId !== USER && byId !== question.toId) {
      throw new WorkspaceError(`Question #${id} is not addressed to you.`);
    }
    if (answer.trim() === "") throw new WorkspaceError("The answer is empty.");
    return this.close(question, { state: "answered", answer, by: byId });
  }

  cancel(id: number, byId: string, reason: string | null = null): QuestionRow {
    return this.close(this.requireQuestion(id), { state: "cancelled", answer: reason, by: byId });
  }

  /** Resolves when the question is answered or cancelled, however long that takes. */
  waitQuestion(id: number, signal?: AbortSignal): Promise<QuestionRow> {
    const question = this.requireQuestion(id);
    if (question.state !== "open") return Promise.resolve(question);
    return new Promise((resolve) => {
      const waiters = this.questionWaiters.get(id) ?? new Set();
      this.questionWaiters.set(id, waiters);
      waiters.add(resolve);
      signal?.addEventListener("abort", () => waiters.delete(resolve));
    });
  }

  /**
   * Called by an agent's mailbox hook. Resolves with the messages to show the session, or with
   * an empty list when a newer hook has taken over.
   */
  waitMailbox(agentId: string, signal?: AbortSignal): Promise<string[]> {
    const ready = this.take(agentId);
    if (ready.length > 0) return Promise.resolve(ready);
    return new Promise((resolve) => {
      this.mailboxes.get(agentId)?.([]);
      this.mailboxes.set(agentId, resolve);
      signal?.addEventListener("abort", () => {
        if (this.mailboxes.get(agentId) === resolve) this.mailboxes.delete(agentId);
      });
    });
  }

  /** An agent's session ended: nobody will answer its questions or read answers to them. */
  agentStopped(agentId: string): void {
    this.mailboxes.get(agentId)?.([]);
    this.mailboxes.delete(agentId);
    for (const question of this.deps.store.openQuestions()) {
      if (question.fromId === agentId) {
        this.close(question, { state: "cancelled", answer: "the asking agent stopped", by: USER });
      } else if (question.toId === agentId) {
        this.close(question, {
          state: "cancelled",
          answer: `${this.nameOf(agentId)} stopped before answering`,
          by: USER,
        });
      }
    }
  }

  openQuestions(): QuestionInfo[] {
    return this.deps.store.openQuestions().map((question) => ({
      id: question.id,
      from: this.nameOf(question.fromId),
      to: this.nameOf(question.toId),
      fromId: question.fromId,
      toId: question.toId,
      question: question.question,
      options: question.options ? (JSON.parse(question.options) as string[]) : [],
      createdAt: question.createdAt,
    }));
  }

  /** Latest messages sent to the user, newest first. */
  inbox(limit: number): MessageInfo[] {
    return this.deps.store.recentMessages(USER, limit).map((message) => ({
      id: message.id,
      from: this.nameOf(message.fromId),
      body: message.body,
      createdAt: message.createdAt,
    }));
  }

  /** Hands pending messages to the agent's mailbox hook, or arranges the paste fallback. */
  flush(agentId: string): void {
    const waiter = this.mailboxes.get(agentId);
    if (waiter) {
      const messages = this.take(agentId);
      if (messages.length === 0) return;
      this.mailboxes.delete(agentId);
      waiter(messages);
      return;
    }
    this.schedule(() => void this.pasteIfIdle(agentId), PASTE_FALLBACK_MS);
  }

  /** Marks the agent's pending messages delivered and returns them as display text. */
  private take(agentId: string): string[] {
    const pending = this.deps.store.pendingMessages(agentId);
    if (pending.length === 0) return [];
    this.deps.store.markDelivered(
      pending.map((message) => message.id),
      this.deps.now(),
    );
    return pending.map((message) => this.format(message.fromId, message.body));
  }

  private format(fromId: string, body: string): string {
    const from = fromId === USER ? "the user" : `agent "${this.nameOf(fromId)}"`;
    return `[dwa] Message from ${from}:\n${body}`;
  }

  /** Fallback when no mailbox hook is connected: type the message into an idle session. */
  private async pasteIfIdle(agentId: string): Promise<void> {
    if (this.mailboxes.has(agentId)) return this.flush(agentId);
    const agent: AgentRow | null = this.deps.store.getRunning(agentId);
    if (agent?.activity !== "idle") return; // stays queued for the next hook
    const messages = this.take(agentId);
    if (messages.length === 0) return;
    const { run } = this.deps;
    const buffer = `dwa-${agentId}`;
    try {
      await run(["set-buffer", "-b", buffer, "--", messages.join("\n\n")]);
      await run(["paste-buffer", "-p", "-d", "-b", buffer, "-t", agent.paneId]);
      await Bun.sleep(300);
      await run(["send-keys", "-t", agent.paneId, "Enter"]);
    } catch (error) {
      console.error(`paste delivery to ${agent.name} failed:`, error);
    }
  }

  private close(
    question: QuestionRow,
    result: { state: "answered" | "cancelled"; answer: string | null; by: string },
  ): QuestionRow {
    const { store } = this.deps;
    if (!store.closeQuestion(question.id, { ...result, now: this.deps.now() })) {
      throw new WorkspaceError(`Question #${question.id} is already ${question.state}.`);
    }
    const closed = store.getQuestion(question.id) as QuestionRow;
    const waiters = this.questionWaiters.get(question.id);
    this.questionWaiters.delete(question.id);
    if (waiters && waiters.size > 0) {
      for (const waiter of waiters) waiter(closed);
    } else if (question.fromId !== USER && store.getRunning(question.fromId)) {
      // The asker's tool call is no longer open (it was interrupted), so send the outcome.
      const outcome =
        closed.state === "answered"
          ? `Answer to your question #${closed.id} ("${snippet(closed.question, 60)}"): ${closed.answer}`
          : `Your question #${closed.id} was cancelled${closed.answer ? `: ${closed.answer}` : "."}`;
      store.addMessage({
        fromId: result.by,
        toId: question.fromId,
        body: outcome,
        createdAt: this.deps.now(),
      });
      this.flush(question.fromId);
    }
    return closed;
  }

  private requireQuestion(id: number): QuestionRow {
    const question = this.deps.store.getQuestion(id);
    if (!question) throw new WorkspaceError(`There is no question #${id}.`);
    return question;
  }

  private notifyUser(message: string): void {
    this.deps.run(["display-message", "-d", "5000", message]).catch(() => undefined);
  }
}
