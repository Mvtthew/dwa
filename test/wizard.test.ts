import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { AgentInfo, WorkflowRunInfo, WorkspaceState } from "../src/shared/protocol.ts";
import { createWizard, type Row, type Screen } from "../src/ui/wizard.ts";
import {
  agentScreen,
  menuScreen,
  runScreen,
  type WizardApi,
  workflowsScreen,
} from "../src/ui/wizards.ts";

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
    expect(texts).toContain("No workflows defined. Add one as .dwa/workflows/<name>.toml.");
    expect(texts).toContain("No runs yet.");
  });

  test("a running run offers its steps, a decision, editing and cancelling", async () => {
    const { api, calls } = fakeApi({
      "/workflows/status": () => run,
      "/workflows/step/complete": () => run,
      "/workflows/step/fail": () => run,
      "/workflows/step/decide": () => run,
      "/workflows/cancel": () => run,
    });
    const screen = runScreen(api, run);
    expect(screen.title).toBe('Run #2 of "feature": running');
    expect([...buttons(screen).keys()]).toEqual([
      "Complete it by hand…",
      "Fail it…",
      "Another pass",
      "Accept the work as it is",
      "Fail the run",
      "Edit the steps",
      "Cancel the run…",
      "Show the results",
      "Back",
    ]);

    const complete = await next(screen, "Complete it by hand…");
    await press(complete, "Complete the step", { text: "built by hand" });
    const fail = await next(screen, "Fail it…");
    await press(fail, "Fail the step and the run", { text: "wrong" });
    await press(screen, "Another pass");
    await press(await next(screen, "Cancel the run…"), "Yes, cancel the run");
    expect(calls).toEqual([
      { path: "/workflows/step/complete", body: { id: 2, step: "build", result: "built by hand" } },
      { path: "/workflows/step/fail", body: { id: 2, step: "build", reason: "wrong" } },
      { path: "/workflows/step/decide", body: { id: 2, step: "review", decision: "another pass" } },
      { path: "/workflows/cancel", body: { id: 2 } },
    ]);

    expect(await press(screen, "Edit the steps")).toEqual({ exec: ["workflow", "edit", "2"] });
    const results = await next(screen, "Show the results");
    expect(results.rows[0]).toMatchObject({ kind: "note" });
    expect((results.rows[0] as { text: string }).text).toContain("      explore result");
  });

  test("a finished run only shows its results", () => {
    const { api } = fakeApi();
    const done = runScreen(api, { ...run, state: "done", steps: [step("explore", "done")] });
    expect([...buttons(done).keys()]).toEqual(["Show the results", "Back"]);
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

    await press(screen, "Start and show it under main", {
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
      "[Show the shell]",
      "[Hide the pane under main]",
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
    expect([...buttons(dev).keys()]).toEqual(["Hide it", "Send a message…", "Stop it…", "Back"]);
    await press(dev, "Hide it");
    await press(await next(dev, "Send a message…"), "Send", { text: "status?" });
    await press(await next(dev, "Stop it…"), "Yes, stop it");

    const main = await next(menu, "main");
    expect([...buttons(main).keys()]).toEqual(["Focus it", "Send a message…", "Back"]);
    await press(main, "Focus it");
    expect([...buttons(await next(menu, "rev")).keys()][0]).toBe("Show it under main");

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

    await click("Start");
    await Bun.sleep(0);
    expect(await frame()).toContain("Give it a name.");

    await click("Name");
    await harness.mockInput.typeText("helper");
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
