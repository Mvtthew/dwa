import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type Api, ApiError, createMcpServer, type McpOptions } from "../src/mcp/server.ts";
import { sessionPrompt } from "../src/providers/claude/prompt.ts";
import type { FixView, WorkspaceState } from "../src/shared/protocol.ts";
import type { ResolvedSession } from "../src/shared/roles.ts";
import { skillRefusal } from "../src/shared/tools.ts";
import { changeRows, fixesScreen, fixScreen } from "../src/ui/fix-screens.ts";
import { topbarModel } from "../src/ui/model.ts";
import type { Row, Screen } from "../src/ui/wizard.ts";
import type { WizardApi } from "../src/ui/wizards.ts";

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

async function connect(
  options: McpOptions,
  routes: Record<string, (body: Record<string, unknown>) => unknown>,
) {
  const calls: Call[] = [];
  const api: Api = async <T>(method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body: (body ?? {}) as Record<string, unknown> });
    const handler = routes[`${method} ${path}`];
    if (!handler) throw new ApiError(`no route ${method} ${path}`);
    return handler((body ?? {}) as Record<string, unknown>) as T;
  };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer("agent-1", api, options).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  const use = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const [first] = result.content as { type: string; text: string }[];
    return first?.text ?? "";
  };
  return { calls, names, use };
}

const SELFHEAL_TOOLS = ["selfheal_context", "propose_fix", "answer_report", "file_bug"];

describe("the self-heal tools", () => {
  test("every session reports gaps; only the selfheal session settles them", async () => {
    const ordinary = await connect({}, {});
    expect(ordinary.names).toContain("report_gap");
    for (const name of SELFHEAL_TOOLS) expect(ordinary.names).not.toContain(name);

    const healer = await connect({ selfheal: true, noReport: true }, {});
    expect(healer.names).not.toContain("report_gap");
    for (const name of SELFHEAL_TOOLS) expect(healer.names).toContain(name);

    // The two authors get neither.
    const author = await connect({ noReport: true }, {});
    expect(author.names).not.toContain("report_gap");
    expect(author.names).not.toContain("propose_fix");
  });

  test("a report that does not wait returns at once", async () => {
    const { calls, use } = await connect(
      {},
      {
        "POST /selfheal/reports": () => ({ id: 7, selfheal: "selfheal-developer", joined: false }),
      },
    );
    const text = await use("report_gap", { what: "git push was refused", tried: "twice" });
    expect(text).toContain("Report #7 is with selfheal-developer. Carry on");
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/selfheal/reports",
        body: { from: "agent-1", what: "git push was refused", tried: "twice" },
      },
    ]);
  });

  test("a report that waits returns the outcome", async () => {
    const { calls, use } = await connect(
      {},
      {
        "POST /selfheal/reports": () => ({ id: 7, selfheal: "selfheal-developer", joined: false }),
        "POST /selfheal/status": () => ({ id: 7, state: "applied", outcome: "The user approved." }),
      },
    );
    expect(await use("report_gap", { what: "no push", blocking: true })).toBe(
      "Report #7: The user approved.",
    );
    expect(calls[1]?.body).toEqual({ id: 7, from: "agent-1", waiting: true });
  });

  test("a waiting reporter is handed the question the selfheal session asked it", async () => {
    const question = { id: 3, question: "Which remote?", options: ["origin", "fork"] };
    const { calls, use } = await connect(
      {},
      { "POST /selfheal/status": () => ({ id: 7, state: "open", question }) },
    );
    const text = await use("report_gap", { report_id: 7, blocking: true });
    expect(text).toContain("Question #3: Which remote?");
    expect(text).toContain("Suggested answers: origin | fork");
    expect(text).toContain("call report_gap again with report_id 7");
    // No second report was made.
    expect(calls.map((call) => call.path)).toEqual(["/selfheal/status"]);
  });

  test("a proposal goes to the daemon as the caller, with its changes as given", async () => {
    const { calls, use } = await connect(
      { selfheal: true, noReport: true },
      { "POST /selfheal/propose": () => ({ id: 2, lines: ["allow + Bash(git push *)"] }) },
    );
    const changes = [{ key: "allow", add: "Bash(git push *)", why: "to publish" }];
    const text = await use("propose_fix", {
      summary: "let it push",
      reason: "it publishes",
      changes,
    });
    expect(text).toContain("Fix #2 waits for the user's decision:\n- allow + Bash(git push *)");
    expect(calls[0]?.body).toEqual({
      from: "agent-1",
      summary: "let it push",
      reason: "it publishes",
      changes,
    });
  });
});

describe("what a session is told about reporting", () => {
  const session = (role?: string) =>
    ({ role, denyTools: ["Agent"], deny: [], allow: [] }) as unknown as ResolvedSession;

  test("every session's prompt names the tool, except the roles that do not report", () => {
    expect(sessionPrompt("dev", session("developer"))).toContain("- report_gap: when your role");
    expect(sessionPrompt("x", session())).toContain("- report_gap:");
    for (const role of ["dwa-selfheal", "role-author", "workflow-author"]) {
      expect(sessionPrompt("x", session(role))).not.toContain("report_gap");
    }
  });

  test("a refused skill points at the tool", () => {
    expect(skillRefusal("deploy", ["review"])).toEndWith(
      "Do the work without the skill, or report that you need it with the dwa tool report_gap.",
    );
  });
});

describe("the screens of proposed fixes", () => {
  const view: FixView = {
    id: 4,
    role: "developer",
    summary: "let developers push",
    reporters: ["dev"],
    createdAt: 0,
    reason: "the role publishes its work",
    reports: [{ id: 1, reporter: "dev", what: "git push was refused", gone: false }],
    lines: [
      {
        id: "c1",
        file: "role developer",
        text: "allow + Bash(git push *)",
        widens: true,
        on: true,
      },
      {
        id: "c2",
        file: "role developer",
        text: 'permission_mode = "bypassPermissions"',
        widens: true,
        warning: "the session runs everything without asking and without rules",
        on: true,
      },
      { id: "c3", file: "role developer", text: 'model = "opus"', widens: false, on: true },
    ],
    files: [
      {
        label: "role developer",
        path: "/p/.dwa/roles/developer.toml",
        adopt: false,
        before: "a",
        after: "b",
        diff: ["- a", "+ b"],
      },
    ],
    base: "abc",
    sessions: ["dev"],
    main: false,
  };

  function api(shown: FixView, sent: unknown[] = []): WizardApi {
    return {
      roles: ["developer"],
      profiles: [],
      call: async <T>(method: string, path: string, body?: unknown) => {
        if (path.startsWith("/selfheal/proposal?")) return shown as T;
        if (path === "/selfheal/proposals") return { proposals: [shown] } as T;
        if (path === "/selfheal/memory") return { memory: [] } as T;
        if (method === "POST" && path === "/selfheal/decide") {
          sent.push(body);
          return { message: "Written: role developer (v2).", behind: [] } as T;
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
    };
  }
  const labels = (screen: Screen) =>
    screen.rows.flatMap((row) => (row.kind === "button" ? [row.label] : []));
  const button = (screen: Screen, label: string) => {
    const row = screen.rows.find((entry) => entry.kind === "button" && entry.label === label);
    if (row?.kind !== "button") throw new Error(`no button ${label}`);
    return row;
  };

  test("a widening change is marked and a far-reaching one warned of", () => {
    const rows = changeRows(view);
    const switches = rows.filter(
      (row): row is Extract<Row, { kind: "check" }> => row.kind === "check",
    );
    expect(switches.map((row) => [row.key, row.label])).toEqual([
      ["c1", "▲ role developer: allow + Bash(git push *)"],
      ["c2", '▲ role developer: permission_mode = "bypassPermissions"'],
      ["c3", 'role developer: model = "opus"'],
    ]);
    const notes = rows.filter((row): row is Extract<Row, { kind: "note" }> => row.kind === "note");
    expect(notes[0]).toMatchObject({ tone: "bad" });
    expect(notes[0]?.text).toContain("far-reaching: the session runs everything without asking");
    expect(notes.map((note) => note.text)).toContain("- a\n+ b");
  });

  test("a switch redraws the fix without that change, and the decision leaves it out", async () => {
    const asked: string[] = [];
    const sent: unknown[] = [];
    const calls: WizardApi = {
      ...api(view, sent),
      call: async <T>(method: string, path: string, body?: unknown) => {
        if (path.startsWith("/selfheal/proposal?")) {
          asked.push(path);
          const off = path.includes("drop=c2");
          return {
            ...view,
            base: off ? "without-c2" : "abc",
            lines: view.lines.map((line) => ({ ...line, on: !(off && line.id === "c2") })),
          } as T;
        }
        return api(view, sent).call<T>(method as "GET" | "POST", path, body);
      },
    };
    const screen = await fixScreen(calls, 4);
    expect(screen.values).toMatchObject({ c1: "on", c2: "on", c3: "on" });
    const row = screen.rows.find((entry) => entry.kind === "check" && entry.key === "c2");
    if (row?.kind !== "check" || !row.changed) throw new Error("no switch for c2");
    const outcome = await row.changed({ c1: "on", c2: "off", c3: "on" });
    if (!("replace" in outcome)) throw new Error("the screen is not redrawn");
    expect(asked.at(-1)).toBe("/selfheal/proposal?id=4&drop=c2");
    expect(outcome.replace.values).toMatchObject({ c2: "off" });
    expect(labels(outcome.replace)).toContain("Apply to the role, without the 1 switched off");
    await button(outcome.replace, "Apply to the role, without the 1 switched off").run({
      c1: "on",
      c2: "off",
      c3: "on",
      restart: "turn-end",
    });
    expect(sent).toEqual([
      { action: "role", restart: "turn-end", dropped: ["c2"], id: 4, base: "without-c2" },
    ]);
  });

  test("the list leads to a fix, which can be applied, given to the session or turned down", async () => {
    const list = await fixesScreen(api(view));
    expect(labels(list)[0]).toBe("#4  role developer: let developers push");
    const sent: unknown[] = [];
    const screen = await fixScreen(api(view, sent), 4);
    expect(screen.title).toBe("Fix #4 for role developer");
    expect(labels(screen)).toEqual([
      "Whole file before",
      "Whole file after",
      "Apply to the role",
      "Only for dev",
      "Turn down…",
      "Back",
    ]);
    await button(screen, "Apply to the role").run({ restart: "turn-end" });
    await button(screen, "Only for dev").run({ restart: "turn-end" });
    expect(sent).toEqual([
      { action: "role", restart: "turn-end", dropped: [], id: 4, base: "abc" },
      { action: "session", restart: "turn-end", dropped: [], id: 4, base: "abc" },
    ]);
  });

  test("for the main session the restart is the user's choice", async () => {
    const sent: unknown[] = [];
    const screen = await fixScreen(api({ ...view, main: true, sessions: ["main"] }, sent), 4);
    const choice = screen.rows.find((row) => row.kind === "choice");
    expect(choice).toMatchObject({ key: "restart", label: "Main session" });
    await button(screen, "Apply to the role").run({ restart: "later" });
    expect(sent).toEqual([{ action: "role", restart: "later", dropped: [], id: 4, base: "abc" }]);
  });

  test("a fix that no longer fits can only be turned down; one for no session has no session button", async () => {
    const stale = await fixScreen(api({ ...view, files: [], error: "Unknown MCP server" }), 4);
    expect(labels(stale)).toEqual(["Turn down…", "Back"]);
    const role = await fixScreen(
      api({ ...view, sessions: [], noSessionOnly: "no session it was reported for is running" }),
      4,
    );
    expect(labels(role).slice(-3)).toEqual(["Apply to the role", "Turn down…", "Back"]);
    const empty = await fixScreen(api({ ...view, files: [], empty: true }), 4);
    expect(labels(empty)).toEqual(["Turn down…", "Back"]);
  });

  test("the top bar counts the fixes that wait", () => {
    const state = {
      questions: [],
      inbox: [],
      agents: [],
      main: null,
      shell: null,
      feed: null,
      fixes: 2,
    } as unknown as WorkspaceState;
    const segment = topbarModel(state, 120).find((part) => part.text.trim() === "✚ 2");
    expect(segment).toMatchObject({ tone: "attention", action: { popup: "fixes" } });
    expect(
      topbarModel({ ...state, fixes: undefined }, 120).some((part) => part.text.includes("✚")),
    ).toBe(false);
  });
});
