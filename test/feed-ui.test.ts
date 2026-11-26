import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { AgentInfo, FeedDetail, FeedItem, WorkspaceState } from "../src/shared/protocol.ts";
import { createFeedView } from "../src/ui/feed.ts";
import {
  defaultFilters,
  feedSubject,
  filterOf,
  itemLines,
  visibleItems,
} from "../src/ui/feed-model.ts";
import type { Row } from "../src/ui/wizard.ts";
import { feedScreen, type WizardApi } from "../src/ui/wizards.ts";

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);

function item(id: number, overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id,
    at: NOW,
    kind: "recap",
    agentId: "id-dev",
    agent: "dev",
    main: false,
    refId: null,
    ref: null,
    title: `item ${id}`,
    body: `item ${id}`,
    data: null,
    ...overrides,
  };
}

function agent(name: string, overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: `id-${name}`,
    kind: "agent",
    name,
    role: null,
    profile: "me",
    sessionId: `s-${name}`,
    paneId: "%1",
    state: "running",
    task: null,
    createdAt: 0,
    activity: "idle",
    detail: null,
    activitySince: 0,
    telemetry: null,
    progress: null,
    waitingOn: null,
    open: false,
    capabilities: null,
    ...overrides,
  };
}

function workspace(agents: AgentInfo[]): WorkspaceState {
  return {
    projectRoot: "/project",
    keyPrefix: "C-q",
    up: true,
    main: agent("main", { kind: "main", id: "id-main" }),
    agents,
    questions: [],
    inbox: [],
    workflows: [],
    shell: null,
    feed: { open: true },
  };
}

describe("the feed model", () => {
  test("main's recaps are off at first; everything else is on", () => {
    const filters = defaultFilters();
    expect(filters.has("main")).toBe(false);
    expect(filters.has("recap")).toBe(true);
    const items = [item(1), item(2, { main: true, agentId: "id-main", agent: "main" })];
    expect(visibleItems(items, { filters, only: null }).map((entry) => entry.id)).toEqual([1]);
    expect(filterOf(item(3, { kind: "question" }))).toBe("message");
  });

  test("only the selected session: the one shown under main, or main", () => {
    expect(feedSubject(workspace([agent("dev")]))?.name).toBe("main");
    const state = workspace([agent("dev", { open: true })]);
    expect(feedSubject(state)?.id).toBe("id-dev");
    const items = [
      item(1),
      item(2, { kind: "spawn", agentId: "id-main", agent: "main", refId: "id-dev" }),
      item(3, { agentId: "id-rev", agent: "rev" }),
    ];
    const shown = visibleItems(items, { filters: defaultFilters(), only: "id-dev" });
    expect(shown.map((entry) => entry.id)).toEqual([1, 2]);
  });

  test("an item is a head with who and when, then a few lines of its text", () => {
    const spawn = item(1, {
      kind: "spawn",
      agent: "main",
      title: "main started dev",
      body: "Fix the parser and run the tests.",
      at: NOW - 5 * 60000,
    });
    expect(itemLines(spawn, 30, NOW).map((line) => line.text)).toEqual([
      "+ main               5 min ago",
      "  main started dev: Fix the",
      "    parser and run the tests.",
    ]);
    const long = item(2, { body: "word ".repeat(40) });
    const lines = itemLines(long, 30, NOW);
    expect(lines).toHaveLength(4);
    expect(lines.at(-1)?.text.endsWith("…")).toBe(true);
  });
});

describe("the feed pane", () => {
  test("lists items, switches types on and off, and opens an item on a click", async () => {
    const harness = await createTestRenderer({ width: 40, height: 30 });
    const opened: number[] = [];
    const view = createFeedView(harness.renderer, { open: (id) => opened.push(id) });
    view.update(workspace([agent("dev")]), NOW);
    view.add([
      item(1, { body: "Done with the parser." }),
      item(2, { kind: "spawn", agent: "main", title: "main started dev", body: "Fix it" }),
      item(3, { main: true, agent: "main", agentId: "id-main", body: "Hello there." }),
    ]);
    await harness.renderOnce();
    let frame = harness.captureCharFrame();
    expect(frame).toContain("Done with the parser.");
    expect(frame).toContain("main started dev: Fix it");
    // Main's recap is hidden until its switch is turned on.
    expect(frame).not.toContain("Hello there.");

    const lines = frame.split("\n");
    const row = (text: string) => lines.findIndex((line) => line.includes(text));
    const column = (text: string) => (lines[row(text)] ?? "").indexOf(text);
    await harness.mockMouse.click(column("Main"), row("Main"));
    await harness.renderOnce();
    frame = harness.captureCharFrame();
    expect(frame).toContain("Hello there.");

    await harness.mockMouse.click(column("Spawns"), row("Spawns"));
    await harness.renderOnce();
    frame = harness.captureCharFrame();
    expect(frame).not.toContain("main started dev");

    const after = frame.split("\n");
    await harness.mockMouse.click(
      4,
      after.findIndex((line) => line.includes("Done with")),
    );
    harness.renderer.destroy();
    expect(opened).toEqual([1]);
  });

  test("says when there is nothing yet", async () => {
    const harness = await createTestRenderer({ width: 40, height: 10 });
    const view = createFeedView(harness.renderer, { open() {} });
    view.update(workspace([]), NOW);
    await harness.renderOnce();
    expect(harness.captureCharFrame()).toContain("Nothing yet.");
    harness.renderer.destroy();
  });
});

describe("the feed reader popup", () => {
  const spawn: FeedDetail = {
    ...item(7, {
      kind: "spawn",
      agentId: "id-main",
      agent: "main",
      refId: "id-dev",
      ref: "dev",
      title: "main started dev",
      body: "Fix the parser.\nThen run the tests.",
      data: { role: "developer", profile: "me", effort: "high", startedBy: "main", keep: false },
    }),
    launch: [["tools", "Read, Edit, Bash"]],
  };

  function api(detail: FeedDetail, agents: AgentInfo[]) {
    const calls: string[] = [];
    const wizard: WizardApi = {
      roles: [],
      profiles: [],
      call: async <T>(_method: string, path: string) => {
        calls.push(path);
        if (path.startsWith("/feed/item")) return detail as T;
        if (path === "/state") return workspace(agents) as T;
        return {} as T;
      },
    };
    return { wizard, calls };
  }

  const texts = (rows: Row[]) =>
    rows.map((row) => ("text" in row ? row.text : "label" in row ? `[${row.label}]` : ""));

  test("a spawn shows the task whole and what the agent was started with", async () => {
    const { wizard, calls } = api(spawn, [agent("dev")]);
    const screen = await feedScreen(wizard, "7", NOW);
    expect(calls[0]).toBe("/feed/item?id=7");
    expect(screen.title).toBe("Agent started");
    const shown = texts(screen.rows);
    expect(shown).toContain("Fix the parser.\nThen run the tests.");
    const details = shown.find((text) => text.startsWith("started by"));
    expect(details).toContain("role        developer");
    expect(details).toContain("effort      high");
    expect(details).toContain("tools       Read, Edit, Bash");
    expect(shown).toContain("[Show dev]");
    expect(shown).toContain("[Agent tools]");
  });

  test("an item about a session that is gone has no buttons for it", async () => {
    const recap: FeedDetail = { ...item(8, { body: "Done.\nAll of it." }), launch: null };
    const { wizard } = api(recap, []);
    const shown = texts((await feedScreen(wizard, "8", NOW)).rows);
    expect(shown).toContain("Done.\nAll of it.");
    expect(shown).not.toContain("[Show dev]");
    expect(shown.at(-1)).toBe("[Close]");
  });
});
