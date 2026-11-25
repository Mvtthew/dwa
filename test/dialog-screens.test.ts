// The tools dialog and the role settings as data: which rows they show and what their
// buttons ask for. The form engine itself is tested in wizard-check.test.ts.
import { describe, expect, test } from "bun:test";
import type { History } from "../src/shared/history.ts";
import type {
  ToolsInfo,
  ToolsSaveRequest,
  ToolsSaveResult,
  WorkspaceState,
} from "../src/shared/protocol.ts";
import type { RoleChanges, RoleFields } from "../src/shared/role-edit.ts";
import { toolView } from "../src/shared/tools.ts";
import { type RoleStore, roleScreen, rolesScreen } from "../src/ui/role-screens.ts";
import { toolsPickScreen, toolsScreen } from "../src/ui/tool-screens.ts";
import { OFF, ON, type Outcome, type Row, type Screen, type Values } from "../src/ui/wizard.ts";
import type { WizardApi } from "../src/ui/wizards.ts";

type Button = Extract<Row, { kind: "button" }>;

function fakeApi(routes: Record<string, (body: Record<string, unknown>) => unknown>) {
  const calls: { path: string; body: unknown }[] = [];
  const api: WizardApi = {
    roles: [],
    profiles: [],
    call: async <T>(_method: string, path: string, body?: unknown) => {
      calls.push({ path, body });
      const handler = routes[path];
      if (!handler) throw new Error(`no route ${path}`);
      return handler((body ?? {}) as Record<string, unknown>) as T;
    },
  };
  return { api, calls };
}

const button = (screen: Screen, label: string): Button => {
  const found = screen.rows.find(
    (row): row is Button => row.kind === "button" && row.label.startsWith(label),
  );
  if (!found) throw new Error(`no button "${label}" on "${screen.title}"`);
  return found;
};
const labels = (screen: Screen, kind: Row["kind"]) =>
  screen.rows.flatMap((row) => (row.kind === kind && "label" in row ? [row.label] : []));
const text = (screen: Screen) =>
  screen.rows.flatMap((row) => (row.kind === "note" || row.kind === "heading" ? [row.text] : []));
/** Presses a button with the screen's own values, changed by `values`. */
async function press(screen: Screen, label: string, values: Values = {}): Promise<Screen> {
  const outcome: Outcome = await button(screen, label).run({ ...screen.values, ...values });
  if ("to" in outcome) return outcome.to;
  if ("replace" in outcome) {
    return {
      ...outcome.replace,
      values: { ...screen.values, ...values, ...outcome.replace.values },
    };
  }
  throw new Error(`"${label}" did not lead to a screen`);
}

function info(overrides: Partial<ToolsInfo> = {}): ToolsInfo {
  return {
    agent: { id: "id-3", name: "rev", role: "reviewer", kind: "agent", activity: "idle" },
    view: toolView(
      { tools: ["Read", "Bash"], allow: ["Bash(git log *)"], mcp: ["github"] },
      { tools: "role explore", allow: "role explore" },
      {
        projectServers: ["notes"],
        catalogue: ["github"],
        serverTools: { github: ["create_issue", "list_issues"] },
        seen: [],
      },
    ),
    files: [
      { label: "Role reviewer", file: { kind: "role", name: "reviewer" } },
      { label: "Role explore", file: { kind: "role", name: "explore" } },
      { label: "[defaults]", file: { kind: "defaults" } },
    ],
    outOfDate: false,
    ...overrides,
  };
}

describe("the tools dialog", () => {
  const saved = (result: Partial<ToolsSaveResult>) => {
    const requests: ToolsSaveRequest[] = [];
    const fake = fakeApi({
      "/tools?target=id-3": () => info(),
      "/tools": (body) => {
        requests.push(body as unknown as ToolsSaveRequest);
        return { applied: "live", behind: [], ...result };
      },
      "/agents/refresh": (body) => ({
        results: (body.targets as string[]).map((name) => ({ name, applied: "restarted" })),
      }),
    });
    return { ...fake, requests };
  };

  test("lists tools, servers and rules as switches in their sections", async () => {
    const { api } = saved({});
    const screen = await toolsScreen(api, "id-3");
    expect(screen.title).toBe("Tools: rev");
    expect(text(screen)).toContain("BUILT-IN TOOLS  from role explore");
    expect(text(screen)).toContain("This session has only the ticked tools.");
    expect(text(screen)).toContain("RULES  from role explore");
    const checks = labels(screen, "check");
    expect(checks.slice(0, 3)).toEqual(["Agent", "AskUserQuestion", "Bash"]);
    expect(checks.slice(-4)).toEqual(["dwa", "notes", "github", "allow Bash(git log *)"]);
    expect(screen.values).toMatchObject({
      "tool:Read": ON,
      "tool:Edit": OFF,
      "server:notes": ON,
      "rule:allow:Bash(git log *)": ON,
    });
    const github = screen.rows.find((row) => row.kind === "check" && row.label === "github");
    expect(github).toMatchObject({ hint: "2 tools ›" });
    const dwa = screen.rows.find((row) => row.kind === "check" && row.label === "dwa");
    expect(dwa).toMatchObject({ fixed: "always on" });
    expect(labels(screen, "button")).toEqual([
      "Add the rule",
      "Save for rev only",
      "Save for rev and next reviewer agents",
      "Save globally…",
      "Cancel",
    ]);
  });

  test("a server's tools open in place, and what was switched is sent as changes", async () => {
    const { api, requests } = saved({});
    let screen = await toolsScreen(api, "id-3");
    const github = screen.rows.find((row) => row.kind === "check" && row.label === "github");
    if (github?.kind !== "check" || !github.more) throw new Error("no more on github");
    const opened = await github.more({});
    if (!("replace" in opened)) throw new Error("expected a redraw");
    expect(labels(opened.replace, "check")).toContain("   create_issue");
    // A redraw names no values of its own: the switches stay as the user left them.
    expect(opened.replace.values).toEqual({});

    screen = await press(screen, "Add the rule", { newRule: " Bash(rm *) ", newRuleList: "deny" });
    expect(labels(screen, "check")).toContain("deny  Bash(rm *)");
    expect(screen.values).toMatchObject({ "rule:deny:Bash(rm *)": ON, newRule: "" });
    expect(() => button(screen, "Add the rule").run({ newRule: "" })).toThrow("Type the rule");

    const done = await press(screen, "Save for rev only", {
      "tool:Bash": OFF,
      "tool:Edit": ON,
      "server:notes": OFF,
      "st:github:create_issue": OFF,
      "rule:allow:Bash(git log *)": OFF,
    });
    expect(requests[0]).toEqual({
      target: "id-3",
      scope: "agent",
      file: undefined,
      when: undefined,
      changes: [
        { kind: "tool", name: "Bash", on: false },
        { kind: "tool", name: "Edit", on: true },
        { kind: "server", name: "notes", on: false },
        { kind: "server-tool", server: "github", name: "create_issue", on: false },
        { kind: "rule", list: "allow", rule: "Bash(git log *)", on: false },
        { kind: "rule", list: "deny", rule: "Bash(rm *)", on: true },
      ],
    });
    expect(text(done).join("\n")).toContain("no restart was needed");
    expect(button(screen, "Save for rev only").run(screen.values ?? {})).resolves.toBeDefined();
    const untouched = await toolsScreen(api, "id-3");
    expect(button(untouched, "Save for rev only").run(untouched.values ?? {})).rejects.toThrow(
      "Nothing was changed",
    );
  });

  test("asks how to restart when the daemon needs to know, then sends again", async () => {
    const requests: ToolsSaveRequest[] = [];
    const { api } = fakeApi({
      "/tools?target=id-3": () => info(),
      "/tools": (body) => {
        const request = body as unknown as ToolsSaveRequest;
        requests.push(request);
        return request.when
          ? { applied: "pending", behind: [] }
          : { applied: "ask", reason: "working", behind: [] };
      },
    });
    const screen = await toolsScreen(api, "id-3");
    const ask = await press(screen, "Save for rev and next", { "tool:Edit": ON });
    expect(ask.title).toBe("Restart rev?");
    expect(labels(ask, "button")).toEqual(["Restart when its turn ends", "Restart now", "Back"]);
    const done = await press(ask, "Restart when its turn ends");
    expect(requests.map((request) => [request.scope, request.when])).toEqual([
      ["run", undefined],
      ["run", "turn-end"],
    ]);
    expect(text(done).join("\n")).toContain("restarts with the change when its turn ends");
  });

  test("saving globally asks where, then which running sessions get it now", async () => {
    const behind = [
      { id: "id-3", name: "rev", role: "reviewer", kind: "agent", activity: "idle" },
      { id: "id-5", name: "ex", role: "explore", kind: "agent", activity: "working" },
    ] as ToolsSaveResult["behind"];
    const { api, requests, calls } = saved({ applied: "unchanged", version: 4, behind });
    const screen = await toolsScreen(api, "id-3");
    const where = await press(screen, "Save globally", { "tool:Bash": OFF });
    expect(labels(where, "button")).toEqual([
      "Role reviewer",
      "Role explore",
      "[defaults]",
      "Back",
    ]);
    const sessions = await press(where, "Role explore");
    expect(requests[0]).toMatchObject({ scope: "file", file: { kind: "role", name: "explore" } });
    expect(text(sessions)).toContain("Saved (v4).");
    // The session the dialog was opened for is ticked; the others are the user's to tick.
    expect(sessions.values).toEqual({ "id-3": ON, "id-5": OFF });
    const applied = await press(sessions, "Apply to the ticked sessions", {
      "id-5": ON,
      when: "turn-end",
    });
    expect(calls.at(-1)).toEqual({
      path: "/agents/refresh",
      body: { targets: ["id-3", "id-5"], when: "turn-end" },
    });
    expect(text(applied).join("\n")).toContain("id-3 was restarted with its conversation");
  });

  test("without a session, offers the running ones; main has no role button", async () => {
    const main = { id: "id-1", name: "main", role: "main", kind: "main", activity: "idle" };
    const state = {
      main,
      agents: [{ id: "id-3", name: "rev", role: "reviewer", outOfDate: true }],
    } as unknown as WorkspaceState;
    const { api } = fakeApi({
      "/state": () => state,
      "/tools?target=id-1": () => info({ agent: main as ToolsInfo["agent"] }),
    });
    const pick = await toolsPickScreen(api);
    expect(labels(pick, "button")).toEqual(["main", "rev", "Close"]);
    expect(button(pick, "rev").hint).toBe("reviewer · role changed since start");
    const screen = await press(pick, "main");
    expect(labels(screen, "button")).not.toContain("Save for main and next main agents");
  });
});

function fakeStore(roles: Record<string, RoleFields>) {
  const saves: { name: string; changes: RoleChanges }[] = [];
  const log: string[] = [];
  const history: History = {
    current: 3,
    versions: [
      { n: 1, time: "2026-11-23T18:00:00.000Z", source: "first version", hash: "a" },
      { n: 2, time: "2026-11-24T09:30:00.000Z", source: "role settings", hash: "b" },
      { n: 3, time: "2026-11-25T14:02:00.000Z", source: "tools dialog", hash: "c" },
    ],
  };
  const store: RoleStore = {
    list: () =>
      Object.entries(roles).map(([name, role]) => ({
        name,
        personal: false,
        description: role.description ?? null,
        error: null,
      })),
    load: (name) => roles[name] ?? {},
    save: (name, changes) => {
      saves.push({ name, changes });
      return 7;
    },
    create: (name, description) => {
      roles[name] = { description };
      log.push(`create ${name}`);
    },
    duplicate: (from, to) => {
      roles[to] = { ...roles[from] };
      log.push(`duplicate ${from} ${to}`);
    },
    rename: (from, to) => {
      roles[to] = roles[from] ?? {};
      delete roles[from];
      log.push(`rename ${from} ${to}`);
    },
    remove: (name) => {
      delete roles[name];
      log.push(`remove ${name}`);
    },
    users: (name) => (name === "explore" ? ["role reviewer extends it"] : []),
    history: () => history,
    diff: (_name, from, to) => [`- from v${from}`, `+ to v${to}`],
    switchTo: (name, n) => {
      log.push(`switch ${name} v${n}`);
    },
    choices: () => ({
      mcp: ["github"],
      plugins: ["lint"],
      skills: ["review-checklist"],
      projectMcp: ["notes"],
    }),
  };
  return { store, saves, log };
}

describe("the role settings", () => {
  const roles = (): Record<string, RoleFields> => ({
    explore: {
      description: "Reads",
      model: "sonnet",
      tools: ["Read", "Bash"],
      permission_mode: "dontAsk",
      allow: ["Bash(git log *)"],
    },
    reviewer: { description: "Reviews", extends: "explore", model: "claude-opus-5-5", skills: [] },
  });
  const state = (agents: { name: string; role: string }[]) =>
    fakeApi({ "/state": () => ({ main: null, agents }) as unknown as WorkspaceState });

  test("lists the roles and creates one", async () => {
    const { store, log } = fakeStore(roles());
    const { api } = state([]);
    const list = rolesScreen(api, store);
    expect(labels(list, "button")).toEqual(["explore", "reviewer", "New role…", "Close"]);
    expect(button(list, "explore").hint).toBe("Reads");
    const form = await press(list, "New role");
    expect(() => button(form, "Create").run({ name: " " })).toThrow("Type a name");
    const created = await press(form, "Create", { name: "tester", description: "Tests" });
    expect(log).toEqual(["create tester"]);
    expect(created.title).toBe("Role: tester");
  });

  test("shows a role's own values, with inherit for what it does not set", () => {
    const { store } = fakeStore(roles());
    const screen = roleScreen(state([]).api, store, "reviewer");
    expect(screen.values).toMatchObject({
      description: "Reviews",
      extends: "explore",
      model: "",
      otherModel: "claude-opus-5-5",
      effort: "",
      permission_mode: "",
      memory: "",
      toolsMode: "",
      mcpMode: "",
      // An empty list is a value of its own: no project skills.
      skillsMode: "own",
      "skills:review-checklist": OFF,
      allowMode: "",
    });
    const explore = roleScreen(state([]).api, store, "explore");
    expect(explore.values).toMatchObject({
      model: "sonnet",
      toolsMode: "only",
      "tools:Read": ON,
      "tools:Edit": OFF,
      allowMode: "own",
      "allow:Bash(git log *)": ON,
    });
    // The other role is offered to start from; the role itself is not.
    const parent = explore.rows.find((row) => row.kind === "choice" && row.key === "extends");
    expect(parent?.kind === "choice" && parent.options.map((option) => option.value)).toEqual([
      "",
      "reviewer",
    ]);
  });

  test("saves only what changed, removes what goes back to inherit", async () => {
    const { store, saves } = fakeStore(roles());
    const { api } = state([{ name: "ex", role: "explore" }]);
    const screen = roleScreen(api, store, "explore");
    expect(button(screen, "Save").run(screen.values ?? {})).rejects.toThrow("Nothing was changed");
    const done = await press(screen, "Save", {
      model: "",
      effort: "high",
      "tools:Bash": OFF,
      "tools:Glob": ON,
      moreTools: "TodoWrite, ",
      allowMode: "",
      mcpMode: "own",
      "mcp:github": ON,
      memory: ON,
      off_skills: "dataviz, loop",
    });
    expect(saves).toEqual([
      {
        name: "explore",
        changes: {
          model: null,
          effort: "high",
          tools: ["Read", "Glob", "TodoWrite"],
          allow: null,
          mcp: ["github"],
          memory: true,
          off_skills: ["dataviz", "loop"],
        },
      },
    ]);
    expect(text(done).join("\n")).toContain("Role explore is at v7.");
    expect(text(done).join("\n")).toContain("Running now with the old settings: ex.");
  });

  test("switching the tool list to a deny list writes the other key", async () => {
    const { store, saves } = fakeStore(roles());
    const screen = roleScreen(state([]).api, store, "explore");
    await press(screen, "Save", { toolsMode: "except", "tools:Bash": OFF });
    const changes = saves[0]?.changes ?? {};
    expect(changes.tools).toBeNull();
    // Everything that is not ticked: the role had only Read and Bash, and Bash was unticked.
    expect(changes.deny_tools).not.toContain("Read");
    expect(changes.deny_tools).toContain("Bash");
    expect(changes.deny_tools).toContain("Edit");
  });

  test("a rule typed in is added ticked, without losing the rest of the form", async () => {
    const { store, saves } = fakeStore(roles());
    const first = roleScreen(state([]).api, store, "reviewer");
    const screen = await press(first, "Add to the deny rules", {
      description: "Reviews carefully",
      "new:deny": "Bash(git push *)",
    });
    expect(screen.values).toMatchObject({
      description: "Reviews carefully",
      denyMode: "own",
      "deny:Bash(git push *)": ON,
      "new:deny": "",
    });
    await press(screen, "Save");
    expect(saves[0]?.changes).toEqual({
      description: "Reviews carefully",
      deny: ["Bash(git push *)"],
    });
  });

  test("the prompt opens in the editor only when the form is saved", async () => {
    const { store } = fakeStore(roles());
    const screen = roleScreen(state([]).api, store, "reviewer");
    expect(await button(screen, "Edit the prompt").run(screen.values ?? {})).toEqual({
      exec: ["role", "edit-prompt", "reviewer"],
    });
    expect(() =>
      button(screen, "Edit the prompt").run({ ...screen.values, description: "x" }),
    ).toThrow("Save or undo");
  });

  test("history shows versions newest first, the changes, and switches", async () => {
    const { store, log } = fakeStore(roles());
    const screen = roleScreen(state([]).api, store, "reviewer");
    const history = await press(screen, "History");
    expect(labels(history, "button")).toEqual(["* v3", "  v2", "  v1", "Back"]);
    expect(button(history, "* v3").hint).toContain("tools dialog  · current");
    const current = await press(history, "* v3");
    expect(labels(current, "button")).toEqual(["Back"]);
    const older = await press(history, "  v2");
    expect(text(older).join("\n")).toContain("Changes from v1:\n- from v1\n+ to v2");
    expect(text(older).join("\n")).toContain("Compared with the current v3:");
    const switched = await press(older, "Switch to this version");
    expect(log).toEqual(["switch reviewer v2"]);
    expect(text(switched).join("\n")).toContain("Role reviewer is at v2 now.");
  });

  test("duplicates and renames, and refuses a rename while sessions of the role run", async () => {
    const { store, log } = fakeStore(roles());
    const screen = roleScreen(state([]).api, store, "reviewer");
    const copy = await press(await press(screen, "Duplicate"), "Create", { name: "critic" });
    expect(copy.title).toBe("Role: critic");
    const renamed = await press(await press(screen, "Rename"), "Rename", { name: "judge" });
    expect(renamed.title).toBe("Role: judge");
    expect(log).toEqual(["duplicate reviewer critic", "rename reviewer judge"]);

    const busy = roleScreen(state([{ name: "c1", role: "critic" }]).api, store, "critic");
    expect(button(busy, "Rename").run(busy.values ?? {})).rejects.toThrow(
      "Stop its running sessions",
    );
  });

  test("delete lists what uses the role, or asks and then removes it", async () => {
    const { store, log } = fakeStore(roles());
    const { api } = state([{ name: "ex", role: "explore" }]);
    const used = await press(roleScreen(api, store, "explore"), "Delete");
    expect(used.title).toBe("explore is in use");
    expect(text(used).join("\n")).toContain("role reviewer extends it\nrunning session ex");
    expect(labels(used, "button")).toEqual(["Back"]);

    const confirm = await press(roleScreen(api, store, "reviewer"), "Delete");
    expect(confirm.title).toBe("Delete reviewer?");
    const list = await press(confirm, "Yes, delete it");
    expect(log).toEqual(["remove reviewer"]);
    expect(labels(list, "button")).toEqual(["explore", "New role…", "Close"]);
  });
});
