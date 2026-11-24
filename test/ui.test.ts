import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { AgentInfo, WorkflowRunInfo, WorkspaceState } from "../src/shared/protocol.ts";
import { createAgentsView } from "../src/ui/agents.ts";
import {
  agentsHeader,
  bar,
  formatKey,
  moveCursor,
  percentTone,
  statusModel,
  tiles,
  untilReset,
  workflowLine,
} from "../src/ui/model.ts";
import { createStatusView } from "../src/ui/status.ts";

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
    ...overrides,
  };
}

function workspace(agents: AgentInfo[], main: Partial<AgentInfo> = {}): WorkspaceState {
  return {
    projectRoot: "/project",
    keyPrefix: "C-q",
    up: true,
    main: agent("main", { kind: "main", ...main }),
    agents,
    questions: [],
    inbox: [],
    workflows: [],
  };
}

const NOW = Date.UTC(2026, 10, 24, 18, 0, 0);
const telemetry = {
  contextPercent: 41,
  costUsd: 0.7,
  model: "Opus 5.5",
  fiveHour: { usedPercent: 19, resetsAt: NOW / 1000 + 2 * 3600 + 5 * 60 },
  sevenDay: { usedPercent: 92, resetsAt: NOW / 1000 + 2 * 86400 + 14 * 3600 },
  updatedAt: NOW,
};

describe("model", () => {
  test("agentsHeader shows a range only when the list does not fit", () => {
    expect(agentsHeader(0)).toBe("AGENTS 0");
    expect(agentsHeader(12)).toBe("AGENTS 12");
    expect(agentsHeader(15)).toBe("AGENTS 1–12 of 15");
    expect(agentsHeader(15, 2)).toBe("AGENTS 3–14 of 15");
    expect(agentsHeader(15, 9)).toBe("AGENTS 4–15 of 15");
  });

  test("moveCursor stays inside the list", () => {
    expect(moveCursor(0, -1, 3)).toBe(0);
    expect(moveCursor(2, 1, 3)).toBe(2);
    expect(moveCursor(5, 0, 3)).toBe(2);
    expect(moveCursor(0, 1, 0)).toBe(0);
  });

  test("bar, percentTone, untilReset and formatKey", () => {
    expect(bar(50, 10)).toBe("█████░░░░░");
    expect(bar(140, 4)).toBe("████");
    expect([percentTone(10), percentTone(75), percentTone(95)]).toEqual([
      "good",
      "attention",
      "bad",
    ]);
    expect(untilReset(NOW / 1000 + 125 * 60, NOW)).toBe("in 2h 5m");
    expect(untilReset(NOW / 1000 + 62 * 3600, NOW)).toBe("in 2d 14h");
    expect(untilReset(NOW / 1000 + 12 * 60, NOW)).toBe("in 12m");
    expect(untilReset(NOW / 1000 - 60, NOW)).toBeNull();
    expect(untilReset(null, NOW)).toBeNull();
    expect([formatKey("C-q"), formatKey("M-a"), formatKey("F5")]).toEqual([
      "Ctrl+Q",
      "Alt+A",
      "F5",
    ]);
  });

  test("tiles number the agents and hide a role equal to the name", () => {
    const result = tiles(
      workspace([
        agent("explore", { role: "explore", activity: "working", detail: "Bash" }),
        agent("dev-2", { role: "developer", activity: "needs_user", open: true }),
      ]),
    );
    expect(result.map((tile) => [tile.position, tile.name, tile.role, tile.style.label])).toEqual([
      [1, "explore", null, "working"],
      [2, "dev-2", "developer", "needs you"],
    ]);
  });

  test("statusModel follows the open agent and reports missing figures as null", () => {
    const state = workspace(
      [agent("a", { activity: "working" }), agent("b", { open: true, activity: "needs_user" })],
      { telemetry },
    );
    const model = statusModel(state, NOW);
    expect(model.subject?.name).toBe("b");
    expect(model.context.percent).toBeNull();
    expect(model.cost).toBeNull();
    // Limits are per account, so they come from main even though b is selected.
    expect(model.limits.map((limit) => [limit.percent, limit.note])).toEqual([
      [19, "in 2h 5m"],
      [92, "in 2d 14h"],
    ]);
    expect(model.counts).toEqual({ working: 1, idle: 0, needsYou: 1, total: 2 });
    expect(model.waiting).toEqual([{ name: "b", detail: null }]);
  });
});

describe("questions and messages", () => {
  const question = {
    id: 3,
    from: "dev",
    to: "user",
    fromId: "id-dev",
    toId: "user",
    question: "Which database\nshould I use?",
    options: [],
    createdAt: NOW,
  };

  test("an agent that asked the user is shown as asking, one waiting on an agent as waiting", () => {
    const result = tiles(
      workspace([
        agent("dev", { activity: "working", detail: "mcp__dwa__ask", waitingOn: "user" }),
        agent("rev", { activity: "working", detail: "mcp__dwa__ask", waitingOn: "dev" }),
        agent("doc", { activity: "working", detail: "Edit", progress: "40% writing" }),
        agent("ops", { activity: "idle", detail: "done", progress: "90% deploying" }),
      ]),
    );
    expect(result.map((tile) => [tile.style.label, tile.style.tone, tile.detail])).toEqual([
      ["asks you", "attention", null],
      ["waiting on dev", "muted", null],
      ["working", "good", "40% writing"],
      ["idle", "muted", "done"],
    ]);
  });

  test("the status pane lists open questions and recent messages", async () => {
    const harness = await createTestRenderer({ width: 30, height: 40 });
    const view = createStatusView(harness.renderer);
    view.update(
      {
        ...workspace([agent("dev", { waitingOn: "user" })]),
        questions: [question, { ...question, id: 4, from: "rev", to: "dev", toId: "id-dev" }],
        inbox: [{ id: 1, from: "dev", body: "The fix is ready for review.", createdAt: NOW }],
      },
      NOW,
    );
    await harness.renderOnce();
    const frame = harness.captureCharFrame();
    harness.renderer.destroy();
    expect(frame).toContain("QUESTIONS 2");
    expect(frame).toContain("◆ #3 dev → you");
    expect(frame).toContain("Which database should I u…");
    expect(frame).toContain("◷ #4 rev → dev");
    expect(frame).toContain("Ctrl+Q q to answer");
    expect(frame).toContain("MESSAGES TO YOU");
    expect(frame).toContain("from dev  just now");
    expect(frame).toContain("The fix is ready for revi…");
  });
});

describe("workflows in the status pane", () => {
  const step = { dependsOn: [], agent: null, result: null, error: null, needsAttention: false };
  const run: WorkflowRunInfo = {
    id: 3,
    name: "feature",
    input: "",
    state: "running",
    startedBy: "user",
    createdAt: NOW,
    finishedAt: null,
    steps: [
      { ...step, id: "explore", state: "done" },
      { ...step, id: "build", state: "running", needsAttention: true },
      { ...step, id: "review", state: "pending" },
    ],
  };

  test("a run in progress shows its steps, a finished one only its outcome", () => {
    expect(workflowLine(run)).toEqual({
      heading: "#3 feature",
      state: "running",
      tone: "good",
      steps: [
        { name: "explore", style: { glyph: "✓", label: "done", tone: "good" } },
        { name: "build", style: { glyph: "◆", label: "needs you", tone: "attention" } },
        { name: "review", style: { glyph: "○", label: "pending", tone: "muted" } },
      ],
    });
    expect(workflowLine({ ...run, state: "failed" })).toEqual({
      heading: "#3 feature",
      state: "failed",
      tone: "bad",
      steps: [],
    });
  });

  test("the pane draws them, and has no section without runs", async () => {
    const harness = await createTestRenderer({ width: 30, height: 40 });
    const view = createStatusView(harness.renderer);
    view.update({ ...workspace([]), workflows: [run, { ...run, id: 2, state: "done" }] }, NOW);
    await harness.renderOnce();
    const frame = harness.captureCharFrame();
    expect(frame).toContain("WORKFLOWS");
    expect(frame).toContain("#3 feature  running");
    expect(frame).toContain("  ✓ explore");
    expect(frame).toContain("  ◆ build needs you");
    expect(frame).toContain("  ○ review");
    expect(frame).toContain("#2 feature  done");

    view.update(workspace([]), NOW);
    await harness.renderOnce();
    expect(harness.captureCharFrame()).not.toContain("WORKFLOWS");
    harness.renderer.destroy();
  });
});

describe("panes", () => {
  let dispose: (() => void | Promise<void>) | undefined;
  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
  });

  async function setup(width: number, height: number) {
    const harness = await createTestRenderer({ width, height });
    dispose = () => harness.renderer.destroy();
    return harness;
  }

  test("the agents pane lists running agents with their state", async () => {
    const harness = await setup(34, 20);
    const view = createAgentsView(harness.renderer, { open() {}, close() {} });
    view.update(
      workspace([
        agent("explore", { activity: "working", detail: "Bash" }),
        agent("dev", {
          role: "developer",
          activity: "needs_user",
          detail: "permission: Bash",
          open: true,
        }),
      ]),
    );
    await harness.renderOnce();
    const frame = harness.captureCharFrame();
    expect(frame).toContain("AGENTS 2");
    expect(frame).toContain("1 explore");
    expect(frame).toContain("● working · Bash");
    expect(frame).toContain("▸2 dev developer");
    expect(frame).toContain("◆ needs you · permission: Ba…");
  });

  test("an empty list says how to start an agent", async () => {
    const harness = await setup(34, 12);
    const view = createAgentsView(harness.renderer, { open() {}, close() {} });
    view.update(workspace([]));
    await harness.renderOnce();
    const frame = harness.captureCharFrame();
    expect(frame).toContain("AGENTS 0");
    expect(frame).toContain("No agents running.");
  });

  test("keys move the cursor and open or close agents", async () => {
    const harness = await setup(34, 20);
    const opened: string[] = [];
    let closed = 0;
    const view = createAgentsView(harness.renderer, {
      open: (id) => opened.push(id),
      close: () => closed++,
    });
    view.update(workspace([agent("a"), agent("b"), agent("c")]));
    await harness.renderOnce();

    harness.mockInput.pressKey("j");
    harness.mockInput.pressEnter();
    harness.mockInput.pressKey("3");
    harness.mockInput.pressKey("9");
    harness.mockInput.pressKey("x");
    await harness.renderOnce();
    expect(opened).toEqual(["id-b", "id-c"]);
    expect(closed).toBe(1);
  });

  test("clicking a tile opens that agent", async () => {
    const harness = await setup(34, 20);
    const opened: string[] = [];
    const view = createAgentsView(harness.renderer, { open: (id) => opened.push(id), close() {} });
    view.update(workspace([agent("a"), agent("b")]));
    await harness.renderOnce();
    const row = harness
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("2 b"));
    expect(row).toBeGreaterThan(0);
    await harness.mockMouse.click(5, row);
    await harness.renderOnce();
    expect(opened).toEqual(["id-b"]);
  });

  test("more than twelve agents shows a range and scrolls to the cursor", async () => {
    const harness = await setup(34, 45);
    const view = createAgentsView(harness.renderer, { open() {}, close() {} });
    const many = Array.from({ length: 15 }, (_, i) => agent(`agent${i + 1}`));
    view.update(workspace(many));
    await harness.renderOnce();
    let frame = harness.captureCharFrame();
    expect(frame).toContain("AGENTS 1–12 of 15");
    expect(frame).toContain("12 agent12");
    expect(frame).not.toContain("13 agent13");

    for (let i = 0; i < 14; i++) harness.mockInput.pressKey("j");
    await harness.renderOnce();
    view.update(workspace(many));
    await harness.renderOnce();
    frame = harness.captureCharFrame();
    expect(frame).toContain("15 agent15");
    expect(frame).toContain("AGENTS 4–15 of 15");
  });

  test("the status pane shows figures, N/A for missing ones, and who needs the user", async () => {
    const harness = await setup(30, 30);
    const view = createStatusView(harness.renderer);
    view.update(
      workspace([agent("dev", { activity: "needs_user", detail: "permission: Bash" })], {
        telemetry,
        activity: "working",
        detail: "Read",
      }),
      NOW,
    );
    await harness.renderOnce();
    let frame = harness.captureCharFrame();
    expect(frame).toContain("MAIN");
    expect(frame).toContain("● working · Read");
    expect(frame).toContain("Opus 5.5 · $0.70");
    expect(frame).toContain("41%");
    expect(frame).toContain("5 hours  in 2h 5m");
    expect(frame).toContain("92%");
    expect(frame).toContain("NEEDS YOU");
    expect(frame).toContain("◆ dev");
    expect(frame).toContain("Ctrl+Q, then");
    expect(frame).not.toContain("QUESTIONS");

    view.update(workspace([]), NOW);
    await harness.renderOnce();
    frame = harness.captureCharFrame();
    expect(frame).toContain("model N/A · cost N/A");
    expect(frame).toContain("N/A");
    expect(frame).not.toContain("NEEDS YOU");
  });
});
