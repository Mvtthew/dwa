import { beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/daemon/db.ts";
import { MAX_REMINDERS, MAX_RESULT_LENGTH, Workflows } from "../src/daemon/workflows.ts";
import { Workspace } from "../src/daemon/workspace.ts";
import { claudeProvider } from "../src/providers/claude/launch.ts";
import { type Config, ConfigError } from "../src/shared/config.ts";
import type { AgentInfo, WorkflowRunInfo } from "../src/shared/protocol.ts";
import { parseWorkflow } from "../src/shared/workflow.ts";
import { FakeTmux } from "./fake-tmux.ts";

const config: Config = {
  keys: {},
  agents: [],
  layout: {},
  defaults: {},
  main: {},
  default_profile: "me",
  profiles: { me: { command: "/bin/claude_me", args: [], env: {} } },
};

const DEFINITIONS: Record<string, string> = {
  chain: `
[steps.explore]
role = "explore"
prompt = "Explore: {{input}}"
[steps.build]
depends_on = ["explore"]
prompt = "Build {{input}} using {{steps.explore.result}}"
`,
  diamond: `
[steps.a]
prompt = "a"
[steps.b]
depends_on = ["a"]
prompt = "b"
[steps.c]
depends_on = ["a"]
prompt = "c"
[steps.d]
depends_on = ["b", "c"]
prompt = "d gets {{steps.b.result}} and {{steps.c.result}}"
`,
  keeper: `
[steps.only]
keep_agent = true
model = "haiku"
effort = "low"
prompt = "stay"
`,
  badprofile: `
[steps.only]
profile = "nope"
prompt = "x"
[steps.later]
depends_on = ["only"]
prompt = "y"
`,
};

let tmux: FakeTmux;
let store: Store;
let workspace: Workspace;
let workflows: Workflows;
let counter: number;

function build(): void {
  workspace = new Workspace({
    store,
    run: tmux.run,
    provider: claudeProvider,
    projectRoot: "/project",
    socketPath: "/tmp/dwa.sock",
    selfArgv: ["bun", "/dwa/cli.ts"],
    runDir: "/project/.dwa/run",
    writeFile: () => undefined,
    loadConfig: async () => config,
    readRole: () => ({}),
    schedule: () => undefined,
    env: {},
    newId: () => `id-${++counter}`,
    now: () => 1000 + counter,
  });
  workflows = new Workflows({
    store,
    workspace,
    projectRoot: "/project",
    now: () => 1000 + counter,
    load: (name) => {
      const text = DEFINITIONS[name];
      if (!text) throw new ConfigError(`Unknown workflow "${name}"`);
      return parseWorkflow(text, name);
    },
  });
}

beforeEach(() => {
  tmux = new FakeTmux();
  store = new Store(":memory:");
  counter = 0;
  build();
});

/** Lets queued engine work and the stops it asked for finish, then returns the agents. */
async function agents(): Promise<AgentInfo[]> {
  await workflows.settled();
  const state = await workspace.state();
  await workflows.settled();
  return state.agents;
}

async function agent(name: string): Promise<AgentInfo> {
  const found = (await agents()).find((entry) => entry.name === name);
  if (!found) throw new Error(`no agent ${name}`);
  return found;
}

function states(run: WorkflowRunInfo): Record<string, string> {
  return Object.fromEntries(run.steps.map((step) => [step.id, step.state]));
}

function userMessages(): string[] {
  return store.recentMessages("user", 10).map((message) => message.body);
}

describe("running a workflow", () => {
  test("starts each step as an agent when the steps before it are done", async () => {
    await workspace.up();
    const run = await workflows.start("chain", "a login page", "user");
    expect(run.state).toBe("running");
    expect(states(run)).toEqual({ explore: "running", build: "pending" });

    const explorer = await agent("explore");
    expect(explorer.role).toBe("explore");
    expect(explorer.task).toStartWith("Explore: a login page\n");
    expect(explorer.task).toContain('step "explore" of workflow "chain" (run #1)');
    expect(explorer.task).toContain("complete_step");
    expect((await agents()).map((entry) => entry.name)).toEqual(["explore"]);

    const afterExplore = await workflows.completeStep(explorer.id, "auth lives in auth.ts");
    expect(states(afterExplore)).toEqual({ explore: "done", build: "running" });
    const builder = await agent("build");
    expect(builder.task).toStartWith("Build a login page using auth lives in auth.ts\n");
    // The explorer's session ended with its step.
    expect((await agents()).map((entry) => entry.name)).toEqual(["build"]);

    const done = await workflows.completeStep(builder.id, "added login.ts");
    expect(done.state).toBe("done");
    expect(done.finishedAt).not.toBeNull();
    expect(await agents()).toEqual([]);
    expect(userMessages()).toEqual([
      'Workflow "chain" (run #1) done.\n\nResult of "build":\nadded login.ts',
    ]);
    expect((await workspace.state()).workflows.map((entry) => entry.state)).toEqual(["done"]);
  });

  test("runs independent steps side by side and joins them", async () => {
    await workspace.up();
    await workflows.start("diamond", "", "user");
    await workflows.completeStep((await agent("a")).id, "A");
    expect((await agents()).map((entry) => entry.name).sort()).toEqual(["b", "c"]);

    const afterB = await workflows.completeStep((await agent("b")).id, "B");
    expect(states(afterB)).toEqual({ a: "done", b: "done", c: "running", d: "pending" });

    await workflows.completeStep((await agent("c")).id, "C");
    expect((await agent("d")).task).toStartWith("d gets B and C\n");
  });

  test("reports to the agent that started the run", async () => {
    const state = await workspace.up();
    const main = state.main as AgentInfo;
    await workflows.start("keeper", "", main.id);
    await workflows.completeStep((await agent("only")).id, "kept");
    expect(store.pendingMessages(main.id).map((message) => message.body)).toEqual([
      'Workflow "keeper" (run #1) done.\n\nResult of "only":\nkept',
    ]);
    expect(userMessages()).toEqual([]);
    const argv = [...tmux.panes.values()].at(-1)?.argv ?? [];
    expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 4)).toEqual([
      "--model",
      "haiku",
      "--effort",
      "low",
    ]);
    // keep_agent leaves the session running.
    expect((await agents()).map((entry) => entry.name)).toEqual(["only"]);
    expect(workflows.status(1).startedBy).toBe("main");
  });

  test("refuses what cannot work", async () => {
    await expect(workflows.start("chain", "", "user")).rejects.toThrow(/not running/);
    const state = await workspace.up();
    await expect(workflows.start("nope", "", "user")).rejects.toThrow(/Unknown workflow/);

    await workflows.start("chain", "", "user");
    const explorer = await agent("explore");
    const main = state.main as AgentInfo;
    await expect(workflows.completeStep(main.id, "x")).rejects.toThrow(/not working on a workflow/);
    await expect(workflows.completeStep(explorer.id, "  ")).rejects.toThrow(/empty/);
    await expect(
      workflows.completeStep(explorer.id, "x".repeat(MAX_RESULT_LENGTH + 1)),
    ).rejects.toThrow(/too long/);
    await expect(workflows.failStep(explorer.id, "")).rejects.toThrow(/empty/);
    expect(states(workflows.status(1))).toEqual({ explore: "running", build: "pending" });
    expect(() => workflows.status(9)).toThrow(/no workflow run #9/);

    await workflows.completeStep(explorer.id, "ok");
    // A step can be completed once.
    await expect(workflows.completeStep(explorer.id, "again")).rejects.toThrow(/not working/);
  });
});

describe("when a step does not complete", () => {
  test("a failed step lets running steps finish and skips the rest", async () => {
    await workspace.up();
    await workflows.start("diamond", "", "user");
    await workflows.completeStep((await agent("a")).id, "A");
    const c = await agent("c");

    const afterFail = await workflows.failStep((await agent("b")).id, "tests do not pass");
    expect(afterFail.state).toBe("running");
    expect(states(afterFail)).toEqual({ a: "done", b: "failed", c: "running", d: "skipped" });
    expect((await agents()).map((entry) => entry.name)).toEqual(["c"]);

    const ended = await workflows.completeStep(c.id, "C");
    expect(ended.state).toBe("failed");
    expect(userMessages()).toEqual([
      'Workflow "diamond" (run #1) failed.\nStep "b" failed: tests do not pass',
    ]);
  });

  test("a step fails when its agent's session ends", async () => {
    await workspace.up();
    await workflows.start("chain", "", "user");
    await workspace.stop("explore");
    await workflows.settled();
    const run = workflows.status(1);
    expect(run.state).toBe("failed");
    expect(run.steps[0]?.error).toBe("the agent stopped before completing the step");
    expect(states(run)).toEqual({ explore: "failed", build: "skipped" });
  });

  test("a step whose agent cannot be started fails the run", async () => {
    await workspace.up();
    const run = await workflows.start("badprofile", "", "user");
    expect(run.state).toBe("failed");
    expect(run.steps[0]?.error).toContain('could not start the agent: Unknown profile "nope"');
    expect(states(run)).toEqual({ only: "failed", later: "skipped" });
  });

  test("ending a turn earns reminders, then the user is told, and nothing times out", async () => {
    await workspace.up();
    await workflows.start("chain", "", "user");
    const explorer = await agent("explore");
    const stop = async () => {
      workspace.hook({ agentId: explorer.id, event: "Stop", input: {} });
      await workflows.settled();
    };

    for (let turn = 1; turn <= MAX_REMINDERS; turn++) {
      await stop();
      expect(store.pendingMessages(explorer.id)).toHaveLength(turn);
    }
    expect(store.pendingMessages(explorer.id)[0]?.body).toContain('Step "explore" of workflow');
    expect(userMessages()).toEqual([]);
    expect(workflows.status(1).steps[0]?.needsAttention).toBe(false);

    await stop();
    await stop();
    expect(store.pendingMessages(explorer.id)).toHaveLength(MAX_REMINDERS);
    expect(userMessages()).toHaveLength(1);
    expect(userMessages()[0]).toContain('needs attention: agent "explore" keeps ending its turn');
    expect(workflows.status(1).steps[0]).toMatchObject({ state: "running", needsAttention: true });

    // The step can still be completed, however late.
    const run = await workflows.completeStep(explorer.id, "finally");
    expect(states(run)).toEqual({ explore: "done", build: "running" });
  });

  test("other agents' turns are not the engine's business", async () => {
    const state = await workspace.up();
    await workflows.start("chain", "", "user");
    const main = state.main as AgentInfo;
    workspace.hook({ agentId: main.id, event: "Stop", input: {} });
    await workflows.settled();
    expect(store.pendingMessages(main.id)).toEqual([]);
  });
});

describe("closing a step by hand", () => {
  test("the user completes a stuck step and the run carries on", async () => {
    await workspace.up();
    await workflows.start("chain", "", "user");
    const run = await workflows.completeStepOf(1, "explore", "found by hand");
    expect(states(run)).toEqual({ explore: "done", build: "running" });
    expect(run.steps[0]?.result).toBe("found by hand");
    expect((await agents()).map((entry) => entry.name)).toEqual(["build"]);
  });

  test("the user fails a step and the run fails", async () => {
    await workspace.up();
    await workflows.start("chain", "", "user");
    const run = await workflows.failStepOf(1, "explore", "wrong approach");
    expect(run.state).toBe("failed");
    expect(states(run)).toEqual({ explore: "failed", build: "skipped" });
    expect(run.steps[0]?.error).toBe("wrong approach");
    expect(await agents()).toEqual([]);
  });

  test("only a running step of an existing run can be closed", async () => {
    await workspace.up();
    await workflows.start("chain", "", "user");
    expect(workflows.completeStepOf(2, "explore", "x")).rejects.toThrow(
      "There is no workflow run #2.",
    );
    expect(workflows.completeStepOf(1, "nope", "x")).rejects.toThrow(
      'Workflow run #1 has no step "nope".',
    );
    expect(workflows.completeStepOf(1, "build", "x")).rejects.toThrow(
      'Step "build" of workflow run #1 is pending, not running.',
    );
    expect(workflows.failStepOf(1, "explore", " ")).rejects.toThrow("The reason is empty.");
    await workflows.settled();
    expect(states(workflows.status(1))).toEqual({ explore: "running", build: "pending" });
  });
});

describe("cancel", () => {
  test("stops the run's agents and starts nothing more", async () => {
    await workspace.up();
    await workflows.start("diamond", "", "user");
    await workflows.completeStep((await agent("a")).id, "A");

    const run = await workflows.cancel(1);
    expect(run.state).toBe("cancelled");
    expect(states(run)).toEqual({ a: "done", b: "failed", c: "failed", d: "skipped" });
    expect(await agents()).toEqual([]);
    expect(workflows.status(1).state).toBe("cancelled");
    await expect(workflows.cancel(1)).rejects.toThrow(/already cancelled/);
  });
});

describe("after a daemon restart", () => {
  test("a run carries on with the sessions that survived", async () => {
    await workspace.up();
    await workflows.start("diamond", "", "user");
    await workflows.completeStep((await agent("a")).id, "A");
    const b = await agent("b");
    const c = await agent("c");

    // The daemon is gone; meanwhile c's session dies. A new daemon opens the same store.
    await tmux.run(["kill-pane", "-t", c.paneId]);
    build();
    await workflows.resume();

    const resumed = workflows.status(1);
    expect(states(resumed)).toEqual({ a: "done", b: "running", c: "failed", d: "skipped" });
    expect(resumed.state).toBe("running");

    const ended = await workflows.completeStep(b.id, "B");
    expect(ended.state).toBe("failed");
  });

  test("steps that became ready while the daemon was away are started", async () => {
    await workspace.up();
    await workflows.start("chain", "", "user");
    const explorer = await agent("explore");
    // The step was recorded as done, but the daemon stopped before it could start the next one.
    store.finishStep(1, "explore", { state: "done", result: "R", now: 1 });

    build();
    await workflows.resume();
    expect(states(workflows.status(1))).toEqual({ explore: "done", build: "running" });
    expect((await agent("build")).task).toContain("using R");
    expect(explorer.name).toBe("explore");
  });
});
