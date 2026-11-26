import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { contextText } from "../src/shared/context.ts";
import type { AgentInfo, WorkflowRunInfo, WorkspaceState } from "../src/shared/protocol.ts";
import { createAgentsView } from "../src/ui/agents.ts";
import {
  agentsHeader,
  agentsSummary,
  bar,
  formatKey,
  moveCursor,
  percentTone,
  statusModel,
  tiles,
  untilReset,
  workflowLine,
  wrapAll,
} from "../src/ui/model.ts";
import { createStatusView } from "../src/ui/status.ts";

const noActions = { run() {}, version: "1.2.3" };
const quiet = { toggle() {}, close() {}, tools() {}, open() {}, clearMessages() {} };

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
    shell: null,
  };
}

const NOW = Date.UTC(2026, 10, 24, 18, 0, 0);
const telemetry = {
  contextPercent: 41,
  contextSize: 200000,
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
    expect(bar(50, 10)).toEqual(["━━━━━", "─────"]);
    expect(bar(140, 4)).toEqual(["━━━━", ""]);
    // Anything in use shows, however little.
    expect(bar(1, 10)).toEqual(["━", "─────────"]);
    expect(bar(0, 3)).toEqual(["", "───"]);
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

  test("a tile carries what the session may use, in short lines", () => {
    const capabilities = {
      denyTools: ["Edit", "Write"],
      allow: [],
      deny: [],
      mcp: ["github"],
      plugins: [],
      skills: ["review"],
      memory: false,
    };
    const [limited, open, old] = tiles(
      workspace([
        agent("rev", { capabilities }),
        agent("dev", {
          capabilities: { ...capabilities, denyTools: [], mcp: [], skills: undefined },
        }),
        agent("old"),
      ]),
    );
    expect(limited?.capabilities).toEqual([
      "tools all except Edit, Write",
      "mcp github",
      "skills review",
    ]);
    expect(open?.capabilities).toEqual(["tools all"]);
    expect(old?.capabilities).toEqual([]);
  });

  test("statusModel follows the open agent and reports missing figures as null", () => {
    const state = workspace(
      [
        agent("a", { activity: "working" }),
        // A later report with other limits: it must not replace main's.
        agent("b", {
          open: true,
          activity: "needs_user",
          telemetry: {
            ...telemetry,
            costUsd: null,
            fiveHour: { usedPercent: 55, resetsAt: NOW / 1000 + 60 },
            sevenDay: null,
            updatedAt: NOW + 5000,
          },
        }),
      ],
      { telemetry },
    );
    const model = statusModel(state, NOW);
    expect(model.subject?.name).toBe("b");
    // The context shown is always main's, whoever is selected; the cost is the selected agent's.
    expect(model.context).toEqual({
      label: "main context",
      percent: 41,
      value: "41%/200k",
      note: null,
    });
    expect(model.cost).toBeNull();
    // The limits are main's too, though b is selected and reported later.
    expect(model.limits.map((limit) => [limit.percent, limit.note])).toEqual([
      [19, "in 2h 5m"],
      [92, "in 2d 14h"],
    ]);
    // The counts of the agents pane: what needs the user first, and no state nobody is in.
    expect(agentsSummary(state)).toBe("1 needs you · 1 working");
    expect(
      agentsSummary(
        workspace([
          agent("a"),
          agent("b"),
          agent("c", { activity: "working", waitingOn: "a" }),
          agent("d", { activity: "working", waitingOn: "user" }),
        ]),
      ),
    ).toBe("1 needs you · 1 waiting · 2 idle");
    expect(agentsSummary(workspace([]))).toBe("");
    expect(model.waiting).toEqual([{ name: "b", detail: null }]);
  });
});

describe("contextText", () => {
  test("says the part in use and the size of the window", () => {
    expect(contextText(5, 1_000_000)).toBe("5%/1M");
    expect(contextText(0.1, 1_000_000)).toBe("0.1%/1M");
    expect(contextText(41.4, 200_000)).toBe("41%/200k");
    expect(contextText(41, null)).toBe("41%");
    expect(contextText(null, 200_000)).toBeNull();
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

  test("the agents pane lists open questions and recent messages under the agents", async () => {
    const harness = await createTestRenderer({ width: 30, height: 40 });
    const opened: [string, string | undefined][] = [];
    let cleared = 0;
    const view = createAgentsView(harness.renderer, {
      ...quiet,
      open: (kind, subject) => opened.push([kind, subject]),
      clearMessages: () => cleared++,
    });
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
    expect(frame).toContain("QUESTIONS 2");
    expect(frame).toContain("◆ #3 dev → you");
    expect(frame).toContain("Which database should I u…");
    expect(frame).toContain("◷ #4 rev → dev");
    expect(frame).toContain("click, or Ctrl+Q q for all");
    expect(frame).toContain("MESSAGES TO YOU 1");
    expect(frame).toContain("▸ Clear messages");
    expect(frame).toContain("from dev  just now");
    // Neither a preview of the text nor a hint: the line itself opens the messages.
    expect(frame).not.toContain("The fix is ready");
    expect(frame).not.toContain("click to read");
    // At the bottom: after the agent, and the last rows are still the hint for the keys.
    const lines = frame.split("\n");
    const row = (part: string) => lines.findIndex((line) => line.includes(part));
    expect(row("QUESTIONS 2")).toBeGreaterThan(row("1 dev"));
    expect(row("enter: show / hide")).toBeGreaterThan(row("Clear messages"));
    for (const part of [
      "#3 dev → you",
      "Which database",
      "q for all",
      "from dev",
      "Clear messages",
    ]) {
      await harness.mockMouse.click(4, row(part));
    }
    await harness.renderOnce();
    harness.renderer.destroy();
    expect(opened).toEqual([
      ["questions", "3"],
      ["questions", "3"],
      ["questions", undefined],
      ["messages", undefined],
    ]);
    expect(cleared).toBe(1);
  });
});

describe("workflows in the status pane", () => {
  const step = {
    attempt: 1,
    dependsOn: [],
    agent: null,
    result: null,
    error: null,
    needsAttention: false,
  };
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
      id: 3,
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
      id: 3,
      heading: "#3 feature",
      state: "failed",
      tone: "bad",
      steps: [],
    });
  });

  test("the pane draws them, and has no section without runs", async () => {
    const harness = await createTestRenderer({ width: 30, height: 40 });
    const view = createStatusView(harness.renderer, noActions);
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
    const view = createAgentsView(harness.renderer, quiet);
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
      NOW,
    );
    await harness.renderOnce();
    const frame = harness.captureCharFrame();
    expect(frame).toContain("AGENTS 2");
    // The counts under the title: only the states some agent is in.
    expect(frame).toContain("1 needs you · 1 working");
    expect(frame).toContain("1 explore");
    expect(frame).toContain("● working · Bash");
    expect(frame).toContain("▸2 dev developer");
    expect(frame).toContain("◆ needs you · permission: Ba…");
  });

  test("the agents pane keeps what the selected agent may use on its last rows", async () => {
    const harness = await setup(34, 60);
    const view = createAgentsView(harness.renderer, quiet);
    view.update(workspace([agent("explore"), agent("dev")]), NOW);
    await harness.renderOnce();
    const lines = harness.captureCharFrame().trimEnd().split("\n");
    expect(lines.length).toBe(60);
    expect(lines[59]).toContain("enter: show / hide");
    expect(lines[1]).toContain("2 idle");
    expect(lines[3]).toContain("1 explore");
    expect(lines[6]).toContain("2 dev");
  });

  test("the status pane shows the status alone, and a click on it does nothing", async () => {
    const harness = await setup(30, 50);
    const pressed: [string, string | undefined][] = [];
    const view = createStatusView(harness.renderer, {
      run: (action, subject) => pressed.push([action, subject]),
      version: "1.2.3",
    });
    view.update(workspace([], { detail: "I have started a reviewer agent on this branch." }), NOW);
    await harness.renderOnce();
    const lines = harness.captureCharFrame().split("\n");
    expect(lines[1]?.trim()).toBe("○ idle");
    expect(lines[2]).toContain("model N/A");
    await harness.mockMouse.click(4, 1);
    expect(pressed).toEqual([]);
  });

  test("an empty list says how to start an agent", async () => {
    const harness = await setup(34, 12);
    const view = createAgentsView(harness.renderer, quiet);
    view.update(workspace([]), NOW);
    await harness.renderOnce();
    const frame = harness.captureCharFrame();
    expect(frame).toContain("AGENTS 0");
    expect(frame).toContain("No agents running.");
  });

  test("keys move the cursor and show or hide agents", async () => {
    const harness = await setup(34, 20);
    const opened: string[] = [];
    const tooled: string[] = [];
    let closed = 0;
    const view = createAgentsView(harness.renderer, {
      toggle: (id) => opened.push(id),
      close: () => closed++,
      tools: (id) => tooled.push(id),
      open() {},
      clearMessages() {},
    });
    view.update(workspace([agent("a"), agent("b"), agent("c")]), NOW);
    await harness.renderOnce();

    harness.mockInput.pressKey("j");
    harness.mockInput.pressKey("t");
    harness.mockInput.pressEnter();
    harness.mockInput.pressKey("3");
    harness.mockInput.pressKey("9");
    harness.mockInput.pressKey("x");
    await harness.renderOnce();
    expect(opened).toEqual(["id-b", "id-c"]);
    expect(tooled).toEqual(["id-b"]);
    expect(closed).toBe(1);
  });

  test("clicking a tile shows or hides that agent", async () => {
    const harness = await setup(34, 20);
    const opened: string[] = [];
    const view = createAgentsView(harness.renderer, {
      ...quiet,
      toggle: (id) => opened.push(id),
    });
    view.update(workspace([agent("a"), agent("b")]), NOW);
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

  test("the name is drawn large over the version where the pane has room for it", async () => {
    const draw = async (width: number, height: number) => {
      const harness = await setup(width, height);
      createStatusView(harness.renderer, noActions).update(workspace([]), NOW);
      await harness.renderOnce();
      const rows = harness.captureCharFrame().trimEnd().split("\n");
      await dispose?.();
      dispose = undefined;
      return rows.map((row) => row.trimEnd());
    };
    const roomy = await draw(30, 50);
    expect(roomy.slice(-2)).toEqual([" │____╱  ╲_╱╲_╱_╱   ╲_╲", " dwa 1.2.3"]);
    expect(roomy.at(-6)).toBe("  ______        ___");
    // Too narrow or too short: the version alone, and the shortcuts stay.
    for (const rows of [await draw(20, 50), await draw(30, 41)]) {
      expect(rows.at(-1)).toBe(" dwa 1.2.3");
      expect(rows.join("\n")).not.toContain("╲_╲");
      expect(rows.join("\n")).toContain("Detach");
    }
  });

  test("the status pane ends with clickable actions and shortcuts, and the version", async () => {
    const harness = await setup(30, 42);
    const pressed: string[] = [];
    const view = createStatusView(harness.renderer, {
      run: (action) => pressed.push(action),
      version: "1.2.3",
    });
    view.update(workspace([agent("dev")]), NOW);
    await harness.renderOnce();
    let lines = harness.captureCharFrame().split("\n");
    // The prefix once, then the shortcuts in sections.
    expect(lines.slice(18, 42).map((line) => line.trim())).toEqual([
      "SHORTCUTS  Ctrl+Q, then",
      "",
      "Workflows",
      "▸ Workflows  w",
      "▸ Workflow designer  g",
      "",
      "Agents",
      "▸ New agent  a",
      "▸ Agent tools  t",
      "▸ Role settings  r",
      "▸ Answer  q",
      "▸ Open agent  1-9",
      "",
      "Panes",
      "▸ Shell  s",
      "▸ Focus main  0",
      "▸ Zoom main  z",
      "▸ Close pane  x",
      "",
      "Workspace",
      "▸ Menu  p",
      "▸ Detach  d",
      "",
      "dwa 1.2.3",
    ]);

    for (let row = 18; row < 42; row++) await harness.mockMouse.click(4, row);
    harness.mockInput.pressKey("w");
    harness.mockInput.pressKey("0");
    harness.mockInput.pressKey("d");
    await harness.renderOnce();
    // Titles, gaps and the hint for opening an agent are not buttons.
    expect(pressed).toEqual([
      "workflows",
      "design",
      "agent",
      "tools",
      "roles",
      "questions",
      "shell",
      "focus",
      "zoom",
      "close",
      "palette",
      "detach",
      "workflows",
      "focus",
      "detach",
    ]);

    view.update({ ...workspace([]), shell: { open: true }, keyPrefix: "C-a" }, NOW);
    await harness.renderOnce();
    lines = harness.captureCharFrame().split("\n");
    expect(lines.some((line) => line.trim() === "▸ Hide shell  s")).toBe(true);
    expect(lines.some((line) => line.trim() === "SHORTCUTS  Ctrl+A, then")).toBe(true);
  });

  test("a short status pane drops the last sections of shortcuts, not what needs the user", async () => {
    const harness = await setup(30, 35);
    const view = createStatusView(harness.renderer, noActions);
    view.update(workspace([agent("dev", { activity: "needs_user", detail: "permission" })]), NOW);
    await harness.renderOnce();
    const lines = harness.captureCharFrame().split("\n");
    expect(lines.join("\n")).toContain("NEEDS YOU");
    expect(lines.join("\n")).not.toContain("Panes");
    expect(lines.join("\n")).not.toContain("Workspace");
    expect(lines.slice(21, 35).map((line) => line.trim())).toEqual([
      "SHORTCUTS  Ctrl+Q, then",
      "",
      "Workflows",
      "▸ Workflows  w",
      "▸ Workflow designer  g",
      "",
      "Agents",
      "▸ New agent  a",
      "▸ Agent tools  t",
      "▸ Role settings  r",
      "▸ Answer  q",
      "▸ Open agent  1-9",
      "",
      "dwa 1.2.3",
    ]);
  });

  test("more than twelve agents shows a range and scrolls to the cursor", async () => {
    const harness = await setup(34, 45);
    const view = createAgentsView(harness.renderer, quiet);
    const many = Array.from({ length: 15 }, (_, i) => agent(`agent${i + 1}`));
    view.update(workspace(many), NOW);
    await harness.renderOnce();
    let frame = harness.captureCharFrame();
    expect(frame).toContain("AGENTS 1–12 of 15");
    expect(frame).toContain("12 agent12");
    expect(frame).not.toContain("13 agent13");

    for (let i = 0; i < 14; i++) harness.mockInput.pressKey("j");
    await harness.renderOnce();
    view.update(workspace(many), NOW);
    await harness.renderOnce();
    frame = harness.captureCharFrame();
    expect(frame).toContain("15 agent15");
    expect(frame).toContain("AGENTS 4–15 of 15");
  });

  test("the status pane shows figures, N/A for missing ones, and who needs the user", async () => {
    const harness = await setup(30, 30);
    const view = createStatusView(harness.renderer, noActions);
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
    expect(frame).toContain("● working");
    expect(frame).not.toContain("Read");
    expect(frame).toContain("Opus 5.5 · $0.70");
    // Each meter says its value once, at the right of its title, over a thin bar.
    expect(frame).toContain(`context${" ".repeat(13)}41%/200k`);
    expect(frame).toContain("━".repeat(11) + "─".repeat(17));
    expect(frame).toContain(`5 hours  in 2h 5m${" ".repeat(8)}19%`);
    expect(frame).toContain(`7 days  in 2d 14h${" ".repeat(8)}92%`);
    expect(frame).not.toContain("█");
    expect(frame).toContain("NEEDS YOU");
    expect(frame).toContain("◆ dev");
    expect(frame).toContain("dwa 1.2.3");
    expect(frame).not.toContain("QUESTIONS");

    view.update(workspace([]), NOW);
    await harness.renderOnce();
    frame = harness.captureCharFrame();
    expect(frame).toContain("model N/A · cost N/A");
    expect(frame).toContain("N/A");
    expect(frame).not.toContain("NEEDS YOU");
  });
});

describe("clicking lines of the status pane", () => {
  const step = {
    attempt: 1,
    dependsOn: [],
    agent: null,
    result: null,
    error: null,
    needsAttention: false,
  };
  const run: WorkflowRunInfo = {
    id: 3,
    name: "feature",
    input: "",
    state: "running",
    startedBy: "user",
    createdAt: NOW,
    finishedAt: null,
    steps: [{ ...step, id: "build", state: "running" }],
  };
  const question = {
    id: 7,
    from: "dev",
    to: "user",
    fromId: "id-dev",
    toId: "user",
    question: "Which database?",
    options: [],
    createdAt: NOW,
  };

  test("a run and a step open that run, other lines nothing", async () => {
    const harness = await createTestRenderer({ width: 30, height: 50 });
    const pressed: [string, string | undefined][] = [];
    const view = createStatusView(harness.renderer, {
      run: (action, subject) => pressed.push([action, subject]),
      version: "1.2.3",
    });
    view.update(
      {
        ...workspace([agent("dev")]),
        workflows: [run],
        questions: [question],
        inbox: [{ id: 1, from: "dev", body: "The fix is ready for review.", createdAt: NOW }],
      },
      NOW,
    );
    await harness.renderOnce();
    const lines = harness.captureCharFrame().split("\n");
    const click = async (part: string) => {
      const row = lines.findIndex((line) => line.includes(part));
      expect(row).toBeGreaterThan(-1);
      await harness.mockMouse.click(4, row);
      await harness.renderOnce();
    };
    await click("#3 feature");
    await click("● build");
    await click("USAGE");
    harness.renderer.destroy();
    expect(pressed).toEqual([
      ["design", "run:3"],
      ["design", "run:3"],
    ]);
  });

  test("after a message replaced the text nothing is clickable", async () => {
    const harness = await createTestRenderer({ width: 30, height: 50 });
    const pressed: string[] = [];
    const view = createStatusView(harness.renderer, {
      run: (action) => pressed.push(action),
      version: "1.2.3",
    });
    view.update({ ...workspace([agent("dev")]), workflows: [run], questions: [question] }, NOW);
    await harness.renderOnce();
    const row = harness
      .captureCharFrame()
      .split("\n")
      .findIndex((line) => line.includes("#3 feature"));
    view.showMessage("The daemon is not running.");
    await harness.renderOnce();
    await harness.mockMouse.click(4, row);
    harness.renderer.destroy();
    expect(pressed).toEqual([]);
  });
});

describe("wrapAll", () => {
  test("keeps every word and the indent of a continued line", () => {
    expect(wrapAll("  step: done\n      one two three four", 16)).toEqual([
      "  step: done",
      "      one two",
      "      three four",
    ]);
    expect(wrapAll("short", 16)).toEqual(["short"]);
    expect(wrapAll("a\n\nb", 16)).toEqual(["a", "", "b"]);
    // A word longer than the row is cut, not dropped.
    expect(wrapAll("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
});
