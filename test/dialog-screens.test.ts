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
import type { RoleChanges, RoleFields, RoleRef } from "../src/shared/role-edit.ts";
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

/**
 * Roles by name; `personal` names the ones kept in the personal folder, `hidden` the personal
 * ones the project has a role of the same name for (those are kept as "personal:<name>").
 */
function fakeStore(
  roles: Record<string, RoleFields>,
  places: { personal?: string[]; hidden?: string[]; warnings?: string[] } = {},
) {
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
  const personal = new Set(places.personal ?? []);
  /** The key a role is kept under here: its name, or "personal:<name>" for a hidden one. */
  const id = (role: RoleRef): string => {
    if (typeof role === "string") return role;
    return role.source === "user" && places.hidden?.includes(role.name)
      ? `personal:${role.name}`
      : role.name;
  };
  const store: RoleStore = {
    builtins: () => [],
    adopt: () => undefined,
    list: () =>
      Object.entries(roles).map(([key, role]) => {
        const hidden = key.startsWith("personal:");
        const name = hidden ? key.slice("personal:".length) : key;
        return {
          name,
          source: hidden || personal.has(name) ? ("user" as const) : ("project" as const),
          hidden,
          description: role.description ?? null,
          error: null,
        };
      }),
    load: (role) => roles[id(role)] ?? {},
    save: (role, changes) => {
      saves.push({ name: id(role), changes });
      return 7;
    },
    create: (name, description, where) => {
      roles[name] = { description };
      if (where === "user") personal.add(name);
      log.push(`create ${name}${where === "user" ? " personal" : ""}`);
    },
    duplicate: (from, to, where) => {
      roles[to] = { ...roles[id(from)] };
      if (where === "user") personal.add(to);
      log.push(`duplicate ${id(from)} ${to}${where === "user" ? " personal" : ""}`);
    },
    rename: (from, to) => {
      roles[to] = roles[id(from)] ?? {};
      delete roles[id(from)];
      log.push(`rename ${id(from)} ${to}`);
    },
    move: (role, to) => {
      if (to === "user") personal.add(id(role));
      else personal.delete(id(role));
      log.push(`move ${id(role)} ${to}`);
    },
    remove: (role) => {
      delete roles[id(role)];
      log.push(`remove ${id(role)}`);
    },
    users: (role) => (id(role) === "explore" ? ["role reviewer extends it"] : []),
    warnings: (action) => (places.warnings ?? []).map((warning) => `${action}: ${warning}`),
    history: () => history,
    diff: (_role, from, to) => [`- from v${from}`, `+ to v${to}`],
    switchTo: (role, n) => {
      log.push(`switch ${id(role)} v${n}`);
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
    expect(button(list, "explore").hint).toBe("project · Reads");
    const form = await press(list, "New role");
    expect(() => button(form, "Create").run({ name: " " })).toThrow("Type a name");
    const created = await press(form, "Create", { name: "tester", description: "Tests" });
    expect(log).toEqual(["create tester"]);
    expect(created.title).toBe("Role: tester (project)");
  });

  test("describing a role to an agent needs a name, which is taken along from the form", async () => {
    const { store, log } = fakeStore(roles());
    const { api, calls } = fakeApi({ "/roles/author": () => ({}) });
    const form = await press(rolesScreen(api, store), "New role");
    expect(labels(form, "button")).toEqual(["Create", "Describe it to an agent…", "Back"]);
    const screen = await press(form, "Describe it to an agent…", { name: " docs ", where: "user" });
    expect(screen.title).toBe("Describe the role");
    expect(screen.values).toEqual({ name: "docs", where: "user" });
    const start = (values: Values) => button(screen, "Start the agent").run(values);
    await expect(start({ text: " ", name: "docs" })).rejects.toThrow(
      "Say what the role is for first.",
    );
    await expect(start({ text: "writes docs", name: " " })).rejects.toThrow("Type a name first.");
    await expect(start({ text: "writes docs", name: "explore" })).rejects.toThrow(
      'There is already a role "explore".',
    );
    expect(calls).toEqual([]);
    expect(await start({ text: " writes docs ", name: "docs", where: "user" })).toEqual({
      close: true,
    });
    expect(calls).toEqual([
      { path: "/roles/author", body: { description: "writes docs", name: "docs", personal: true } },
    ]);
    // The agent makes the file, not this screen.
    expect(log).toEqual([]);
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

  test("saving the form keeps when_to_use, and the two role-list choices are saved", async () => {
    const { store, saves } = fakeStore({
      lead: { description: "Leads", when_to_use: "Never.\n", in_role_list: false },
    });
    const screen = roleScreen(state([]).api, store, "lead");
    expect(screen.values).toMatchObject({ in_role_list: OFF, role_list: "" });
    await press(screen, "Save", { role_list: ON });
    // Nothing about when_to_use: it is not in the form, and must not be removed for that.
    expect(saves[0]?.changes).toEqual({ role_list: true });

    await press(screen, "Save", { in_role_list: ON });
    expect(saves[1]?.changes).toEqual({ in_role_list: null });
    expect(await button(screen, "Edit when to use").run(screen.values ?? {})).toEqual({
      exec: ["role", "edit-when-to-use", "project:lead"],
    });
  });

  test("the prompt opens in the editor only when the form is saved", async () => {
    const { store } = fakeStore(roles());
    const screen = roleScreen(state([]).api, store, "reviewer");
    expect(await button(screen, "Edit the prompt").run(screen.values ?? {})).toEqual({
      exec: ["role", "edit-prompt", "project:reviewer"],
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
    expect(copy.title).toBe("Role: critic (project)");
    const renamed = await press(await press(screen, "Rename"), "Rename", { name: "judge" });
    expect(renamed.title).toBe("Role: judge (project)");
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

  /** The two project roles, a personal one, and a personal `explore` the project's hides. */
  const twoPlaces = (warnings?: string[]) =>
    fakeStore(
      {
        ...roles(),
        mine: { description: "Mine", model: "haiku" },
        "personal:explore": { description: "My explore", effort: "low" },
      },
      { personal: ["mine"], hidden: ["explore"], warnings },
    );
  const buttons = (screen: Screen) =>
    screen.rows.filter((row): row is Button => row.kind === "button");
  /** Opens the personal `explore` from the list, where it is the second of that name. */
  async function openHidden(api: WizardApi, store: RoleStore): Promise<Screen> {
    const row = buttons(rolesScreen(api, store)).filter((entry) => entry.label === "explore")[1];
    if (!row) throw new Error("no hidden explore in the list");
    const outcome = await row.run({});
    if (!("to" in outcome)) throw new Error("the list did not open the role");
    return outcome.to;
  }

  test("the list says where each role is kept and which personal one is hidden", () => {
    const { store } = twoPlaces();
    const list = rolesScreen(state([]).api, store);
    expect(buttons(list).map((row) => [row.label, row.hint])).toEqual([
      ["explore", "project · Reads"],
      ["reviewer", "project · Reviews"],
      ["mine", "personal · Mine"],
      ["explore", "personal · hidden by the project's role · My explore"],
      ["New role…", undefined],
      ["Close", undefined],
    ]);
    // Without a description the place stands alone.
    const bare = fakeStore({ a: {}, b: {} }, { personal: ["b"] });
    const hints = buttons(rolesScreen(state([]).api, bare.store)).map((row) => row.hint);
    expect(hints.slice(0, 2)).toEqual(["project", "personal"]);
  });

  test("a new role is created in the place chosen on the form", async () => {
    const { store, log } = twoPlaces();
    const { api } = state([]);
    const form = await press(rolesScreen(api, store), "New role");
    const where = form.rows.find((row) => row.kind === "choice" && row.key === "where");
    expect(where).toMatchObject({
      label: "Where the role is kept",
      options: [
        { value: "project", label: "in the project" },
        { value: "user", label: "personal, for every project" },
      ],
    });
    const created = await press(form, "Create", {
      name: "tester",
      description: "Tests",
      where: "user",
    });
    expect(created.title).toBe("Role: tester (personal)");
    const inProject = await press(form, "Create", { name: "builder", where: "project" });
    expect(inProject.title).toBe("Role: builder (project)");
    expect(log).toEqual(["create tester personal", "create builder"]);
  });

  test("a personal role says so in its title, by name or by place", () => {
    const { store } = twoPlaces();
    const { api } = state([]);
    expect(roleScreen(api, store, "mine").title).toBe("Role: mine (personal)");
    expect(roleScreen(api, store, { name: "mine", source: "user" }).title).toBe(
      "Role: mine (personal)",
    );
    // A bare name is the role that is used, so the project's when both places have it.
    const used = roleScreen(api, store, "explore");
    expect(used.title).toBe("Role: explore (project)");
    expect(used.values).toMatchObject({ description: "Reads" });
  });

  test("opening a hidden role loads the personal file and works on that one", async () => {
    const { store, saves, log } = twoPlaces();
    // A session of the project's explore is running; it is not a session of the hidden role.
    const { api } = state([{ name: "ex", role: "explore" }]);
    const screen = await openHidden(api, store);
    expect(screen.title).toBe("Role: explore (personal)");
    expect(screen.values).toMatchObject({
      description: "My explore",
      effort: "low",
      model: "",
      toolsMode: "",
    });
    expect(await button(screen, "Edit the prompt").run(screen.values ?? {})).toEqual({
      exec: ["role", "edit-prompt", "personal:explore"],
    });
    const done = await press(screen, "Save", { effort: "high" });
    expect(saves).toEqual([{ name: "personal:explore", changes: { effort: "high" } }]);
    expect(text(done).join("\n")).toContain("Sessions started from now on use it.");
    expect(labels(done, "button")).not.toContain("Bring them up to date");

    const rename = await press(screen, "Rename");
    expect(text(rename).join("\n")).toContain(
      "Only this file is renamed: what names the role here means the project's.",
    );
    // Nothing names a hidden role, so it is deleted without the "in use" screen.
    const confirm = await press(screen, "Delete");
    expect(confirm.title).toBe("Delete explore?");
    await press(confirm, "Yes, delete it");
    expect(log).toEqual(["remove personal:explore"]);
    expect(store.list().map((role) => [role.name, role.source])).toContainEqual([
      "explore",
      "project",
    ]);
  });

  test("a copy starts in the place of the original and can be made in the other", async () => {
    const { store, log } = twoPlaces();
    const { api } = state([]);
    const form = await press(roleScreen(api, store, "mine"), "Duplicate");
    expect(form.values).toEqual({ where: "user" });
    const copy = await press(form, "Create", { name: "mine2" });
    expect(copy.title).toBe("Role: mine2 (personal)");
    const other = await press(
      await press(roleScreen(api, store, "reviewer"), "Duplicate"),
      "Create",
      {
        name: "critic",
        where: "user",
      },
    );
    expect(other.title).toBe("Role: critic (personal)");
    expect(log).toEqual(["duplicate mine mine2 personal", "duplicate reviewer critic personal"]);
  });

  test("the move button names the other place, and confirming moves the role", async () => {
    const { store, log } = twoPlaces();
    const { api } = state([]);
    const project = roleScreen(api, store, "reviewer");
    expect(labels(project, "button")).toContain("Move to your personal folder…");
    expect(labels(project, "button")).not.toContain("Move into the project…");
    expect(() =>
      button(project, "Move to your personal folder").run({ ...project.values, description: "x" }),
    ).toThrow("Save or undo");
    const toPersonal = await press(project, "Move to your personal folder");
    expect(toPersonal.title).toBe("Move reviewer");
    expect(text(toPersonal).join("\n")).toBe(
      "The file goes to your personal dwa folder and leaves the project.\n" +
        "Its history moves with it, and the name stays.",
    );
    expect(labels(toPersonal, "button")).toEqual(["Move it to my personal folder", "Back"]);
    expect(log).toEqual([]);
    const moved = await press(toPersonal, "Move it to my personal folder");
    expect(log).toEqual(["move reviewer user"]);
    expect(moved.title).toBe("Role: reviewer (personal)");

    const personal = roleScreen(api, store, { name: "mine", source: "user" });
    expect(labels(personal, "button")).toContain("Move into the project…");
    expect(labels(personal, "button")).not.toContain("Move to your personal folder…");
    const toProject = await press(personal, "Move into the project");
    expect(text(toProject).join("\n")).toContain(
      "The file goes into the project, for everyone who uses it.",
    );
    expect(labels(toProject, "button")).toEqual(["Move it into the project", "Back"]);
    const back = await press(toProject, "Move it into the project");
    expect(log).toEqual(["move reviewer user", "move mine project"]);
    expect(back.title).toBe("Role: mine (project)");
  });

  test("warnings are shown before a rename, a delete and a move, and after a save", async () => {
    const { store, log } = twoPlaces(["other projects are not checked", "second line"]);
    const { api } = state([]);
    const screen = roleScreen(api, store, "reviewer");
    const lines = (found: Screen) => text(found).join("\n");

    const rename = await press(screen, "Rename");
    expect(lines(rename)).toBe(
      "Roles that extend it, the config and the workflows are changed to the new name.\n" +
        "rename: other projects are not checked\nrename: second line",
    );
    const move = await press(screen, "Move to your personal folder");
    expect(lines(move)).toContain(
      "Its history moves with it, and the name stays.\n" +
        "move: other projects are not checked\nmove: second line",
    );
    const remove = await press(screen, "Delete");
    expect(lines(remove)).toBe(
      "The file is removed. Its versions stay in the history folder.\n" +
        "delete: other projects are not checked\ndelete: second line",
    );
    // Reading the warnings changed nothing.
    expect(log).toEqual([]);
    const saved = await press(screen, "Save", { description: "Reviews carefully" });
    expect(saved.title).toBe("Saved");
    expect(lines(saved)).toBe(
      "Role reviewer is at v7.\nSessions started from now on use it.\n" +
        "save: other projects are not checked\nsave: second line",
    );

    // Without warnings the notes are what they were.
    const quiet = twoPlaces();
    const plain = await press(roleScreen(api, quiet.store, "reviewer"), "Delete");
    expect(lines(plain)).toBe("The file is removed. Its versions stay in the history folder.");
  });
});
