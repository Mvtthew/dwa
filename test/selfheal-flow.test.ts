import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/daemon/db.ts";
import { Selfheal } from "../src/daemon/selfheal.ts";
import { Workspace } from "../src/daemon/workspace.ts";
import { claudeProvider } from "../src/providers/claude/launch.ts";
import type { Capabilities } from "../src/shared/capabilities.ts";
import type { Config } from "../src/shared/config.ts";
import { readHistory } from "../src/shared/history.ts";
import { roleHistory } from "../src/shared/role-edit.ts";
import { SELFHEAL_ROLE } from "../src/shared/selfheal.ts";
import { FakeTmux } from "./fake-tmux.ts";

const config: Config = {
  keys: {},
  agents: [],
  layout: {},
  defaults: {},
  main: {},
  mcp: { github: { command: "github-mcp", args: [], env: {} } },
  plugins: {},
  default_profile: "me",
  profiles: { me: { command: "/bin/claude_me", args: [], env: {} } },
} as unknown as Config;

const DEVELOPER = `# what the developer may do
description = "Writes code"

permission_mode = "dontAsk"
allow = ["Bash(ls *)"] # kept short on purpose

prompt = """
You write code.
"""
`;

describe("self-heal", () => {
  let dir = "";
  let tmux: FakeTmux;
  let store: Store;
  let workspace: Workspace;
  let selfheal: Selfheal;
  let counter = 0;
  let later: (() => void)[] = [];

  const project = () => join(dir, "project");
  const file = (...parts: string[]) => join(project(), ".dwa", "roles", ...parts);
  const builtin = (...parts: string[]) => join(dir, "builtin", "roles", ...parts);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dwa-selfheal-"));
    tmux = new FakeTmux();
    store = new Store(":memory:");
    counter = 0;
    later = [];
    mkdirSync(file(), { recursive: true });
    mkdirSync(builtin(), { recursive: true });
    writeFileSync(file("developer.toml"), DEVELOPER);
    writeFileSync(file("role-author.toml"), 'tools = ["Read"]\n');
    writeFileSync(builtin(`${SELFHEAL_ROLE}.toml`), 'tools = ["Read"]\nin_role_list = false\n');
    writeFileSync(builtin("reviewer.toml"), '# built in\ntools = ["Read", "Grep"]\n');
    const env = { XDG_CONFIG_HOME: join(dir, "home"), DWA_BUILTIN_DIR: join(dir, "builtin") };
    workspace = new Workspace({
      store,
      run: tmux.run,
      provider: claudeProvider,
      projectRoot: project(),
      socketPath: "/tmp/dwa.sock",
      selfArgv: ["bun", "/dwa/cli.ts"],
      runDir: join(project(), ".dwa", "run"),
      writeFile: () => undefined,
      loadConfig: async () => config,
      schedule: () => undefined,
      env,
      newId: () => `id-${++counter}`,
      now: () => 1000 + counter,
    });
    selfheal = new Selfheal({
      store,
      workspace,
      loadConfig: async () => config,
      env,
      schedule: (callback) => void later.push(callback),
      now: () => 5000 + counter,
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Lets what a stopped session set off run to its end. */
  const settled = () => selfheal.resume();
  const toUser = () => store.recentMessages("user", 20).map((message) => message.body);
  const mail = (id: string) => store.pendingMessages(id).map((message) => message.body);
  const healer = (reportId: number) => {
    const report = store.getReport(reportId);
    const found = report ? store.getCase(report.caseId) : null;
    if (!found) throw new Error("no case");
    return found.agentId;
  };
  const gap = async (name = "dev") => {
    const agent = await workspace.spawn({ role: "developer", name });
    const receipt = await selfheal.report({
      from: agent.id,
      what: "git push was refused",
      tried: "git push origin main",
    });
    return { agent, receipt };
  };
  const push = { key: "allow", add: "Bash(git push *)", why: "to publish its work" };

  test("a report starts one selfheal session for the role, and a second report joins it", async () => {
    await workspace.up();
    const { agent, receipt } = await gap("dev-1");
    expect(receipt).toEqual({ id: 1, selfheal: "selfheal-developer", joined: false });
    const healerId = healer(1);
    expect(store.getRunning(healerId)?.role).toBe(SELFHEAL_ROLE);
    // Started by the workspace, not by the reporter: it owes nobody a result and is not narrowed.
    expect(store.handover(healerId)).toBeNull();

    const other = await workspace.spawn({ role: "developer", name: "dev-2" });
    const second = await selfheal.report({ from: other.id, what: "cannot push either" });
    expect(second).toEqual({ id: 2, selfheal: "selfheal-developer", joined: true });
    expect(mail(healerId).join("\n")).toContain("Report #2 from dev-2 joined your case");

    // The same reporter about the same role keeps its first report.
    expect((await selfheal.report({ from: agent.id, what: "again" })).id).toBe(1);
    expect(store.openCases()).toHaveLength(1);
  });

  test("the context holds the report, the setup, the refused calls and the role's file", async () => {
    await workspace.up();
    const agent = await workspace.spawn({ role: "developer", name: "dev" });
    const call = { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "git push" } };
    workspace.hook({ agentId: agent.id, event: "PreToolUse", input: call });
    workspace.hook({ agentId: agent.id, event: "Stop", input: {} });
    const { id } = await selfheal.report({ from: agent.id, what: "git push was refused" });
    const text = await selfheal.context(healer(id));
    expect(text).toContain('# Reports about the role "developer"');
    expect(text).toContain("## Report #1 from dev (carries on meanwhile)");
    expect(text).toContain("What: git push was refused");
    expect(text).toContain("- allow rules: Bash(ls *)");
    expect(text).toContain('- allow = ["Bash(ls *)"]   (from role developer)');
    expect(text).toContain("Bash: git push (no result followed");
    expect(text).toContain("in a change: role:developer");
    expect(text).toContain("# what the developer may do");
    expect(text).toContain("MCP servers in the catalogue (key mcp): github");
  });

  test("only the selfheal session of an open case settles, and it reports no gap itself", async () => {
    await workspace.up();
    const { agent, receipt } = await gap();
    const input = { summary: "let it push", reason: "it publishes", changes: [push] };
    await expect(selfheal.propose(agent.id, input)).rejects.toThrow(
      "Only the dwa-selfheal session",
    );
    await expect(selfheal.propose("user", input)).rejects.toThrow("Only the dwa-selfheal session");
    await expect(selfheal.context(agent.id)).rejects.toThrow("Only the dwa-selfheal session");
    await expect(
      selfheal.report({ from: healer(receipt.id), what: "I lack Bash" }),
    ).rejects.toThrow("does not report gaps");
    const author = await workspace.spawn({ role: "role-author" });
    await expect(selfheal.report({ from: author.id, what: "x" })).rejects.toThrow(
      "does not report gaps",
    );
  });

  test("an approved fix is written in place with a version, and the reporter restarts at turn end", async () => {
    await workspace.up();
    const { agent, receipt } = await gap();
    workspace.hook({ agentId: agent.id, event: "UserPromptSubmit", input: {} });
    const made = await selfheal.propose(healer(receipt.id), {
      summary: "let developers push",
      reason: "the role publishes its work",
      changes: [push],
    });
    expect(made).toEqual({ id: 1, lines: ["allow + Bash(git push *)"] });
    // Nothing is written before the user decides.
    expect(readFileSync(file("developer.toml"), "utf8")).toBe(DEVELOPER);
    expect((await workspace.state()).fixes).toBe(1);

    const view = await selfheal.view(1);
    expect(view.lines).toEqual([
      {
        id: "c1",
        file: "role developer",
        text: "allow + Bash(git push *)",
        why: "to publish its work",
        widens: true,
      },
    ]);
    expect(view.files[0]?.diff).toContain(
      '+ allow = ["Bash(ls *)", "Bash(git push *)"] # kept short on purpose',
    );
    expect(view.sessions).toEqual(["dev"]);
    expect(view.noSessionOnly).toBeUndefined();

    const result = await selfheal.decide({ id: 1, action: "role", base: view.base });
    expect(result.message).toBe("Written: role developer (v2).");
    expect(readFileSync(file("developer.toml"), "utf8")).toBe(
      DEVELOPER.replace('["Bash(ls *)"]', '["Bash(ls *)", "Bash(git push *)"]'),
    );
    expect(
      readHistory(roleHistory("developer", { projectRoot: project() })).versions.at(-1)?.source,
    ).toBe("selfheal, fix #1");
    expect(store.pendingRestart(agent.id)).toBe(true);
    expect((await workspace.state()).fixes).toBeUndefined();

    const status = selfheal.status(receipt.id, agent.id);
    expect(status.state).toBe("applied");
    expect(status.outcome).toContain("allow + Bash(git push *)");
    expect(status.outcome).toContain("end the turn now");
    // The case is over, and its session ends a moment later.
    expect(store.openCases()).toHaveLength(0);
    const healerId = healer(receipt.id);
    for (const run of later) run();
    // The stop goes through the workspace's own queue.
    await workspace.state();
    expect(store.getRunning(healerId)).toBeNull();
  });

  test("a waiting reporter fetches its outcome; one that did not is told by message", async () => {
    await workspace.up();
    const agent = await workspace.spawn({ role: "developer", name: "dev" });
    const { id } = await selfheal.report({ from: agent.id, what: "no push", blocking: true });
    expect(selfheal.status(id, agent.id)).toEqual({ id, state: "open" });
    await selfheal.answer(healer(id), "Use the release script: ls scripts/", [id]);
    // Its tool call is taken to be there still, so no message yet.
    expect(mail(agent.id)).toEqual([]);
    for (const run of later) run();
    expect(mail(agent.id).join("\n")).toContain("Use the release script");

    const other = await workspace.spawn({ role: "developer", name: "dev-2" });
    const next = await selfheal.report({ from: other.id, what: "no push", blocking: true });
    await selfheal.answer(healer(next.id), "Use the release script.");
    later = [];
    expect(selfheal.status(next.id, other.id).outcome).toBe("Use the release script.");
    for (const run of later) run();
    expect(mail(other.id)).toEqual([]);
    expect(() => selfheal.status(next.id, agent.id)).toThrow("You have no report");
  });

  test("a built-in role is copied into the project before it is changed", async () => {
    await workspace.up();
    const agent = await workspace.spawn({ role: "reviewer", name: "rev" });
    const { id } = await selfheal.report({ from: agent.id, what: "needs to run the tests" });
    await selfheal.propose(healer(id), {
      summary: "let reviewers run tests",
      reason: "a review runs the tests",
      changes: [{ key: "tools", add: "Bash" }],
    });
    const view = await selfheal.view(1);
    expect(view.files[0]).toMatchObject({ adopt: true, path: file("reviewer.toml") });
    expect(existsSync(file("reviewer.toml"))).toBe(false);
    await selfheal.decide({ id: 1, action: "role", base: view.base });
    expect(readFileSync(file("reviewer.toml"), "utf8")).toBe(
      '# built in\ntools = ["Read", "Grep", "Bash"]\n',
    );
    expect(readFileSync(builtin("reviewer.toml"), "utf8")).toBe(
      '# built in\ntools = ["Read", "Grep"]\n',
    );
    const sources = readHistory(roleHistory("reviewer", { projectRoot: project() })).versions.map(
      (version) => version.source,
    );
    expect(sources).toEqual(["copy of the built-in role", "selfheal, fix #1"]);
  });

  test("for the reporting session alone no file changes", async () => {
    await workspace.up();
    const { agent, receipt } = await gap();
    await selfheal.propose(healer(receipt.id), {
      summary: "let it push",
      reason: "this one task publishes",
      changes: [push],
    });
    const result = await selfheal.decide({ id: 1, action: "session" });
    expect(result.message).toBe("Given to dev alone; no file was changed.");
    expect(readFileSync(file("developer.toml"), "utf8")).toBe(DEVELOPER);
    expect(JSON.parse(store.getOverrides(agent.id) ?? "{}") as Capabilities).toEqual({
      allow: ["Bash(ls *)", "Bash(git push *)"],
    });
    expect(store.getReport(receipt.id)?.state).toBe("applied");
  });

  test("a change to the prompt cannot be given to one session", async () => {
    await workspace.up();
    const { receipt } = await gap();
    await selfheal.propose(healer(receipt.id), {
      summary: "say it may push",
      reason: "the prompt forbids it",
      changes: [{ key: "prompt", set: "You write code and publish it.\n" }],
    });
    expect((await selfheal.view(1)).noSessionOnly).toContain("only a role file holds");
    await expect(selfheal.decide({ id: 1, action: "session" })).rejects.toThrow(
      "cannot be given to the reporting sessions alone",
    );
  });

  test("a fix that is turned down is remembered for the role until it is cleared", async () => {
    await workspace.up();
    const { agent, receipt } = await gap();
    await selfheal.propose(healer(receipt.id), {
      summary: "let developers push",
      reason: "the role publishes its work",
      changes: [push],
    });
    await selfheal.decide({ id: 1, action: "refuse", reason: "pushing is the leader's job" });
    expect(readFileSync(file("developer.toml"), "utf8")).toBe(DEVELOPER);
    expect(store.getReport(receipt.id)?.outcome).toContain("pushing is the leader's job");
    expect(mail(agent.id).join("\n")).toContain("pushing is the leader's job");
    expect(selfheal.memory("developer")).toMatchObject([
      { role: "developer", summary: "let developers push", reason: "pushing is the leader's job" },
    ]);

    // The next selfheal session for the role is shown it.
    for (const run of later) run();
    await settled();
    const again = await selfheal.report({ from: agent.id, what: "still cannot push" });
    const text = await selfheal.context(healer(again.id));
    expect(text).toContain("# Turned down by the user before, for this role");
    expect(text).toContain(
      "let developers push (allow + Bash(git push *)). The user's reason: pushing is the leader's job",
    );

    expect(selfheal.clearMemory("developer")).toBe(1);
    expect(selfheal.memory()).toEqual([]);
    expect(await selfheal.context(healer(again.id))).not.toContain("Turned down by the user");
  });

  test("a fix is not applied to a file the user did not see", async () => {
    await workspace.up();
    const { receipt } = await gap();
    await selfheal.propose(healer(receipt.id), {
      summary: "let it push",
      reason: "it publishes",
      changes: [push],
    });
    const view = await selfheal.view(1);
    const edited = DEVELOPER.replace("Writes code", "Writes and ships code");
    writeFileSync(file("developer.toml"), edited);
    await expect(selfheal.decide({ id: 1, action: "role", base: view.base })).rejects.toThrow(
      "The files changed since you looked",
    );
    expect(readFileSync(file("developer.toml"), "utf8")).toBe(edited);
    // Looked at again, it fits the file as it is now.
    const fresh = await selfheal.view(1);
    await selfheal.decide({ id: 1, action: "role", base: fresh.base });
    expect(readFileSync(file("developer.toml"), "utf8")).toContain("Writes and ships code");
    expect(readFileSync(file("developer.toml"), "utf8")).toContain("Bash(git push *)");
  });

  test("a proposal a session could not start with is refused when it is made", async () => {
    await workspace.up();
    const { receipt } = await gap();
    const by = healer(receipt.id);
    await expect(
      selfheal.propose(by, {
        summary: "give it jira",
        reason: "it files tickets",
        changes: [{ key: "mcp", add: "jira" }],
      }),
    ).rejects.toThrow("jira");
    await expect(
      selfheal.propose(by, {
        summary: "nothing",
        reason: "it is there already",
        changes: [{ key: "allow", add: "Bash(ls *)" }],
      }),
    ).rejects.toThrow("leave every file as it is");
    expect(store.pendingProposals()).toEqual([]);
  });

  test("a reporter that ends closes its report; the selfheal session ending cancels the rest", async () => {
    await workspace.up();
    const { agent, receipt } = await gap("dev-1");
    const other = await workspace.spawn({ role: "developer", name: "dev-2" });
    const second = await selfheal.report({ from: other.id, what: "cannot push either" });
    const healerId = healer(receipt.id);

    await workspace.stop(agent.id);
    await settled();
    expect(store.getReport(receipt.id)?.state).toBe("cancelled");
    expect(store.openCases()).toHaveLength(1);
    expect(mail(healerId).join("\n")).toContain("dev-1 ended; its report is closed");

    await workspace.stop(healerId);
    await settled();
    expect(store.getReport(second.id)?.state).toBe("cancelled");
    expect(store.openCases()).toHaveLength(0);
    expect(mail(other.id).join("\n")).toContain("Report it again if you still need it");
  });

  test("the main session hears the outcome for an agent it started, once", async () => {
    const state = await workspace.up();
    const main = state.main?.id ?? "";
    const agent = await workspace.spawn({
      role: "developer",
      name: "dev",
      task: "ship it",
      from: main,
    });
    const { id } = await selfheal.report({ from: agent.id, what: "git push was refused" });
    // Nothing when the report is made.
    expect(mail(main)).toEqual([]);
    await selfheal.answer(healer(id), "Pushing is not this role's work.");
    const heard = mail(main).filter((body) => body.includes("reported a gap"));
    expect(heard).toHaveLength(1);
    expect(heard[0]).toContain(
      "dev reported a gap in its setup (git push was refused). Outcome: answered.",
    );
  });

  test("the user reports on a role nobody runs", async () => {
    await workspace.up();
    await expect(selfheal.report({ from: "user", target: "nobody", what: "x" })).rejects.toThrow(
      'no role called "nobody"',
    );
    const receipt = await selfheal.report({
      from: "user",
      target: "developer",
      what: "developers should be able to push",
      blocking: true,
    });
    expect(store.getReport(receipt.id)).toMatchObject({
      reporterId: "user",
      subjectId: null,
      blocking: false,
      evidence: null,
    });
    await selfheal.propose(healer(receipt.id), {
      summary: "let developers push",
      reason: "asked for by the user",
      changes: [push],
    });
    const view = await selfheal.view(1);
    expect(view.sessions).toEqual([]);
    expect(view.noSessionOnly).toBe("no session it was reported for is running");
    await selfheal.decide({ id: 1, action: "role", base: view.base });
    expect(readFileSync(file("developer.toml"), "utf8")).toContain("Bash(git push *)");
    expect(toUser().join("\n")).toContain("The user approved the fix (allow + Bash(git push *))");
  });

  test("a defect in dwa becomes a file in a folder git does not see", async () => {
    await workspace.up();
    const { agent, receipt } = await gap();
    const { path } = await selfheal.fileBug(healer(receipt.id), {
      title: "An allowed command is refused",
      what: "The role allows it and it is still refused.",
      steps: "1. Start a developer.\n2. Run ls.",
    });
    expect(path).toStartWith(join(project(), ".dwa", "reports"));
    expect(path).toEndWith("-an-allowed-command-is-refused.md");
    expect(readFileSync(path, "utf8")).toContain("- dev (role developer): git push was refused");
    expect(readFileSync(join(project(), ".dwa", "reports", ".gitignore"), "utf8")).toBe("*\n");
    expect(store.getReport(receipt.id)?.state).toBe("bug");
    expect(mail(agent.id).join("\n")).toContain("defect in dwa itself");
    expect(toUser().join("\n")).toContain(path);
    expect(store.openCases()).toHaveLength(0);
  });
});

describe("the record of refused calls", () => {
  test("a call without a result is recorded when the turn ends; one with a result is not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dwa-refusals-"));
    try {
      const store = new Store(":memory:");
      let counter = 0;
      const workspace = new Workspace({
        store,
        run: new FakeTmux().run,
        provider: claudeProvider,
        projectRoot: join(dir, "project"),
        socketPath: "/tmp/dwa.sock",
        selfArgv: ["bun", "/dwa/cli.ts"],
        runDir: join(dir, "project", ".dwa", "run"),
        writeFile: () => undefined,
        loadConfig: async () => config,
        schedule: () => undefined,
        env: { XDG_CONFIG_HOME: join(dir, "home"), DWA_BUILTIN_DIR: "" },
        newId: () => `id-${++counter}`,
        now: () => 1000 + counter,
      });
      const main = (await workspace.up()).main?.id ?? "";
      const hook = (event: string, input: Record<string, unknown>, refused?: string) =>
        workspace.hook({ agentId: main, event, input, refused });
      const call = (id: string, command: string) => ({
        tool_name: "Bash",
        tool_use_id: id,
        tool_input: { command },
      });
      hook("PreToolUse", call("a", "ls"));
      hook("PostToolUse", call("a", "ls"));
      hook("PreToolUse", call("b", "touch x"));
      hook("PreToolUse", call("c", "false"));
      hook("PostToolUseFailure", call("c", "false"));
      expect(store.refusals(main)).toEqual([]);
      hook("Stop", {});
      // What the hook refused itself is recorded as that, at once.
      hook(
        "PreToolUse",
        { tool_name: "Skill", tool_use_id: "d", tool_input: { skill: "deploy" } },
        "The skill is not one this session was given",
      );
      hook("Stop", {});
      expect(
        store.refusals(main).map(({ source, tool, detail }) => ({ source, tool, detail })),
      ).toEqual([
        { source: "not-run", tool: "Bash", detail: "touch x" },
        { source: "skill", tool: "Skill", detail: "deploy" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
