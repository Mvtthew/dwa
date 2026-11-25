import { beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/daemon/db.ts";
import { MAX_REMINDERS, MAX_RESULT_LENGTH, Workflows } from "../src/daemon/workflows.ts";
import { Workspace } from "../src/daemon/workspace.ts";
import { claudeProvider } from "../src/providers/claude/launch.ts";
import { type Config, ConfigError } from "../src/shared/config.ts";
import type { AgentInfo, WorkflowRunInfo } from "../src/shared/protocol.ts";
import { parseWorkflow, revisionOf } from "../src/shared/workflow.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { testRoleFiles } from "./role-files.ts";

const config: Config = {
  keys: {},
  agents: [],
  layout: {},
  defaults: {},
  main: {},
  mcp: {},
  plugins: {},
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
  reviewed: `
[steps.build]
prompt = "Build {{input}}"
[steps.test]
depends_on = ["build"]
prompt = "Test {{steps.build.result}}"
[steps.review]
depends_on = ["test"]
reviews = "build"
max_rounds = 2
prompt = "Review {{steps.build.result}}"
[steps.ship]
depends_on = ["review"]
prompt = "Ship {{steps.review.result}}"
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
/** Roles that have no file. */
let absentRoles: string[];

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
    roleFiles: {
      ...testRoleFiles(),
      // Every role has a file, apart from the ones a test takes away.
      read: (path) => (absentRoles.some((role) => path.endsWith(`/${role}.toml`)) ? null : ""),
    },
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
  absentRoles = [];
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
  test("a run does not start when a step's role has no file", async () => {
    await workspace.up();
    absentRoles = ["explore"];
    await expect(workflows.start("chain", "x", "user")).rejects.toThrow(
      'Workflow "chain" uses a role with no file in .dwa/roles: explore.',
    );
    expect(await agents()).toEqual([]);
    expect(store.runningWorkflowRuns()).toEqual([]);
  });

  test("a step's own settings reach its session", async () => {
    DEFINITIONS.limited = '[steps.a]\nrole = "explore"\ndeny_tools = ["Bash"]\nprompt = "a"';
    await workspace.up();
    await workflows.start("limited", "x", "user");
    expect((await agent("a")).capabilities?.denyTools).toEqual(["Bash"]);
  });

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
    await expect(workflows.completeStepOf(2, "explore", "x")).rejects.toThrow(
      "There is no workflow run #2.",
    );
    await expect(workflows.completeStepOf(1, "nope", "x")).rejects.toThrow(
      'Workflow run #1 has no step "nope".',
    );
    await expect(workflows.completeStepOf(1, "build", "x")).rejects.toThrow(
      'Step "build" of workflow run #1 is pending, not running.',
    );
    await expect(workflows.failStepOf(1, "explore", " ")).rejects.toThrow("The reason is empty.");
    await workflows.settled();
    expect(states(workflows.status(1))).toEqual({ explore: "running", build: "pending" });
  });
});

describe("review loops", () => {
  const names = async () => (await agents()).map((entry) => entry.name);
  const complete = async (name: string, result: string) =>
    workflows.completeStep((await agent(name)).id, result);
  const reject = async (feedback: string) =>
    workflows.requestChanges((await agent("review")).id, feedback);
  /** Runs one pass up to the point where the review step is running. */
  const toReview = async (result: string) => {
    await complete("build", result);
    await complete("test", "tests pass");
  };
  const openQuestion = () => {
    const [question] = workspace.messaging.openQuestions();
    if (!question) throw new Error("no open question");
    return question;
  };
  const answer = async (text: string) => {
    workspace.messaging.answer(openQuestion().id, "user", text);
    await workflows.settled();
  };

  test("a review sends the work back to the session that did it", async () => {
    await workspace.up();
    await workflows.start("reviewed", "x", "user");
    const builder = await agent("build");
    await complete("build", "v1");
    expect(await names()).toEqual(["build", "test"]); // the builder waits for the review
    await complete("test", "tests pass");

    const sentBack = await reject("add a test for the empty case");
    expect(states(sentBack)).toEqual({
      build: "running",
      test: "pending",
      review: "pending",
      ship: "pending",
    });
    expect(sentBack.steps.map((step) => step.attempt)).toEqual([2, 2, 2, 1]);
    expect(await agents()).toEqual([expect.objectContaining({ id: builder.id })]);
    const [message] = store.pendingMessages(builder.id);
    expect(message?.body).toContain('was sent back by the review step "review" (pass 2)');
    expect(message?.body).toContain("add a test for the empty case");

    await toReview("v2");
    const reviewer = await agent("review");
    expect(reviewer.task).toContain("Review v2");
    expect(reviewer.task).toContain("This is review pass 2.");
    expect(reviewer.task).toContain("add a test for the empty case");
    expect(reviewer.task).toContain('call "request_changes" with your feedback');

    const approved = await complete("review", "looks good");
    expect(states(approved)).toMatchObject({ review: "done", ship: "running" });
    expect(await names()).toEqual(["ship"]); // approved: the builder is let go
    expect((await agent("ship")).task).toContain("Ship looks good");
    expect((await complete("ship", "shipped")).state).toBe("done");
  });

  test("a new agent redoes the work when the builder's session is gone", async () => {
    await workspace.up();
    await workflows.start("reviewed", "x", "user");
    await complete("build", "v1");
    await workspace.stop("build");
    await complete("test", "tests pass");
    const sentBack = await reject("handle the empty case");
    expect(states(sentBack)).toMatchObject({ build: "running", test: "pending" });

    const builder = await agent("build");
    expect(builder.task).toContain("Build x");
    expect(builder.task).toContain("a review sent it back (this is pass 2)");
    expect(builder.task).toContain("handle the empty case");
    expect(builder.task).toContain("The result of the previous pass:\n\nv1");
  });

  test("after the last pass the user decides, and may allow another pass or accept", async () => {
    await workspace.up();
    await workflows.start("reviewed", "x", "user");
    await toReview("v1");
    await reject("first");
    await toReview("v2");

    const waiting = await reject("second");
    expect(waiting.state).toBe("running");
    expect(waiting.steps[2]).toMatchObject({ state: "rejected", attempt: 2, needsAttention: true });
    expect(await names()).toEqual(["build"]);
    const question = openQuestion();
    expect(question).toMatchObject({ from: "workflow", to: "user" });
    expect(question.options).toEqual(["another pass", "accept", "fail"]);
    expect(question.question).toContain('still asks for changes to "build" after 2 passes');
    expect(question.question).toContain("second");

    await answer("what?");
    expect(openQuestion().question).toStartWith('"what?" is not one of the choices.');

    await answer("another pass");
    expect(states(workflows.status(1))).toMatchObject({ build: "running", review: "pending" });
    await toReview("v3");
    await reject("third");
    await answer("Accept");
    const run = workflows.status(1);
    expect(states(run)).toMatchObject({ review: "done", ship: "running" });
    expect(run.steps[2]?.result).toBe(
      "Accepted by the user after 3 review passes, with this feedback still open:\nthird",
    );
    expect(await names()).toEqual(["ship"]);
  });

  test("the user may fail the run, or cancel it while it waits", async () => {
    await workspace.up();
    await workflows.start("reviewed", "x", "user");
    await toReview("v1");
    await reject("first");
    await toReview("v2");
    await reject("second");
    await answer("fail");
    const failed = workflows.status(1);
    expect(failed.state).toBe("failed");
    expect(failed.steps[2]?.error).toBe("still asked for changes after 2 passes: second");
    expect(states(failed)).toMatchObject({ review: "failed", ship: "skipped" });
    expect(await agents()).toEqual([]);

    await workflows.start("reviewed", "y", "user");
    await toReview("v1");
    await reject("first");
    await toReview("v2");
    await reject("second");
    const cancelled = await workflows.cancel(2);
    expect(cancelled.state).toBe("cancelled");
    expect(states(cancelled)).toMatchObject({ review: "failed", ship: "skipped" });
    expect(workspace.messaging.openQuestions()).toEqual([]);
    expect(await agents()).toEqual([]);
  });

  test("the decision survives a daemon restart, and can be made by hand", async () => {
    await workspace.up();
    await workflows.start("reviewed", "x", "user");
    await toReview("v1");
    await reject("first");
    await toReview("v2");
    await reject("second");

    build();
    await workflows.resume();
    expect(workspace.messaging.openQuestions()).toHaveLength(1);
    const run = await workflows.completeStepOf(1, "review", "good enough");
    expect(states(run)).toMatchObject({ review: "done", ship: "running" });
    expect(workspace.messaging.openQuestions()).toEqual([]);
  });

  test("only a review step can ask for changes", async () => {
    await workspace.up();
    await workflows.start("reviewed", "x", "user");
    const builder = await agent("build");
    await expect(workflows.requestChanges(builder.id, "no")).rejects.toThrow(
      'Step "build" does not review another step.',
    );
    await toReview("v1");
    await expect(reject(" ")).rejects.toThrow("The feedback is empty.");
  });
});

describe("editing a run in progress", () => {
  const names = async () => (await agents()).map((entry) => entry.name);
  /** The run's definition with one piece of text replaced. */
  const edited = (runId: number, from: string, to: string) => {
    const text = workflows.definition(runId);
    if (!text.includes(from)) throw new Error(`"${from}" is not in the definition`);
    return text.replace(from, to);
  };

  test("the run's copy is TOML with a note on the state of the steps", async () => {
    await workspace.up();
    await workflows.start("chain", "x", "user");
    const text = workflows.definition(1);
    expect(text).toContain('# Workflow "chain", run #1');
    expect(text).toContain("# Now: explore running, build pending");
    expect(parseWorkflow(text, "chain")).toEqual(parseWorkflow(DEFINITIONS.chain ?? "", "chain"));
    expect(await workflows.edit(1, text, "user")).toMatchObject({ changes: [], applied: false });
  });

  test("the view of a run is its text and a revision, and an edit made from an old one is refused", async () => {
    await workspace.up();
    await workflows.start("chain", "x", "user");
    const view = workflows.view(1);
    expect(view.editable).toBe(true);
    expect(view.text).not.toContain("#");
    expect(parseWorkflow(view.text, "chain")).toEqual(
      parseWorkflow(DEFINITIONS.chain ?? "", "chain"),
    );
    expect(view.revision).toBe(revisionOf(view.text));

    const first = `${view.text}\n[steps.docs]\ndepends_on = ["build"]\nprompt = "Document it"\n`;
    expect((await workflows.edit(1, first, "user", false, view.revision)).applied).toBe(true);
    // Someone else still has the first text: their change must not undo this one.
    const second = view.text.replace("Build", "Construct");
    await expect(workflows.edit(1, second, "user", false, view.revision)).rejects.toThrow(
      "was changed by someone else meanwhile",
    );
    await expect(workflows.edit(1, second, "user", true, view.revision)).rejects.toThrow(
      "was changed by someone else meanwhile",
    );
    const now = workflows.view(1);
    expect(now.revision).not.toBe(view.revision);
    expect(Object.keys(parseWorkflow(now.text, "chain").steps)).toContain("docs");

    await workflows.cancel(1);
    expect(workflows.view(1).editable).toBe(false);
  });

  test("steps that have not started are changed, added and removed without a restart", async () => {
    await workspace.up();
    await workflows.start("chain", "x", "user");
    const text = `${edited(1, "Build {{input}} using", "Construct {{input}} from")}
[steps.docs]
depends_on = ["build"]
prompt = "Document it"
`;
    const preview = await workflows.edit(1, text, "user", true);
    expect(preview).toMatchObject({
      changes: ['added "docs"', 'changed "build"'],
      restarts: false,
      applied: false,
    });
    expect(workflows.status(1).steps.map((step) => step.id)).toEqual(["explore", "build"]);

    const applied = await workflows.edit(1, text, "user");
    expect(applied.applied).toBe(true);
    expect(states(applied.run)).toEqual({ explore: "running", build: "pending", docs: "pending" });
    await workflows.completeStep((await agent("explore")).id, "findings");
    expect((await agent("build")).task).toContain("Construct x from findings");

    const without = workflows.definition(1).replace(/\[steps\.docs\][\s\S]*$/, "");
    expect((await workflows.edit(1, without, "user")).changes).toEqual(['removed "docs"']);
    const done = await workflows.completeStep((await agent("build")).id, "built");
    expect(done.state).toBe("done");
    expect(userMessages()[0]).toContain('Result of "build":\nbuilt');
  });

  test("a changed step that has started runs again, with the started steps after it", async () => {
    await workspace.up();
    await workflows.start("reviewed", "x", "user");
    const firstBuilder = await agent("build");
    await workflows.completeStep(firstBuilder.id, "v1");
    const tester = await agent("test");

    const text = edited(1, "Build {{input}}", "Build {{input}} carefully");
    const preview = await workflows.edit(1, text, "user", true);
    expect(preview.changes).toEqual([
      '"build" runs again (it changed)',
      '"test" runs again (it comes after a changed step); its agent is stopped',
    ]);
    expect(preview.restarts).toBe(true);
    expect(states(workflows.status(1))).toMatchObject({ build: "done", test: "running" });

    const applied = await workflows.edit(1, text, "user");
    expect(states(applied.run)).toEqual({
      build: "running",
      test: "pending",
      review: "pending",
      ship: "pending",
    });
    expect(applied.run.steps.map((step) => step.attempt)).toEqual([2, 2, 1, 1]);
    const [builder, ...others] = await agents();
    expect(others).toEqual([]);
    expect(builder?.task).toContain("Build x carefully");
    expect([firstBuilder.id, tester.id]).not.toContain(builder?.id);

    await workflows.completeStep(builder?.id ?? "", "v2");
    expect((await agent("test")).task).toContain("Test v2");
  });

  test("settings that do not change the work never restart a step", async () => {
    await workspace.up();
    await workflows.start("reviewed", "x", "user");
    await workflows.completeStep((await agent("build")).id, "v1");
    const text = edited(
      1,
      'prompt = "Build {{input}}"',
      'keep_agent = true\nprompt = "Build {{input}}"',
    );
    const applied = await workflows.edit(1, text, "user");
    expect(applied).toMatchObject({
      changes: ['updated the settings of "build"'],
      restarts: false,
      applied: true,
    });
    expect(states(applied.run)).toMatchObject({ build: "done", test: "running" });
  });

  test("removing a running step stops its agent, and the run can end that way", async () => {
    await workspace.up();
    await workflows.start("chain", "x", "user");
    await workflows.completeStep((await agent("explore")).id, "findings");
    const text = workflows.definition(1).replace(/\[steps\.build\][\s\S]*$/, "");
    const applied = await workflows.edit(1, text, "user");
    expect(applied.changes).toEqual(['removed "build"; its agent is stopped']);
    expect(applied.restarts).toBe(true);
    expect(applied.run.state).toBe("done");
    expect(await names()).toEqual([]);
  });

  test("the user is told when an agent edits a run", async () => {
    await workspace.up();
    const main = (await workspace.state()).main;
    await workflows.start("chain", "x", "user");
    const text = edited(1, "Build {{input}} using", "Make {{input}} using");
    await workflows.edit(1, text, main?.id ?? "");
    expect(userMessages()).toEqual([
      'Agent "main" edited workflow "chain" (run #1):\n- changed "build"',
    ]);
  });

  test("refuses what cannot be applied", async () => {
    await workspace.up();
    await workflows.start("chain", "x", "user");
    const text = workflows.definition(1);
    await expect(workflows.edit(1, "[steps.a]\nprompt = 1", "user")).rejects.toThrow(ConfigError);
    await expect(
      workflows.edit(1, text.replace('depends_on = ["explore"]', 'depends_on = ["nope"]'), "user"),
    ).rejects.toThrow('run #1: step "build" depends on unknown step "nope"');
    await expect(workflows.edit(9, text, "user")).rejects.toThrow("There is no workflow run #9.");
    await workflows.cancel(1);
    await expect(workflows.edit(1, text, "user")).rejects.toThrow(
      "Workflow run #1 is cancelled; only a running run can be edited.",
    );
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
