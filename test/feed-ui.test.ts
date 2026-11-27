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
import { feedScreen, menuScreen, type WizardApi } from "../src/ui/wizards.ts";

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
    const view = createFeedView(harness.renderer, { open: (id) => opened.push(id), clear() {} });
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
    const view = createFeedView(harness.renderer, { open() {}, clear() {} });
    view.update(workspace([]), NOW);
    await harness.renderOnce();
    expect(harness.captureCharFrame()).toContain("Nothing yet.");
    harness.renderer.destroy();
  });
});

describe("separators and clearing in the feed pane", () => {
  const separator = (id: number, title = "new session") =>
    item(id, { kind: "session", agentId: "id-main", agent: "main", main: true, title, body: "" });

  test("a separator is shown whatever the switches say, as one rule across the pane", () => {
    const items = [item(1), separator(2), item(3)];
    expect(filterOf(separator(2))).toBeNull();
    expect(
      visibleItems(items, { filters: new Set(), only: null }).map((entry) => entry.id),
    ).toEqual([2]);
    expect(
      visibleItems(items, { filters: new Set(), only: "id-other" }).map((entry) => entry.id),
    ).toEqual([2]);
    const lines = itemLines(separator(2), 38, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toHaveLength(38);
    expect(lines[0]?.text.startsWith("── new session · just now ─")).toBe(true);
    expect(lines[0]?.text.endsWith("─")).toBe(true);
    // Too narrow for the whole label: cut, never wider than the pane.
    expect(itemLines(separator(2, "conversation cleared"), 12, NOW)[0]?.text.length).toBe(12);
  });

  test("the pane draws the separator, drops what was cleared and asks for a clear on a click", async () => {
    const harness = await createTestRenderer({ width: 40, height: 30 });
    const opened: number[] = [];
    const cleared: string[] = [];
    const view = createFeedView(harness.renderer, {
      open: (id) => opened.push(id),
      clear: (scope) => cleared.push(scope),
    });
    view.update(workspace([agent("dev")]), NOW);
    view.add([item(1, { body: "Old work." }), separator(2), item(3, { body: "New work." })]);
    await harness.renderOnce();
    let frame = harness.captureCharFrame();
    let lines = frame.split("\n");
    const row = (text: string) => lines.findIndex((line) => line.includes(text));
    const column = (text: string) => (lines[row(text)] ?? "").indexOf(text);
    expect(row("Old work.")).toBeLessThan(row("── new session"));
    expect(row("── new session")).toBeLessThan(row("New work."));

    // The separator has nothing to open.
    await harness.mockMouse.click(4, row("── new session"));
    expect(opened).toEqual([]);

    await harness.mockMouse.click(column("[Clear]") + 1, row("[Clear]"));
    await harness.mockMouse.click(column("[Clear old]") + 1, row("[Clear old]"));
    expect(cleared).toEqual(["all", "earlier"]);

    // The daemon's answer is what empties the pane, not the click.
    expect(frame).toContain("Old work.");
    view.clear(1);
    await harness.renderOnce();
    frame = harness.captureCharFrame();
    lines = frame.split("\n");
    expect(frame).not.toContain("Old work.");
    expect(frame).toContain("── new session");
    expect(frame).toContain("New work.");

    view.clear(3);
    await harness.renderOnce();
    frame = harness.captureCharFrame();
    expect(frame).not.toContain("New work.");
    expect(frame).toContain("Nothing yet.");
    harness.renderer.destroy();
  });

  test("the menu clears everything or the earlier sessions", async () => {
    const posted: unknown[] = [];
    const wizard: WizardApi = {
      roles: [],
      profiles: [],
      call: async <T>(method: string, path: string, body?: unknown) => {
        if (method === "POST") posted.push([path, body]);
        return (path === "/state" ? workspace([]) : {}) as T;
      },
    };
    const menu = await menuScreen(wizard);
    const button = (rows: Row[], label: string) => {
      const found = rows.find((entry) => entry.kind === "button" && entry.label === label);
      if (found?.kind !== "button") throw new Error(`no button ${label}`);
      return found;
    };
    const next = await button(menu.rows, "Clear the feed…").run({});
    if (!next || !("to" in next)) throw new Error("no screen");
    const screen = await next.to;
    expect(await button(screen.rows, "Clear everything").run({})).toEqual({ close: true });
    expect(await button(screen.rows, "Clear earlier sessions").run({})).toEqual({ close: true });
    expect(posted).toEqual([
      ["/feed/clear", { scope: "all" }],
      ["/feed/clear", { scope: "earlier" }],
    ]);
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
