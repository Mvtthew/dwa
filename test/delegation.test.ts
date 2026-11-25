import { beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../src/daemon/db.ts";
import { Delegation } from "../src/daemon/delegation.ts";
import { MAX_REMINDERS, Workflows } from "../src/daemon/workflows.ts";
import { Workspace } from "../src/daemon/workspace.ts";
import { claudeProvider } from "../src/providers/claude/launch.ts";
import type { Config } from "../src/shared/config.ts";
import type { AgentInfo } from "../src/shared/protocol.ts";
import { parseWorkflow } from "../src/shared/workflow.ts";
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

/** The main session's id: the first one the workspace makes. */
const MAIN = "id-1";

let tmux: FakeTmux;
let store: Store;
let workspace: Workspace;
let workflows: Workflows;
let delegation: Delegation;
let counter: number;

beforeEach(async () => {
  tmux = new FakeTmux();
  store = new Store(":memory:");
  counter = 0;
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
    roleFiles: testRoleFiles(),
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
    load: (name) => parseWorkflow('[steps.only]\nrole = "explore"\nprompt = "Look"', name),
  });
  delegation = new Delegation({ store, workspace, now: () => 1000 + counter });
  await workspace.up();
});

/** Lets queued work and the stops it asked for finish, then returns the agents. */
async function agents(): Promise<AgentInfo[]> {
  await delegation.settled();
  await workflows.settled();
  const state = await workspace.state();
  await delegation.settled();
  return state.agents;
}

async function names(): Promise<string[]> {
  return (await agents()).map((agent) => agent.name);
}

/** Starts a session the way `spawn_agent` does for the session `from`. */
function handOver(name: string, from = MAIN, more: { keep?: boolean } = {}): Promise<AgentInfo> {
  return workspace.spawn({ name, role: "explore", task: `Do ${name}`, from, ...more });
}

async function turnEnds(agentId: string): Promise<void> {
  workspace.hook({ agentId, event: "Stop", input: {} });
  await delegation.settled();
}

/** Messages waiting for a session, as text. */
function mail(agentId: string): string[] {
  return store.pendingMessages(agentId).map((message) => message.body);
}

/** How many reminders to report are waiting for a session. */
function reminders(agentId: string): number {
  return store.pendingMessages(agentId).filter((message) => message.fromId === "workspace").length;
}

function inbox(): string[] {
  return store
    .recentMessages("user", 20)
    .map((message) => `${store.getAgentName(message.fromId) ?? message.fromId}: ${message.body}`)
    .reverse();
}

describe("a session another session starts", () => {
  test("is told in its task to report, and who started it is recorded", async () => {
    const dev = await handOver("dev");
    expect(store.handover(dev.id)).toMatchObject({ spawnedBy: MAIN, keep: 0, finishedAt: null });
    const task = [...tmux.panes.values()].at(-1)?.argv.at(-1) ?? "";
    expect(task).toStartWith('Do dev\n\n---\n[dwa] "main" started you for this task');
    expect(task).toContain('call the dwa tool "finish_task" with the result');
    expect(task).toContain("Your session ends after that.");

    const kept = await handOver("kept", MAIN, { keep: true });
    expect(store.handover(kept.id)).toMatchObject({ keep: 1 });
    expect([...tmux.panes.values()].at(-1)?.argv.at(-1)).toContain(
      "Your session stays open after that; report each later task the same way.",
    );
  });

  test("the user's own agents and workflow steps owe nothing", async () => {
    const mine = await workspace.spawn({ name: "mine", task: "Do it", keep: true });
    expect(store.handover(mine.id)).toBeNull();
    expect([...tmux.panes.values()].at(-1)?.argv.at(-1)).toBe("Do it");
    // Someone who is not running cannot be owed anything either.
    const orphan = await workspace.spawn({ name: "orphan", task: "Do it", from: "gone" });
    expect(store.handover(orphan.id)).toBeNull();

    await workflows.start("one", "", MAIN);
    const step = (await agents()).find((agent) => agent.name === "only");
    expect(step && store.handover(step.id)).toBeNull();
    await turnEnds(step?.id ?? "");
    await workflows.settled();
    // The engine's reminder and nothing from here.
    expect(mail(step?.id ?? "")).toHaveLength(1);
    expect(mail(step?.id ?? "")[0]).toContain('Step "only" of workflow');
    await expect(delegation.finish(step?.id ?? "", "x")).rejects.toThrow(/"complete_step"/);
    await expect(delegation.finish(mine.id, "x")).rejects.toThrow(
      /Nobody is waiting for a result from this session/,
    );
  });
});

describe("finish_task", () => {
  test("hands the result to the spawner, tells the user and ends the session", async () => {
    const dev = await handOver("dev");
    expect(await delegation.finish(dev.id, "Fixed the parser.\nTests pass.")).toBe(
      "Result delivered to main. This session ends now.",
    );
    expect(await names()).toEqual([]);
    expect(mail(MAIN)).toEqual([
      'Result of "dev" (its session has ended):\n\nFixed the parser.\nTests pass.',
    ]);
    expect(inbox()).toEqual(["dev: finished: Fixed the parser."]);
    // Ended as any stopped session: the row stays, with what a later reopening needs.
    expect(store.handover(dev.id)).toMatchObject({ state: "stopped", spawnedBy: MAIN });
    expect(store.handover(dev.id)?.finishedAt).not.toBeNull();
    expect(store.getLaunch(dev.id)).not.toBeNull();
    // The spawner is not told that it stopped as well.
    expect(mail(MAIN)).toHaveLength(1);
  });

  test("a kept session stays, can report again and is not reminded afterwards", async () => {
    const dev = await handOver("dev", MAIN, { keep: true });
    expect(await delegation.finish(dev.id, "First.")).toBe(
      "Result delivered to main. This session stays open.",
    );
    expect(await names()).toEqual(["dev"]);
    expect(mail(MAIN)[0]).toStartWith(
      'Result of "dev" (its session stays open; end it with stop_agent when you need it no more):',
    );
    await turnEnds(dev.id);
    expect(mail(dev.id)).toEqual([]);
    await delegation.finish(dev.id, "Second.");
    expect(inbox()).toEqual(["dev: reported: First.", "dev: reported: Second."]);
    expect(await names()).toEqual(["dev"]);
  });

  test("refuses an empty result, a result that is too long and a second report", async () => {
    const dev = await handOver("dev");
    await expect(delegation.finish(dev.id, "  ")).rejects.toThrow("The result is empty.");
    await expect(delegation.finish(dev.id, "x".repeat(40_000))).rejects.toThrow(/too long/);
    expect(await names()).toEqual(["dev"]);

    // The stop of a reported session is under way but not done: a second call changes nothing.
    store.setFinished(dev.id, 5);
    expect(await delegation.finish(dev.id, "Again.")).toBe(
      "Already reported; this session is ending.",
    );
    expect(mail(MAIN)).toEqual([]);
  });

  test("is refused while a question to the session is unanswered", async () => {
    const dev = await handOver("dev");
    const question = workspace.messaging.ask(MAIN, "dev", "Which branch?", null);
    await expect(delegation.finish(dev.id, "Done.")).rejects.toThrow(
      `Question #${question.id} from main is waiting for your answer; answer it first.`,
    );
    expect(await names()).toEqual(["dev"]);
    workspace.messaging.answer(question.id, dev.id, "main");
    await delegation.finish(dev.id, "Done.");
    expect(await names()).toEqual([]);
  });
});

describe("who gets the result", () => {
  test("a parent that reports while its own agents run ends, and their results go up", async () => {
    const lead = await handOver("lead");
    const helper = await handOver("helper", lead.id);
    await delegation.finish(lead.id, "My part is done.");
    expect(await names()).toEqual(["helper"]);
    expect(mail(MAIN)[0]).toEndWith(
      'My part is done.\n\nStill running, started by "lead": helper. Their results will come to you.',
    );

    await delegation.finish(helper.id, "Helped.");
    expect(mail(MAIN)[1]).toBe(
      'Result of "helper" (its session has ended):\nIt was started by "lead", which has ended, so its result comes to you.\n\nHelped.',
    );
    expect(await names()).toEqual([]);
  });

  test("with nobody left up the chain the user gets the whole result, once", async () => {
    const mine = await workspace.spawn({ name: "mine" });
    const helper = await handOver("helper", mine.id);
    await workspace.stop("mine");
    await delegation.settled();
    expect(await delegation.finish(helper.id, "Helped.\nIn detail.")).toBe(
      "Result delivered to the user. This session ends now.",
    );
    expect(inbox()).toEqual([
      'helper: Result of "helper" (its session has ended):\nIt was started by "mine", which has ended, so its result comes to you.\n\nHelped.\nIn detail.',
    ]);
  });
});

describe("a turn that ends without a report", () => {
  test("earns reminders, then one message to the spawner, and never ends the session", async () => {
    const dev = await handOver("dev");
    store.setActivity(dev.id, "idle", "I think that is all.", 1);
    for (let turn = 1; turn <= MAX_REMINDERS + 3; turn++) await turnEnds(dev.id);
    expect(mail(dev.id)).toHaveLength(MAX_REMINDERS);
    expect(mail(dev.id)[0]).toStartWith('The task "main" started you for is still open.');
    expect(mail(MAIN)).toHaveLength(1);
    expect(mail(MAIN)[0]).toContain('Agent "dev" is idle and has not reported a result');
    expect(await names()).toEqual(["dev"]);
    expect(inbox()).toEqual([]);
  });

  test("the count starts again once someone has spoken to the session", async () => {
    const dev = await handOver("dev");
    for (let turn = 1; turn <= MAX_REMINDERS + 2; turn++) await turnEnds(dev.id);
    expect(mail(dev.id)).toHaveLength(MAX_REMINDERS);
    workspace.messaging.send(MAIN, "dev", "Please report.");
    await turnEnds(dev.id);
    expect(mail(dev.id)).toHaveLength(MAX_REMINDERS + 2);
    expect(store.handover(dev.id)?.reminders).toBe(1);
  });

  test("is not idleness while the session waits for an answer or for its own agents", async () => {
    const lead = await handOver("lead");
    const question = workspace.messaging.ask(lead.id, "user", "Which one?", null);
    await turnEnds(lead.id);
    expect(reminders(lead.id)).toBe(0);
    workspace.messaging.answer(question.id, "user", "The first.");

    const helper = await handOver("helper", lead.id);
    await turnEnds(lead.id);
    expect(reminders(lead.id)).toBe(0);
    await delegation.finish(helper.id, "Helped.");
    await agents();
    // Now that nothing is awaited, a turn that ends is reminded.
    await turnEnds(lead.id);
    expect(reminders(lead.id)).toBe(1);
  });
});

describe("a session that stops without a report", () => {
  test("the one who waits is told, unless it stopped the session itself", async () => {
    await handOver("dev");
    await workspace.stop("dev");
    await delegation.settled();
    expect(mail(MAIN)).toEqual(['Agent "dev" stopped without reporting a result.']);

    const other = await handOver("other");
    delegation.expectStop(other.id, MAIN);
    await workspace.stop("other");
    await delegation.settled();
    expect(mail(MAIN)).toHaveLength(1);
    expect(inbox()).toEqual([]);
  });

  test("stopping the workspace tells the user nothing", async () => {
    const mine = await workspace.spawn({ name: "mine" });
    await handOver("helper", mine.id);
    await handOver("dev");
    await workspace.down();
    await delegation.settled();
    expect(inbox()).toEqual([]);
  });
});

describe("what became of a session someone waits for", () => {
  test("a result that has not been read yet is handed over, once", async () => {
    const dev = await handOver("dev");
    await delegation.finish(dev.id, "Fixed.");
    await agents();
    expect(delegation.outcome("dev", MAIN)).toBe(
      'Result of "dev" (its session has ended):\n\nFixed.',
    );
    expect(mail(MAIN)).toEqual([]);
    expect(delegation.outcome(dev.id, MAIN)).toBe(
      "dev finished and its session ended. Its result was sent to you as a message.",
    );
  });

  test("says so when it stopped without one, and knows only the caller's own agents", async () => {
    const dev = await handOver("dev");
    await workspace.stop("dev");
    await delegation.settled();
    expect(delegation.outcome("dev", MAIN)).toBe("dev stopped without a result.");
    expect(delegation.outcome("dev", dev.id)).toBe("dev is not running.");
    expect(delegation.outcome("ghost", MAIN)).toBe("ghost is not running.");
  });

  test("a session that is still being reminded is marked as owing its report", async () => {
    const dev = await handOver("dev");
    const due = async () => (await agents()).find((agent) => agent.id === dev.id)?.reportDue;
    expect(await due()).toBe(true);
    for (let turn = 1; turn <= MAX_REMINDERS + 1; turn++) await turnEnds(dev.id);
    expect(await due()).toBeUndefined();
  });
});

test("after a daemon restart a session that had reported is ended", async () => {
  const dev = await handOver("dev");
  const kept = await handOver("kept", MAIN, { keep: true });
  const open = await handOver("open");
  store.setFinished(dev.id, 5);
  store.setFinished(kept.id, 5);
  await new Delegation({ store, workspace }).resume();
  expect(await names()).toEqual([kept.name, open.name]);
});
