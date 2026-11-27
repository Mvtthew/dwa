import { afterEach, describe, expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { AgentInfo, WorkflowRunInfo, WorkspaceState } from "../src/shared/protocol.ts";
import { leaderScreen } from "../src/ui/tool-screens.ts";
import { createWizard, type Row, type Screen } from "../src/ui/wizard.ts";
import { agentScreen, menuScreen, type WizardApi, workflowsScreen } from "../src/ui/wizards.ts";

interface Call {
  path: string;
  body: unknown;
}

function fakeApi(routes: Record<string, (body: Record<string, unknown>) => unknown> = {}) {
  const calls: Call[] = [];
  const api: WizardApi = {
    roles: ["developer", "reviewer"],
    profiles: ["me", "work"],
    call: async <T>(_method: string, path: string, body?: unknown) => {
      calls.push({ path, body });
      const handler = routes[path];
      if (!handler) throw new Error(`no route ${path}`);
      return handler((body ?? {}) as Record<string, unknown>) as T;
    },
  };
  return { api, calls };
}

function step(id: string, state: WorkflowRunInfo["steps"][number]["state"]) {
  return {
    id,
    state,
    attempt: 1,
    dependsOn: [],
    agent: state === "running" ? id : null,
    result: state === "done" ? `${id} result` : null,
    error: null,
    needsAttention: state === "rejected",
  };
}

const run: WorkflowRunInfo = {
  id: 2,
  name: "feature",
  input: "x",
  state: "running",
  startedBy: "user",
  createdAt: 0,
  finishedAt: null,
  steps: [step("explore", "done"), step("build", "running"), step("review", "rejected")],
};

function textOf(row: Row): string {
  return "text" in row ? row.text : "";
}

/** The buttons of a screen by label. */
function buttons(screen: Screen) {
  const found = new Map<string, Extract<Row, { kind: "button" }>>();
  for (const row of screen.rows) if (row.kind === "button") found.set(row.label, row);
  return found;
}

async function press(screen: Screen, label: string, values: Record<string, string> = {}) {
  const button = buttons(screen).get(label);
  if (!button)
    throw new Error(`no button "${label}" in: ${[...buttons(screen).keys()].join(", ")}`);
  return button.run(values);
}

async function next(screen: Screen, label: string): Promise<Screen> {
  const outcome = await press(screen, label);
  if (!("to" in outcome)) throw new Error(`"${label}" does not lead to a screen`);
  return outcome.to;
}

describe("the workflows wizard", () => {
  const listing = {
    workflows: [
      { name: "feature", description: "Explore, build, review", steps: ["a", "b"], error: null },
      { name: "plain", description: null, steps: ["a", "b"], error: null },
      { name: "broken", description: null, steps: [], error: "invalid TOML" },
    ],
    runs: [run],
  };

  test("lists what can be started and the runs, and marks a run that needs the user", async () => {
    const { api } = fakeApi({ "/workflows": () => listing });
    const screen = await workflowsScreen(api);
    expect(
      screen.rows.map((row) =>
        row.kind === "button" ? `[${row.label}] ${row.hint ?? ""}`.trim() : textOf(row),
      ),
    ).toEqual([
      "START A RUN",
      "[feature] Explore, build, review",
      "[plain] a → b",
      "broken: invalid TOML",
      "",
      "RUNS",
      "[#2 feature] running · needs you",
      "",
      "[Close]",
    ]);
  });

  test("starts a run with what the user typed", async () => {
    const { api, calls } = fakeApi({ "/workflows": () => listing, "/workflows/run": () => run });
    const start = await next(await workflowsScreen(api), "feature");
    expect(start.title).toBe('Start "feature"');
    expect(await press(start, "Start", { input: "  add a flag " })).toEqual({ close: true });
    expect(calls.at(-1)).toEqual({
      path: "/workflows/run",
      body: { name: "feature", input: "add a flag" },
    });
  });

  test("an empty project says where workflows go", async () => {
    const { api } = fakeApi({ "/workflows": () => ({ workflows: [], runs: [] }) });
    const texts = (await workflowsScreen(api)).rows.map((row) =>
      row.kind === "button" ? row.label : textOf(row),
    );
    expect(texts).toContain("No workflows defined. Add one with: dwa workflow new <name>");
    expect(texts).toContain("No runs yet.");
  });
});

describe("the new-agent wizard", () => {
  test("offers roles, profiles, models and effort levels", () => {
    const { api } = fakeApi();
    const choices = agentScreen(api).rows.flatMap((row) =>
      row.kind === "choice" ? [[row.key, row.options.map((option) => option.label).join(" ")]] : [],
    );
    expect(choices).toEqual([
      ["role", "none developer reviewer"],
      ["profile", "default me work"],
      ["model", "default opus sonnet haiku"],
      ["effort", "default low medium high xhigh max"],
    ]);
    const single = agentScreen({ ...api, profiles: ["me"] });
    expect(single.rows.some((row) => row.kind === "choice" && row.key === "profile")).toBe(false);
  });

  test("sends only what was set, and can show the new agent", async () => {
    const { api, calls } = fakeApi({
      "/agents": () => ({ id: "a1", name: "helper" }),
      "/agents/open": () => ({}),
    });
    const screen = agentScreen(api);
    await press(screen, "Start", { name: "", role: "", model: "", effort: "", task: " " });
    expect(calls).toEqual([{ path: "/agents", body: {} }]);

    await press(screen, "Start and show it", {
      name: " helper ",
      role: "developer",
      profile: "work",
      model: "opus",
      otherModel: "claude-custom-1",
      effort: "high",
      task: "fix the bug",
    });
    expect(calls.slice(1)).toEqual([
      {
        path: "/agents",
        body: {
          name: "helper",
          role: "developer",
          profile: "work",
          model: "claude-custom-1",
          effort: "high",
          task: "fix the bug",
        },
      },
      { path: "/agents/open", body: { target: "a1" } },
    ]);
  });
});

describe("the menu", () => {
  const session = (name: string, extra: Partial<AgentInfo> = {}) =>
    ({
      id: `id-${name}`,
      kind: "agent",
      name,
      activity: "idle",
      open: false,
      ...extra,
    }) as AgentInfo;
  const state = (extra: Partial<WorkspaceState> = {}) =>
    ({
      main: session("main", { kind: "main", activity: "working" }),
      agents: [session("dev", { open: true, activity: "needs_user" }), session("rev")],
      questions: [],
      shell: null,
      ...extra,
    }) as WorkspaceState;

  test("lists the sessions and what the workspace can do", async () => {
    const { api } = fakeApi({ "/state": () => state({ questions: [{}, {}] as never }) });
    const screen = await menuScreen(api);
    expect(
      screen.rows.map((row) =>
        row.kind === "button" ? `[${row.label}] ${row.hint ?? ""}`.trim() : textOf(row),
      ),
    ).toEqual([
      "[Answer questions (2 open)]",
      "SESSIONS",
      "[main] working",
      "[dev] shown · needs user",
      "[rev] idle",
      "",
      "WORKSPACE",
      "[Start an agent…]",
      "[Workflows…]",
      "[Leader mode…] whether the main session hands work to agents",
      "[Report a problem…] a session or a role that lacks something",
      "[Show the shell]",
      "[Hide the focused agent or shell]",
      "[Clear the feed…] entries stay stored, and are not shown again",
      "[Stop the workspace…]",
      "",
      "[Close]",
    ]);
    expect(await press(screen, "Answer questions (2 open)")).toEqual({ exec: ["answer"] });
  });

  test("a session can be shown or hidden, messaged and stopped; main only focused and messaged", async () => {
    const { api, calls } = fakeApi({
      "/state": () => state({ shell: { open: true } }),
      "/agents/toggle": () => ({}),
      "/messages": () => ({}),
      "/agents/stop": () => ({}),
      "/focus": () => ({}),
      "/shell/toggle": () => ({}),
      "/down": () => ({}),
    });
    const menu = await menuScreen(api);
    const dev = await next(menu, "dev");
    expect([...buttons(dev).keys()]).toEqual([
      "Hide it",
      "Tools…",
      "Send a message…",
      "Stop it…",
      "Back",
    ]);
    await press(dev, "Hide it");
    await press(await next(dev, "Send a message…"), "Send", { text: "status?" });
    await press(await next(dev, "Stop it…"), "Yes, stop it");

    const main = await next(menu, "main");
    expect([...buttons(main).keys()]).toEqual(["Focus it", "Tools…", "Send a message…", "Back"]);
    await press(main, "Focus it");
    expect([...buttons(await next(menu, "rev")).keys()][0]).toBe("Show it");

    await press(menu, "Hide the shell");
    await press(await next(menu, "Stop the workspace…"), "Yes, stop everything");
    expect(calls.slice(1)).toEqual([
      { path: "/agents/toggle", body: { target: "id-dev" } },
      { path: "/messages", body: { to: "id-dev", body: "status?" } },
      { path: "/agents/stop", body: { target: "id-dev" } },
      { path: "/focus", body: undefined },
      { path: "/shell/toggle", body: undefined },
      { path: "/down", body: undefined },
    ]);
  });

  test("leads on to the agent and workflow wizards", async () => {
    const { api } = fakeApi({
      "/state": () => state(),
      "/workflows": () => ({ workflows: [], runs: [] }),
    });
    const menu = await menuScreen(api);
    expect((await next(menu, "Start an agent…")).title).toBe("Start an agent");
    expect((await next(menu, "Workflows…")).title).toBe("Workflows");
  });

  describe("the leader mode switch", () => {
    test("asks how to restart the main session, then says what happened", async () => {
      const sent: unknown[] = [];
      const { api } = fakeApi({
        "/main/leader": (body) => {
          if (!("on" in body)) return { on: true, project: false };
          sent.push(body);
          return body.when
            ? { on: false, project: false, applied: "restarted" }
            : { on: true, project: false, applied: "ask", reason: "main" };
        },
        "/state": () => state(),
      });
      const screen = await leaderScreen(api);
      expect(screen.title).toBe("Leader mode: on");
      const ask = await next(screen, "Turn leader mode off…");
      expect(ask.title).toBe("Restart main?");
      const done = await next(ask, "Restart now");
      expect(done.title).toBe("Leader mode: off");
      expect(sent).toEqual([
        { on: false, when: undefined },
        { on: false, when: "now" },
      ]);
    });

    test("offers no switch when the project's config decides", async () => {
      const { api } = fakeApi({
        "/main/leader": () => ({ on: false, project: true }),
        "/state": () => state(),
      });
      const screen = await leaderScreen(api);
      expect(screen.title).toBe("Leader mode: off");
      expect([...buttons(screen).keys()]).toEqual(["Close"]);
    });
  });
});

describe("the wizard on screen", () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  async function setup(first: Screen) {
    const harness = await createTestRenderer({ width: 60, height: 24 });
    dispose = () => harness.renderer.destroy();
    const done = createWizard(harness.renderer, first);
    const frame = async () => {
      await harness.renderOnce();
      return harness.captureCharFrame();
    };
    /** Clicks the lowest place `text` is shown (the title may repeat a button's word). */
    const click = async (text: string) => {
      const lines = (await frame()).split("\n");
      const y = lines.findLastIndex((line) => line.includes(text));
      if (y === -1) throw new Error(`"${text}" is not on screen:\n${lines.join("\n")}`);
      await harness.mockMouse.click((lines[y] ?? "").indexOf(text) + 1, y);
      await Bun.sleep(5);
      await harness.renderOnce();
    };
    return { harness, done, frame, click };
  }

  test("a note longer than the form goes on below instead of being cut", async () => {
    const text = `explore: done\n      ${"word ".repeat(20)}the very end`;
    const { frame } = await setup({
      title: "Results",
      rows: [
        { kind: "note", text },
        { kind: "button", label: "Back", run: () => ({ close: true }) },
      ],
    });
    const lines = (await frame()).split("\n");
    const last = lines.findIndex((line) => line.includes("the very end"));
    expect(last).toBeGreaterThan(-1);
    // The continued line keeps the indent, and the button comes after the whole note.
    expect(lines[last]).toMatch(/^\s{6,}\S/);
    expect(lines.findIndex((line) => line.includes("Back"))).toBeGreaterThan(last);
  });

  function form(sent: Record<string, string>[]): Screen {
    return {
      title: "Start an agent",
      rows: [
        { kind: "heading", text: "DETAILS" },
        { kind: "input", key: "name", label: "Name", placeholder: "agent" },
        {
          kind: "choice",
          key: "model",
          label: "Model",
          options: [
            { value: "", label: "default" },
            { value: "opus", label: "opus" },
            { value: "sonnet", label: "sonnet" },
          ],
        },
        {
          kind: "button",
          label: "More",
          run: () => ({
            to: {
              title: "Second screen",
              rows: [{ kind: "button", label: "Back", run: () => ({ back: true }) }],
            },
          }),
        },
        {
          kind: "button",
          label: "Start",
          run: (values) => {
            sent.push(values);
            if (!values.name) throw new Error("Give it a name.");
            return { close: true };
          },
        },
      ],
    };
  }

  test("shows the rows, takes typing and clicks, and reports a refusal", async () => {
    const sent: Record<string, string>[] = [];
    const { harness, done, frame, click } = await setup(form(sent));
    const shown = await frame();
    expect(shown).toContain("Start an agent");
    expect(shown).toContain("DETAILS");
    expect(shown).toContain("▌  Name");
    expect(shown).toContain("[default] opus  sonnet");
    // The input sits in a rounded frame under its label and shows its placeholder while empty.
    const lines = shown.split("\n");
    const label = lines.findIndex((line) => line.includes("▌  Name"));
    expect(lines[label + 1]).toMatch(/^ {5}╭─+╮/);
    expect(lines[label + 2]).toMatch(/^ {5}│ agent\s+│/);
    expect(lines[label + 3]).toMatch(/^ {5}╰─+╯/);
    const placeholder = harness
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.trim() === "agent");
    expect((placeholder?.attributes ?? 0) & TextAttributes.DIM).toBe(TextAttributes.DIM);

    await click("Start");
    await Bun.sleep(0);
    expect(await frame()).toContain("Give it a name.");

    await click("Name");
    await harness.mockInput.typeText("helper");
    expect(await frame()).toMatch(/│ helper\s+│/);
    await click("sonnet");
    expect(await frame()).toContain(" default  opus [sonnet]");
    await click("Start");
    expect(await done).toBeNull();
    expect(sent).toEqual([
      { name: "", model: "" },
      { name: "helper", model: "sonnet" },
    ]);
  });

  test("works from the keyboard: arrows, enter and escape", async () => {
    const sent: Record<string, string>[] = [];
    const { harness, done, frame } = await setup(form(sent));
    await harness.mockInput.typeText("kb");
    harness.mockInput.pressArrow("down");
    harness.mockInput.pressArrow("right");
    expect(await frame()).toContain(" default [opus] sonnet");
    harness.mockInput.pressArrow("down");
    harness.mockInput.pressEnter();
    await Bun.sleep(0);
    expect(await frame()).toContain("Second screen");
    harness.mockInput.pressEscape();
    // A lone escape is only told apart from the start of a key sequence after a moment.
    await Bun.sleep(100);
    expect(await frame()).toContain("Start an agent");

    // Coming back starts the form afresh.
    await harness.mockInput.typeText("again");
    harness.mockInput.pressArrow("down");
    harness.mockInput.pressArrow("down");
    harness.mockInput.pressArrow("down");
    harness.mockInput.pressEnter();
    expect(await done).toBeNull();
    expect(sent).toEqual([{ name: "again", model: "" }]);
  });

  test("escape on the first screen closes, and a command is handed back", async () => {
    const closing = await setup(form([]));
    closing.harness.mockInput.pressEscape();
    expect(await closing.done).toBeNull();
    dispose?.();

    const { done, click } = await setup({
      title: "Run",
      rows: [{ kind: "button", label: "Edit", run: () => ({ exec: ["workflow", "edit", "2"] }) }],
    });
    await click("Edit");
    expect(await done).toEqual(["workflow", "edit", "2"]);
  });
});
