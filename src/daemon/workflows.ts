import { ConfigError, pickCapabilities } from "../shared/capabilities.ts";
import type {
  WorkflowEdit,
  WorkflowRunInfo,
  WorkflowStepInfo,
  WorkflowStepState,
} from "../shared/protocol.ts";
import {
  DEFAULT_MAX_ROUNDS,
  dependents,
  formatWorkflow,
  loadWorkflow,
  parseWorkflow,
  readySteps,
  renderPrompt,
  reworkSteps,
  sameWork,
  type WorkflowDefinition,
} from "../shared/workflow.ts";
import { noticeWorkflowEdits } from "../shared/workflow-edit.ts";
import type { QuestionRow, Store, WorkflowRunRow, WorkflowStepRow } from "./db.ts";
import { WorkspaceError } from "./errors.ts";
import { USER, WORKFLOW } from "./messaging.ts";
import type { Workspace } from "./workspace.ts";

/** Reminders an agent gets for ending a turn without completing its step, before the user is told. */
export const MAX_REMINDERS = 2;

/** Longest step result. Results travel to later steps inside their first prompt. */
export const MAX_RESULT_LENGTH = 32_000;

/** What the user can answer when a review still asks for changes after its last pass. */
export const DECISIONS = ["another pass", "accept", "fail"] as const;

/** Finished runs that stay visible in the workspace state next to the running ones. */
const VISIBLE_FINISHED_RUNS = 3;

export interface WorkflowsDeps {
  store: Store;
  workspace: Workspace;
  projectRoot: string;
  now?: () => number;
  /** Reads a definition by name; replaced in tests. */
  load?: (name: string) => WorkflowDefinition;
}

function definitionOf(run: WorkflowRunRow): WorkflowDefinition {
  return JSON.parse(run.definition) as WorkflowDefinition;
}

function checkLength(text: string, what: string): void {
  if (text.length <= MAX_RESULT_LENGTH) return;
  throw new WorkspaceError(
    `The ${what} is too long (${text.length} characters, the limit is ${MAX_RESULT_LENGTH}). Give a shorter ${what}, or write the details to a file and name its path.`,
  );
}

function passes(count: number, kind = ""): string {
  return `${count} ${kind}${count === 1 ? "pass" : "passes"}`;
}

function nameOf(store: Store, id: string): string {
  return id === USER ? USER : (store.getAgentName(id) ?? "unknown");
}

function runInfo(store: Store, run: WorkflowRunRow): WorkflowRunInfo {
  const definition = definitionOf(run);
  const order = Object.keys(definition.steps);
  const rows = store.workflowSteps(run.id);
  rows.sort((a, b) => order.indexOf(a.stepId) - order.indexOf(b.stepId));
  const steps: WorkflowStepInfo[] = rows.map((step) => ({
    id: step.stepId,
    state: step.state,
    attempt: step.attempt,
    dependsOn: definition.steps[step.stepId]?.depends_on ?? [],
    agent: step.agentId ? store.getAgentName(step.agentId) : null,
    result: step.result,
    error: step.error,
    needsAttention:
      step.state === "rejected" || (step.state === "running" && step.reminders > MAX_REMINDERS),
  }));
  return {
    id: run.id,
    name: run.name,
    input: run.input,
    state: run.state,
    startedBy: nameOf(store, run.startedBy),
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    steps,
  };
}

/** Runs in progress and the latest finished ones, newest first. */
export function workflowRuns(store: Store): WorkflowRunInfo[] {
  return store.visibleWorkflowRuns(VISIBLE_FINISHED_RUNS).map((run) => runInfo(store, run));
}

/**
 * Runs workflows: a workflow is a graph of steps, and each step is an ordinary interactive agent
 * session that starts when the steps it depends on are done.
 *
 * A step ends only when its agent says so with `complete_step` or `fail_step` (or when its
 * session is gone). The end of a turn is not completion; it earns the agent a reminder. All
 * state is in the store, so a run continues after a daemon restart.
 *
 * A step with `reviews` may instead send the reviewed step back with `request_changes`. The
 * reviewed step, the steps between it and the review, and the review get a new attempt; the
 * session that did the reviewed step is kept until the review approves, so it does the next pass
 * with its context. After `max_rounds` passes the user decides.
 *
 * A run works from its own copy of the definition, which `edit` replaces while the run is in
 * progress: steps that have not started simply follow the new text, and a changed step that has
 * started runs again, together with every started step after it.
 */
export class Workflows {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly load: (name: string) => WorkflowDefinition;

  constructor(private readonly deps: WorkflowsDeps) {
    this.now = deps.now ?? Date.now;
    this.load =
      deps.load ??
      ((name) => {
        // What the run starts from is a version, so it can be found again later.
        noticeWorkflowEdits({ projectRoot: deps.projectRoot });
        return loadWorkflow(deps.projectRoot, name);
      });
    // Listeners run inside the workspace's tmux queue: only enqueue here, never wait.
    deps.workspace.onAgentEvent((event) => {
      const handle =
        event.type === "turn_ended"
          ? () => this.turnEnded(event.agentId)
          : () => this.agentStopped(event.agentId);
      this.serial(handle).catch((error) => console.error(error));
    });
    deps.workspace.messaging.onQuestionClosed((question) => {
      if (question.fromId !== WORKFLOW) return;
      this.serial(() => this.decided(question)).catch((error) => console.error(error));
    });
  }

  /** Changes to runs must not interleave, or two completions could start the same step twice. */
  private serial<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Resolves when everything queued so far has been handled. */
  settled(): Promise<void> {
    return this.serial(() => undefined);
  }

  runs(): WorkflowRunInfo[] {
    return workflowRuns(this.deps.store);
  }

  status(runId: number): WorkflowRunInfo {
    return runInfo(this.deps.store, this.requireRun(runId));
  }

  /** Starts a run of the named workflow. `byId` is who gets the report when it ends. */
  async start(name: string, input: string, byId: string): Promise<WorkflowRunInfo> {
    const definition = this.load(name);
    // A step whose role does not exist would only fail when its turn comes, deep into the run.
    const roles = Object.values(definition.steps).flatMap((step) => (step.role ? [step.role] : []));
    const unknown = this.deps.workspace.unknownRoles(roles);
    if (unknown.length > 0) {
      throw new ConfigError(
        `Workflow "${name}" uses ${unknown.length === 1 ? "a role" : "roles"} with no file in .dwa/roles: ${unknown.join(", ")}.`,
      );
    }
    if (!(await this.deps.workspace.state()).up) {
      throw new WorkspaceError("The workspace is not running. Start it with `dwa up`.");
    }
    return this.serial(async () => {
      const id = this.deps.store.addWorkflowRun(
        {
          name: definition.name,
          definition: JSON.stringify(definition),
          input,
          startedBy: byId,
          createdAt: this.now(),
        },
        Object.keys(definition.steps),
      );
      await this.advance(id);
      return this.status(id);
    });
  }

  /** The calling agent finished its step; `result` is what later steps receive. */
  completeStep(agentId: string, result: string): Promise<WorkflowRunInfo> {
    return this.serial(() => this.complete(this.requireStep(agentId), result));
  }

  /** The calling agent cannot finish its step. The run fails. */
  failStep(agentId: string, reason: string): Promise<WorkflowRunInfo> {
    return this.serial(() => this.fail(this.requireStep(agentId), reason));
  }

  /**
   * The calling agent reviewed a step and wants it redone. Every review pass is a new agent, so
   * the caller's session ends either way.
   */
  requestChanges(agentId: string, feedback: string): Promise<WorkflowRunInfo> {
    return this.serial(async () => {
      const { store } = this.deps;
      const step = this.requireStep(agentId);
      const run = this.requireRun(step.runId);
      const definition = definitionOf(run);
      const review = definition.steps[step.stepId];
      if (!review?.reviews) {
        throw new WorkspaceError(
          `Step "${step.stepId}" does not review another step. Use "complete_step" or "fail_step".`,
        );
      }
      if (feedback.trim() === "") throw new WorkspaceError("The feedback is empty.");
      checkLength(feedback, "feedback");
      const now = this.now();
      if (store.workflowSteps(run.id).some((row) => row.state === "failed")) {
        // Nothing new starts in a run that has failed, so there is nobody to send the work to.
        store.finishStep(run.id, step.stepId, {
          state: "failed",
          error: `asked for changes after the run had failed: ${feedback}`,
          now,
        });
      } else {
        store.finishStep(run.id, step.stepId, { state: "rejected", result: feedback, now });
        if (step.attempt < (review.max_rounds ?? DEFAULT_MAX_ROUNDS)) {
          this.sendBack(run, step.stepId, feedback);
        } else {
          this.askUser(run, { ...step, state: "rejected", result: feedback });
        }
      }
      await this.advance(run.id);
      this.stopAgent(agentId);
      return this.status(run.id);
    });
  }

  /**
   * The user's decision about a review that used up its passes, given outside the question
   * queue ("another pass", "accept" or "fail"). It answers the question the engine asked.
   */
  decide(runId: number, stepId: string, decision: string): WorkflowRunInfo {
    const step = this.deps.store.workflowSteps(runId).find((row) => row.stepId === stepId);
    this.requireRun(runId);
    if (step?.state !== "rejected" || step.questionId === null) {
      throw new WorkspaceError(`Step "${stepId}" of workflow run #${runId} waits for no decision.`);
    }
    if (!(DECISIONS as readonly string[]).includes(decision)) {
      throw new WorkspaceError(`Unknown decision "${decision}": use ${DECISIONS.join(", ")}.`);
    }
    this.deps.workspace.messaging.answer(step.questionId, USER, decision);
    return this.status(runId);
  }

  /** The user closes an open step by hand, for an agent that will not do it itself. */
  completeStepOf(runId: number, stepId: string, result: string): Promise<WorkflowRunInfo> {
    return this.serial(() => this.complete(this.requireOpenStep(runId, stepId), result));
  }

  /** The user fails an open step by hand. The run fails. */
  failStepOf(runId: number, stepId: string, reason: string): Promise<WorkflowRunInfo> {
    return this.serial(() => this.fail(this.requireOpenStep(runId, stepId), reason));
  }

  /** Stops a run: its agents are stopped and nothing further starts. */
  cancel(runId: number): Promise<WorkflowRunInfo> {
    return this.serial(() => {
      const { store } = this.deps;
      const run = this.requireRun(runId);
      if (run.state !== "running") {
        throw new WorkspaceError(`Workflow run #${runId} is already ${run.state}.`);
      }
      const now = this.now();
      const steps = store.workflowSteps(runId);
      const running = steps.filter((step) => step.state === "running");
      store.skipPendingSteps(runId, now);
      for (const step of steps) {
        if (step.state === "running" || step.state === "rejected") {
          this.close(step, { state: "failed", error: "cancelled" });
        }
      }
      store.finishWorkflowRun(runId, "cancelled", now);
      for (const step of running) if (step.agentId) this.stopAgent(step.agentId);
      this.release(runId);
      return this.status(runId);
    });
  }

  /** A run's own copy of its definition as TOML, with a header that explains editing. */
  definition(runId: number): string {
    const run = this.status(runId);
    const steps = run.steps.map((step) => `${step.id} ${step.state}`).join(", ");
    return formatWorkflow(definitionOf(this.requireRun(runId)), [
      `Workflow "${run.name}", run #${run.id}: this run's own copy. The workflow file is not changed.`,
      "",
      "Steps that have not started can be changed, removed or added freely.",
      "Changing a step that has started makes it run again, with every started step after it;",
      "agents working on those steps are stopped. keep_agent and max_rounds never cause that.",
      "",
      `Now: ${steps}`,
    ]);
  }

  /**
   * Replaces a running run's definition with `text` (TOML). With `preview` nothing is changed
   * and the result says what would happen.
   */
  edit(runId: number, text: string, byId: string, preview = false): Promise<WorkflowEdit> {
    return this.serial(async () => {
      const { store, workspace } = this.deps;
      const run = this.requireRun(runId);
      if (run.state !== "running") {
        throw new WorkspaceError(
          `Workflow run #${runId} is ${run.state}; only a running run can be edited.`,
        );
      }
      const before = definitionOf(run);
      const after = parseWorkflow(text, run.name, `run #${runId}`);
      const rows = new Map(store.workflowSteps(runId).map((row) => [row.stepId, row]));
      if ([...rows.values()].some((row) => row.state === "failed")) {
        throw new WorkspaceError(
          `Workflow run #${runId} has a failed step and is ending; it cannot be edited.`,
        );
      }
      const started = (id: string) => (rows.get(id)?.state ?? "pending") !== "pending";
      const running = (id: string) => rows.get(id)?.state === "running";

      const kept = Object.keys(after.steps).filter((id) => id in before.steps);
      const added = Object.keys(after.steps).filter((id) => !(id in before.steps));
      const removed = Object.keys(before.steps).filter((id) => !(id in after.steps));
      const differs = (id: string) =>
        JSON.stringify(before.steps[id]) !== JSON.stringify(after.steps[id]);
      const reworked = kept.filter((id) => {
        const [old, now] = [before.steps[id], after.steps[id]];
        return old && now && !sameWork(old, now);
      });
      const changedStarted = reworked.filter(started);
      const redo = new Set([
        ...changedStarted,
        ...dependents(after, changedStarted).filter(started),
      ]);

      const changes: string[] = [];
      const stops = (id: string) => (running(id) ? "; its agent is stopped" : "");
      for (const id of added) changes.push(`added "${id}"`);
      for (const id of removed) changes.push(`removed "${id}"${stops(id)}`);
      for (const id of kept) {
        if (redo.has(id)) {
          const why = changedStarted.includes(id) ? "it changed" : "it comes after a changed step";
          changes.push(`"${id}" runs again (${why})${stops(id)}`);
        } else if (reworked.includes(id)) {
          changes.push(`changed "${id}"`);
        } else if (differs(id)) {
          changes.push(`updated the settings of "${id}"`);
        }
      }
      if (changes.length === 0 && before.description !== after.description) {
        changes.push("changed the description");
      }
      const restarts = redo.size > 0 || removed.some(started);
      if (preview || changes.length === 0) {
        return { run: this.status(runId), changes, restarts, applied: false };
      }

      const now = this.now();
      for (const id of removed) {
        const row = rows.get(id);
        if (row?.state === "rejected") this.close(row, { state: "failed", error: "removed" });
        if (row?.agentId) this.stopAgent(row.agentId);
        store.deleteWorkflowStep(runId, id);
      }
      for (const id of redo) {
        const row = rows.get(id);
        if (!row) continue;
        // The attempt so far becomes history; it must not stay open.
        if (row.state === "running" || row.state === "rejected") {
          this.close(row, { state: "failed", error: "redone after an edit" });
        }
        if (row.agentId) this.stopAgent(row.agentId);
        store.addStepAttempt(runId, id, row.attempt + 1, { now });
      }
      for (const id of added) store.addStepAttempt(runId, id, 1, { now });
      store.setWorkflowDefinition(runId, JSON.stringify(after));

      if (byId !== USER) {
        try {
          workspace.messaging.send(
            WORKFLOW,
            USER,
            `Agent "${nameOf(store, byId)}" edited workflow "${run.name}" (run #${runId}):\n${changes.map((change) => `- ${change}`).join("\n")}`,
          );
        } catch (error) {
          console.error(error);
        }
      }
      await this.advance(runId);
      return { run: this.status(runId), changes, restarts, applied: true };
    });
  }

  /**
   * Called once when the daemon starts. Steps whose session did not survive are failed, and
   * steps that became ready while the daemon was away are started.
   */
  async resume(): Promise<void> {
    // Brings the stored agents in line with the panes that still exist.
    await this.deps.workspace.state();
    await this.serial(async () => {
      const { store } = this.deps;
      for (const run of store.runningWorkflowRuns()) {
        for (const step of store.workflowSteps(run.id)) {
          if (step.state === "rejected") {
            // The decision may have been made, or the question lost, while the daemon was away.
            const question = step.questionId ? store.getQuestion(step.questionId) : null;
            if (!question) this.askUser(run, step);
            else if (question.state !== "open") await this.decided(question);
            continue;
          }
          if (step.state !== "running") continue;
          if (step.agentId && store.getRunning(step.agentId)) continue;
          store.finishStep(run.id, step.stepId, {
            state: "failed",
            error: "the agent was gone when the daemon restarted",
            now: this.now(),
          });
        }
        await this.advance(run.id);
      }
    });
  }

  private async complete(step: WorkflowStepRow, result: string): Promise<WorkflowRunInfo> {
    if (result.trim() === "") throw new WorkspaceError("The result is empty.");
    checkLength(result, "result");
    this.close(step, { state: "done", result });
    await this.advance(step.runId);
    return this.status(step.runId);
  }

  private async fail(step: WorkflowStepRow, reason: string): Promise<WorkflowRunInfo> {
    if (reason.trim() === "") throw new WorkspaceError("The reason is empty.");
    this.close(step, { state: "failed", error: reason });
    await this.advance(step.runId);
    return this.status(step.runId);
  }

  /** Ends an open step: a running one, or a review waiting for the user's decision. */
  private close(
    step: WorkflowStepRow,
    outcome: { state: "done" | "failed"; result?: string; error?: string },
  ): void {
    const { store, workspace } = this.deps;
    const now = this.now();
    if (step.state !== "rejected") {
      store.finishStep(step.runId, step.stepId, { ...outcome, now });
      return;
    }
    store.resolveRejectedStep(step.runId, step.stepId, step.attempt, { ...outcome, now });
    if (step.questionId === null) return;
    try {
      workspace.messaging.cancel(step.questionId, USER, "decided another way");
    } catch {
      // Already answered: that answer is what brought us here.
    }
  }

  /**
   * Gives the reviewed step, the steps between it and the review, and the review a new attempt.
   * The session that did the reviewed step carries on if it is still there.
   */
  private sendBack(run: WorkflowRunRow, reviewer: string, feedback: string): void {
    const { store, workspace } = this.deps;
    const definition = definitionOf(run);
    const target = definition.steps[reviewer]?.reviews;
    const rows = new Map(store.workflowSteps(run.id).map((row) => [row.stepId, row]));
    const now = this.now();
    for (const id of reworkSteps(definition, reviewer)) {
      const row = rows.get(id);
      if (!row) continue;
      const attempt = row.attempt + 1;
      if (id !== target) {
        // The next review pass is told what this one asked for.
        const note = id === reviewer ? feedback : undefined;
        store.addStepAttempt(run.id, id, attempt, { feedback: note, now });
        continue;
      }
      const agentId = row.agentId && store.getRunning(row.agentId) ? row.agentId : undefined;
      store.addStepAttempt(run.id, id, attempt, { agentId, feedback, now });
      if (!agentId) continue; // advance() starts a new agent with the feedback in its prompt
      try {
        workspace.messaging.send(
          WORKFLOW,
          agentId,
          `Step "${id}" of workflow "${run.name}" (run #${run.id}) was sent back by the review step "${reviewer}" (pass ${attempt}). Deal with the feedback below, then call "complete_step" again with the new result.\n\n${feedback}`,
        );
      } catch (error) {
        console.error(error);
      }
    }
  }

  /** The review used up its passes: the user decides, however long that takes. */
  private askUser(run: WorkflowRunRow, step: WorkflowStepRow, note = ""): void {
    const { store, workspace } = this.deps;
    const target = definitionOf(run).steps[step.stepId]?.reviews;
    const question = workspace.messaging.ask(
      WORKFLOW,
      USER,
      `${note}Workflow "${run.name}" (run #${run.id}): review step "${step.stepId}" still asks for changes to "${target}" after ${passes(step.attempt)}. Another pass, accept the work as it is, or fail the run?\n\nThe feedback:\n${step.result ?? ""}`,
      [...DECISIONS],
    );
    store.setStepQuestion(run.id, step.stepId, step.attempt, question.id);
  }

  /** The user answered (or cancelled) the question about a review that used up its passes. */
  private async decided(question: QuestionRow): Promise<void> {
    const { store } = this.deps;
    const asked = store.stepOfQuestion(question.id);
    if (!asked) return;
    const step = store.workflowSteps(asked.runId).find((row) => row.stepId === asked.stepId);
    if (step?.state !== "rejected" || step.questionId !== question.id) return;
    const run = store.getWorkflowRun(step.runId);
    if (run?.state !== "running") return;

    const feedback = step.result ?? "";
    const answer = (question.answer ?? "").trim();
    const choice = question.state === "answered" ? answer.toLowerCase() : "fail";
    if (/^(another|again|retry|one more|pass)/.test(choice)) {
      this.sendBack(run, step.stepId, feedback);
    } else if (choice.startsWith("accept")) {
      this.close(step, {
        state: "done",
        result: `Accepted by the user after ${passes(step.attempt, "review ")}, with this feedback still open:\n${feedback}`,
      });
    } else if (choice.startsWith("fail")) {
      this.close(step, {
        state: "failed",
        error: `still asked for changes after ${passes(step.attempt)}: ${feedback}`,
      });
    } else {
      this.askUser(run, step, `"${answer}" is not one of the choices. `);
      return;
    }
    await this.advance(run.id);
  }

  /** Starts every step that is ready, ends the run when nothing is left, and stops idle agents. */
  private async advance(runId: number): Promise<void> {
    await this.startReady(runId);
    this.release(runId);
  }

  /**
   * Stops the sessions of finished steps. A session is kept when its step says `keep_agent`, and
   * while its step waits for a review that may still send it back.
   */
  private release(runId: number): void {
    const { store } = this.deps;
    const run = store.getWorkflowRun(runId);
    if (!run) return;
    const definition = definitionOf(run);
    const rows = store.workflowSteps(runId);
    const open = new Set(
      rows
        .filter((row) => ["pending", "running", "rejected"].includes(row.state))
        .map((row) => row.stepId),
    );
    const underReview = (stepId: string) =>
      run.state === "running" &&
      Object.entries(definition.steps).some(
        ([id, step]) => step.reviews === stepId && open.has(id),
      );
    for (const row of rows) {
      if (!row.agentId || row.state === "pending" || row.state === "running") continue;
      if (definition.steps[row.stepId]?.keep_agent) continue;
      if (row.state === "done" && underReview(row.stepId)) continue;
      this.stopAgent(row.agentId);
    }
  }

  private async startReady(runId: number): Promise<void> {
    const { store, workspace } = this.deps;
    const run = store.getWorkflowRun(runId);
    if (run?.state !== "running") return;
    const definition = definitionOf(run);
    const failed = (steps: WorkflowStepRow[]) => steps.some((step) => step.state === "failed");

    let steps = store.workflowSteps(runId);
    if (!failed(steps)) {
      const states: Record<string, WorkflowStepState> = {};
      const results: Record<string, string | null> = {};
      const rows = new Map(steps.map((step) => [step.stepId, step]));
      for (const step of steps) {
        states[step.stepId] = step.state;
        results[step.stepId] = step.result;
      }
      for (const stepId of readySteps(definition, states)) {
        const step = definition.steps[stepId];
        const row = rows.get(stepId);
        if (!step || !row || !store.startStep(runId, stepId, this.now())) continue;
        try {
          const agent = await workspace.spawn({
            name: stepId,
            role: step.role,
            profile: step.profile,
            ...pickCapabilities(step),
            task: this.task(run, row, renderPrompt(step.prompt, run.input, results)),
          });
          store.setStepAgent(runId, stepId, agent.id);
        } catch (error) {
          store.finishStep(runId, stepId, {
            state: "failed",
            error: `could not start the agent: ${(error as Error).message}`,
            now: this.now(),
          });
        }
      }
      steps = store.workflowSteps(runId);
    }

    // After a failure nothing new starts; steps already running are left to finish.
    if (failed(steps)) {
      store.skipPendingSteps(runId, this.now());
      for (const step of steps) {
        // A decision about a review is moot once the run has failed.
        if (step.state === "rejected") {
          this.close(step, { state: "failed", error: "the run failed before a decision was made" });
        }
      }
      steps = store.workflowSteps(runId);
    }
    if (steps.some((step) => ["pending", "running", "rejected"].includes(step.state))) return;
    if (store.finishWorkflowRun(runId, failed(steps) ? "failed" : "done", this.now())) {
      this.report(runId);
    }
  }

  /**
   * The first prompt of a step's session: the step's own prompt, the review feedback when this is
   * a later pass, and how to end the step.
   */
  private task(run: WorkflowRunRow, row: WorkflowStepRow, prompt: string): string {
    const stepId = row.stepId;
    const reviews = definitionOf(run).steps[stepId]?.reviews;
    const lines = [prompt];
    if (row.feedback && reviews) {
      lines.push(
        "",
        "---",
        `This is review pass ${row.attempt}. The previous pass sent "${reviews}" back with the feedback below, and it has been redone. Check that the feedback was dealt with.`,
        "",
        row.feedback,
      );
    } else if (row.feedback) {
      const previous = this.deps.store.workflowStepAttempt(run.id, stepId, row.attempt - 1);
      lines.push(
        "",
        "---",
        `This step was done before and a review sent it back (this is pass ${row.attempt}). Deal with this feedback:`,
        "",
        row.feedback,
      );
      if (previous?.result) lines.push("", "The result of the previous pass:", "", previous.result);
    }
    const ending = reviews
      ? `This step reviews step "${reviews}". To approve, call the dwa tool "complete_step" with the result that later steps need. To send "${reviews}" back for another pass, call "request_changes" with your feedback. If you cannot review it at all, call "fail_step" with the reason.`
      : `When the work is finished, call the dwa tool "complete_step" with the result that later steps need. If you cannot finish it, call "fail_step" with the reason.`;
    lines.push(
      "",
      "---",
      `[dwa] This is step "${stepId}" of workflow "${run.name}" (run #${run.id}). ${ending} Ending your turn does not complete the step.`,
    );
    return lines.join("\n");
  }

  /** A turn ended. If the agent still owes a step, remind it; after a few times tell the user. */
  private turnEnded(agentId: string): void {
    const { store, workspace } = this.deps;
    const step = store.runningStepOf(agentId);
    if (!step) return;
    const run = store.getWorkflowRun(step.runId);
    if (!run) return;
    const count = store.addStepReminder(step.runId, step.stepId);
    try {
      if (count <= MAX_REMINDERS) {
        workspace.messaging.send(
          WORKFLOW,
          agentId,
          `Step "${step.stepId}" of workflow "${run.name}" (run #${run.id}) is still open. If the work is finished, call "complete_step" with the result. If you cannot finish it, call "fail_step" with the reason. If you are waiting for someone, use "ask" instead of ending your turn.`,
        );
      } else if (count === MAX_REMINDERS + 1) {
        workspace.messaging.send(
          WORKFLOW,
          USER,
          `Step "${step.stepId}" of workflow "${run.name}" (run #${run.id}) needs attention: agent "${nameOf(store, agentId)}" keeps ending its turn without completing the step.`,
        );
      }
    } catch (error) {
      console.error(error);
    }
  }

  /** A session is gone. A step it had not completed fails. */
  private async agentStopped(agentId: string): Promise<void> {
    const step = this.deps.store.runningStepOf(agentId);
    if (!step) return;
    this.deps.store.finishStep(step.runId, step.stepId, {
      state: "failed",
      error: "the agent stopped before completing the step",
      now: this.now(),
    });
    await this.advance(step.runId);
  }

  /** Tells whoever started the run how it ended. */
  private report(runId: number): void {
    const { store, workspace } = this.deps;
    const run = this.status(runId);
    const lines = [`Workflow "${run.name}" (run #${run.id}) ${run.state}.`];
    if (run.state === "done") {
      // The results nobody consumed are the workflow's output.
      const consumed = new Set(run.steps.flatMap((step) => step.dependsOn));
      for (const step of run.steps) {
        if (!consumed.has(step.id)) lines.push("", `Result of "${step.id}":`, step.result ?? "");
      }
    } else {
      for (const step of run.steps) {
        if (step.state === "failed") lines.push(`Step "${step.id}" failed: ${step.error ?? ""}`);
      }
    }
    const body = lines.join("\n");
    const starter = store.getWorkflowRun(runId)?.startedBy ?? USER;
    try {
      workspace.messaging.send(WORKFLOW, starter, body);
    } catch {
      // The agent that started the run is gone; the user is the one left to tell.
      if (starter !== USER) workspace.messaging.send(WORKFLOW, USER, body);
    }
  }

  /** Not awaited: the reply to the agent's own tool call should not wait for its pane to die. */
  private stopAgent(agentId: string): void {
    if (!this.deps.store.getRunning(agentId)) return;
    this.deps.workspace.stop(agentId).catch(() => undefined);
  }

  private requireRun(runId: number): WorkflowRunRow {
    const run = this.deps.store.getWorkflowRun(runId);
    if (!run) throw new WorkspaceError(`There is no workflow run #${runId}.`);
    return run;
  }

  private requireStep(agentId: string): WorkflowStepRow {
    const step = this.deps.store.runningStepOf(agentId);
    if (!step) throw new WorkspaceError("You are not working on a workflow step.");
    return step;
  }

  /** A step the user may close by hand: running, or a review waiting for their decision. */
  private requireOpenStep(runId: number, stepId: string): WorkflowStepRow {
    this.requireRun(runId);
    const step = this.deps.store.workflowSteps(runId).find((row) => row.stepId === stepId);
    if (!step) throw new WorkspaceError(`Workflow run #${runId} has no step "${stepId}".`);
    if (step.state !== "running" && step.state !== "rejected") {
      throw new WorkspaceError(
        `Step "${stepId}" of workflow run #${runId} is ${step.state}, not running.`,
      );
    }
    return step;
  }
}
