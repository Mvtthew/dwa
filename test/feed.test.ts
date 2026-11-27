import { beforeEach, describe, expect, test } from "bun:test";
import { MAX_FEED, Store } from "../src/daemon/db.ts";
import { Delegation } from "../src/daemon/delegation.ts";
import { MAX_FEED_BODY } from "../src/daemon/feed.ts";
import { USER } from "../src/daemon/messaging.ts";
import { Workflows } from "../src/daemon/workflows.ts";
import { Workspace } from "../src/daemon/workspace.ts";
import { claudeProvider } from "../src/providers/claude/launch.ts";
import type { Config } from "../src/shared/config.ts";
import type { FeedItem } from "../src/shared/protocol.ts";
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

let store: Store;
let workspace: Workspace;
let workflows: Workflows;
let delegation: Delegation;
let counter: number;

beforeEach(async () => {
  const tmux = new FakeTmux();
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
    load: (name) =>
      parseWorkflow(
        '[steps.build]\nrole = "explore"\nprompt = "Build"\n\n[steps.check]\nrole = "explore"\nprompt = "Check"\ndepends_on = ["build"]',
        name,
      ),
  });
  delegation = new Delegation({ store, workspace, now: () => 1000 + counter });
  await workspace.up();
});

function feed(): FeedItem[] {
  return workspace.feed.list();
}

const kinds = () => feed().map((item) => `${item.kind} ${item.title}`);

describe("the feed store", () => {
  test("lists after an id, oldest first, the latest ones without one, and keeps a bounded log", () => {
    const local = new Store(":memory:");
    for (let i = 1; i <= MAX_FEED + 150; i++) {
      local.addFeed({
        at: i,
        kind: "lifecycle",
        agentId: null,
        agentName: null,
        refId: null,
        refName: null,
        title: `item ${i}`,
        body: "x".repeat(10),
        data: null,
      });
    }
    const after = local.feedAfter(MAX_FEED + 140, 5, 3);
    expect(after.map((row) => row.title)).toEqual([
      `item ${MAX_FEED + 141}`,
      `item ${MAX_FEED + 142}`,
      `item ${MAX_FEED + 143}`,
      `item ${MAX_FEED + 144}`,
      `item ${MAX_FEED + 145}`,
    ]);
    // A list carries a preview of the body, one item the whole of it.
    expect(after[0]?.body).toBe("xxx");
    expect(local.feedItem(after[0]?.id ?? 0)?.body).toBe("x".repeat(10));
    const latest = local.feedAfter(0, 2, 10);
    expect(latest.map((row) => row.title)).toEqual([
      `item ${MAX_FEED + 149}`,
      `item ${MAX_FEED + 150}`,
    ]);
    // Older items are dropped as new ones come.
    expect(local.feedItem(1)).toBeNull();
    expect(local.feedItem(MAX_FEED + 150 - MAX_FEED + 1)).not.toBeNull();
  });
});

describe("what the feed records", () => {
  test("a spawn has the task as asked, without dwa's suffix, and what the session was given", async () => {
    const dev = await workspace.spawn({
      name: "dev",
      role: "explore",
      task: "Fix the parser.",
      effort: "high",
      from: MAIN,
    });
    const spawn = feed().find((item) => item.kind === "spawn");
    expect(spawn?.title).toBe("main started dev");
    expect(spawn?.body).toBe("Fix the parser.");
    expect(spawn?.refId).toBe(dev.id);
    expect(spawn?.main).toBe(true);
    expect(spawn?.data).toMatchObject({ role: "explore", effort: "high", startedBy: "main" });
    // The stored task does have the suffix: the item does not come from it.
    expect(store.getRunning(dev.id)?.task).toContain("finish_task");
    const detail = workspace.feed.item(spawn?.id ?? 0);
    expect(detail?.launch?.map(([label]) => label)).toContain("tools");
  });

  test("the end of a turn is a recap with the whole reply, for main and for agents", async () => {
    const dev = await workspace.spawn({ name: "dev", role: "explore" });
    const reply = `Done.\n\nChanged three files.\n${"more ".repeat(100)}`;
    workspace.hook({ agentId: dev.id, event: "Stop", input: { last_assistant_message: reply } });
    workspace.hook({ agentId: MAIN, event: "Stop", input: { last_assistant_message: "Hi." } });
    workspace.hook({ agentId: MAIN, event: "Stop", input: {} });
    const recaps = feed().filter((item) => item.kind === "recap");
    expect(recaps.map((item) => [item.agent, item.title, item.main])).toEqual([
      ["dev", "Done.", false],
      ["main", "Hi.", true],
    ]);
    expect(workspace.feed.item(recaps[0]?.id ?? 0)?.body).toBe(reply.trim());
    // A list keeps polls small.
    expect(recaps[0]?.body.length).toBeLessThan(reply.length);
  });

  test("a body longer than the limit is cut", async () => {
    workspace.hook({
      agentId: MAIN,
      event: "Stop",
      input: { last_assistant_message: "y".repeat(MAX_FEED_BODY + 10) },
    });
    const recap = feed().find((item) => item.kind === "recap");
    expect(workspace.feed.item(recap?.id ?? 0)?.body.length).toBe(MAX_FEED_BODY);
  });

  test("a result is one finish item, not the messages that carry it", async () => {
    const dev = await workspace.spawn({ name: "dev", role: "explore", task: "Fix", from: MAIN });
    await delegation.finish(dev.id, "Fixed the parser.\nTests pass.");
    await delegation.settled();
    await workspace.state();
    const items = kinds();
    expect(items).toContain("finish dev finished: Fixed the parser.");
    expect(items.filter((item) => item.startsWith("message"))).toEqual([]);
    expect(items).toContain("lifecycle stopped");
    const finish = feed().find((item) => item.kind === "finish");
    expect(workspace.feed.item(finish?.id ?? 0)?.body).toBe("Fixed the parser.\nTests pass.");
  });

  test("messages, questions and answers, between agents and with the user", async () => {
    const dev = await workspace.spawn({ name: "dev", role: "explore" });
    workspace.messaging.send(dev.id, "main", "Look at the logs.");
    const question = workspace.messaging.ask(dev.id, USER, "Postgres or SQLite?", ["pg", "lite"]);
    workspace.messaging.answer(question.id, USER, "pg");
    expect(kinds()).toEqual(
      expect.arrayContaining([
        "message dev → main: Look at the logs.",
        `question #${question.id} dev asks you: Postgres or SQLite?`,
        `answer #${question.id} you answered: pg`,
      ]),
    );
    const asked = feed().find((item) => item.kind === "question");
    expect(asked?.body).toContain("Suggested answers: pg | lite");
    expect(asked?.refId).toBeNull();
  });

  test("a progress note is a lifecycle item", async () => {
    const dev = await workspace.spawn({ name: "dev", role: "explore" });
    workspace.progress(dev.id, "half way", 50);
    expect(kinds()).toContain("lifecycle progress: 50% half way");
  });

  test("a workflow run: its start, each step as it starts and ends, and its end", async () => {
    await workflows.start("ship", "the input", USER);
    await workflows.settled();
    const build = store.workflowSteps(1).find((step) => step.stepId === "build");
    await workflows.completeStep(build?.agentId ?? "", "built");
    await workflows.settled();
    const check = store.workflowSteps(1).find((step) => step.stepId === "check");
    await workflows.completeStep(check?.agentId ?? "", "checked");
    await workflows.settled();
    const steps = kinds().filter((item) => item.startsWith("step"));
    expect(steps).toEqual([
      "step ship #1 started",
      "step ship #1 · build started",
      "step ship #1 · build done",
      "step ship #1 · check started",
      "step ship #1 · check done",
      "step ship #1 done",
    ]);
  });
});

describe("separators and clearing", () => {
  const add = (title: string) => workspace.feed.add({ kind: "lifecycle", title });
  const titles = () => feed().map((item) => item.title);

  test("a new workspace starts its feed at a separator and hides what came before", async () => {
    expect(kinds()).toEqual(["session new session"]);
    expect(feed()[0]).toMatchObject({ agentId: MAIN, agent: "main", main: true });
    add("one");
    await workspace.down();
    const before = store.lastFeedId();
    await workspace.up();
    const shown = feed();
    expect(shown[0]).toMatchObject({ kind: "session", title: "new session" });
    expect(shown.every((item) => item.id > before)).toBe(true);
    expect(workspace.feed.cleared()).toBe((shown[0]?.id ?? 0) - 1);
    // Hidden, not deleted: it can still be read.
    expect(workspace.feed.item(1)?.title).toBe("new session");
    expect(store.feedItem(2)?.title).toBe("one");
  });

  test("/clear in the main session is a separator; other starts and agents get none", async () => {
    const dev = await workspace.spawn({ name: "dev" });
    const count = feed().length;
    workspace.hook({ agentId: MAIN, event: "SessionStart", input: { source: "compact" } });
    workspace.hook({ agentId: MAIN, event: "SessionStart", input: { source: "startup" } });
    workspace.hook({ agentId: dev.id, event: "SessionStart", input: { source: "clear" } });
    expect(feed()).toHaveLength(count);
    workspace.hook({ agentId: MAIN, event: "SessionStart", input: { source: "clear" } });
    expect(feed().at(-1)).toMatchObject({
      kind: "session",
      title: "conversation cleared",
      agentId: MAIN,
    });
  });

  test("a main session started afresh gets a separator, a resumed one or an agent does not", async () => {
    await workspace.spawn({ name: "dev" });
    await workspace.restart("dev");
    expect(kinds().at(-1)).toBe("lifecycle started afresh");
    await workspace.restart("main");
    expect(kinds().at(-1)).toBe("session started afresh");
    workspace.hook({ agentId: MAIN, event: "UserPromptSubmit", input: {} });
    await workspace.restart("main");
    expect(kinds().at(-1)).toBe("lifecycle restarted with changed settings");
  });

  test("clearing moves a point forward and deletes nothing", () => {
    add("a");
    add("b");
    workspace.feed.add({ kind: "session", title: "conversation cleared" });
    add("c");
    expect(titles()).toEqual(["new session", "a", "b", "conversation cleared", "c"]);

    const separator = store.lastFeedId("session");
    expect(workspace.feed.clear("earlier")).toBe(separator - 1);
    expect(titles()).toEqual(["conversation cleared", "c"]);
    // Asking from before the point still gives nothing that was cleared.
    expect(workspace.feed.list(1).map((item) => item.title)).toEqual(["conversation cleared", "c"]);
    // The same again changes nothing.
    expect(workspace.feed.clear("earlier")).toBe(separator - 1);

    const last = store.lastFeedId();
    expect(workspace.feed.clear("all")).toBe(last);
    expect(feed()).toEqual([]);
    // The point never moves back, also when the only separator is behind it.
    expect(workspace.feed.clear("earlier")).toBe(last);
    add("d");
    expect(titles()).toEqual(["d"]);
    expect(workspace.feed.list(last).map((item) => item.title)).toEqual(["d"]);
    expect(workspace.feed.item(2)?.title).toBe("a");
  });

  test("a feed without a separator has nothing earlier to clear", () => {
    const local = new Store(":memory:");
    expect(local.lastFeedId()).toBe(0);
    expect(local.lastFeedId("session")).toBe(0);
  });
});
