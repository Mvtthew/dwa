import type { WorkflowRunInfo, WorkflowStepInfo, WorkflowStepState } from "../shared/protocol.ts";
import {
  loadWorkflow,
  readySteps,
  renderPrompt,
  type WorkflowDefinition,
} from "../shared/workflow.ts";
import type { Store, WorkflowRunRow, WorkflowStepRow } from "./db.ts";
import { WorkspaceError } from "./errors.ts";
import { USER, WORKFLOW } from "./messaging.ts";
import type { Workspace } from "./workspace.ts";

/** Reminders an agent gets for ending a turn without completing its step, before the user is told. */
export const MAX_REMINDERS = 2;

/** Longest step result. Results travel to later steps inside their first prompt. */
export const MAX_RESULT_LENGTH = 32_000;

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

function nameOf(store: Store, id: string): string {
  return id === USER ? USER : (store.getAgentName(id) ?? "unknown");
}

function runInfo(store: Store, run: WorkflowRunRow): WorkflowRunInfo {
  const definition = definitionOf(run);
  const steps: WorkflowStepInfo[] = store.workflowSteps(run.id).map((step) => ({
    id: step.stepId,
    state: step.state,
    dependsOn: definition.steps[step.stepId]?.depends_on ?? [],
    agent: step.agentId ? store.getAgentName(step.agentId) : null,
    result: step.result,
    error: step.error,
    needsAttention: step.state === "running" && step.reminders > MAX_REMINDERS,
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
 */
export class Workflows {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly load: (name: string) => WorkflowDefinition;

  constructor(private readonly deps: WorkflowsDeps) {
    this.now = deps.now ?? Date.now;
    this.load = deps.load ?? ((name) => loadWorkflow(deps.projectRoot, name));
    // Listeners run inside the workspace's tmux queue: only enqueue here, never wait.
    deps.workspace.onAgentEvent((event) => {
      const handle =
        event.type === "turn_ended"
          ? () => this.turnEnded(event.agentId)
          : () => this.agentStopped(event.agentId);
      this.serial(handle).catch((error) => console.error(error));
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
    return this.serial(async () => {
      const step = this.requireStep(agentId);
      if (result.trim() === "") throw new WorkspaceError("The result is empty.");
      if (result.length > MAX_RESULT_LENGTH) {
        throw new WorkspaceError(
          `The result is too long (${result.length} characters, the limit is ${MAX_RESULT_LENGTH}). Give a shorter result, or write the details to a file and name its path.`,
        );
      }
      this.deps.store.finishStep(step.runId, step.stepId, {
        state: "done",
        result,
        now: this.now(),
      });
      return this.afterStep(step, agentId);
    });
  }

  /** The calling agent cannot finish its step. The run fails. */
  failStep(agentId: string, reason: string): Promise<WorkflowRunInfo> {
    return this.serial(async () => {
      const step = this.requireStep(agentId);
      if (reason.trim() === "") throw new WorkspaceError("The reason is empty.");
      this.deps.store.finishStep(step.runId, step.stepId, {
        state: "failed",
        error: reason,
        now: this.now(),
      });
      return this.afterStep(step, agentId);
    });
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
      const running = store.workflowSteps(runId).filter((step) => step.state === "running");
      store.skipPendingSteps(runId, now);
      for (const step of running) {
        store.finishStep(runId, step.stepId, { state: "failed", error: "cancelled", now });
      }
      store.finishWorkflowRun(runId, "cancelled", now);
      for (const step of running) if (step.agentId) this.stopAgent(step.agentId);
      return this.status(runId);
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

  private async afterStep(step: WorkflowStepRow, agentId: string): Promise<WorkflowRunInfo> {
    const run = this.requireRun(step.runId);
    await this.advance(step.runId);
    if (!definitionOf(run).steps[step.stepId]?.keep_agent) this.stopAgent(agentId);
    return this.status(step.runId);
  }

  /** Starts every step that is ready, and ends the run when nothing is left to do. */
  private async advance(runId: number): Promise<void> {
    const { store, workspace } = this.deps;
    const run = store.getWorkflowRun(runId);
    if (run?.state !== "running") return;
    const definition = definitionOf(run);
    const failed = (steps: WorkflowStepRow[]) => steps.some((step) => step.state === "failed");

    let steps = store.workflowSteps(runId);
    if (!failed(steps)) {
      const states: Record<string, WorkflowStepState> = {};
      const results: Record<string, string | null> = {};
      for (const step of steps) {
        states[step.stepId] = step.state;
        results[step.stepId] = step.result;
      }
      for (const stepId of readySteps(definition, states)) {
        const step = definition.steps[stepId];
        if (!step || !store.startStep(runId, stepId, this.now())) continue;
        try {
          const agent = await workspace.spawn({
            name: stepId,
            role: step.role,
            profile: step.profile,
            task: this.task(run, stepId, renderPrompt(step.prompt, run.input, results)),
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
      steps = store.workflowSteps(runId);
    }
    if (steps.some((step) => step.state === "pending" || step.state === "running")) return;
    if (store.finishWorkflowRun(runId, failed(steps) ? "failed" : "done", this.now())) {
      this.report(runId);
    }
  }

  /** The first prompt of a step's session: the step's own prompt plus how to end the step. */
  private task(run: WorkflowRunRow, stepId: string, prompt: string): string {
    return [
      prompt,
      "",
      "---",
      `[dwa] This is step "${stepId}" of workflow "${run.name}" (run #${run.id}). When the work is finished, call the dwa tool "complete_step" with the result that later steps need. If you cannot finish it, call "fail_step" with the reason. Ending your turn does not complete the step.`,
    ].join("\n");
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
}
