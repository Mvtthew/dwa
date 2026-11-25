import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/daemon/db.ts";
import { AUTHOR_ROLE, Workflows } from "../src/daemon/workflows.ts";
import { Workspace } from "../src/daemon/workspace.ts";
import { claudeProvider } from "../src/providers/claude/launch.ts";
import type { Config } from "../src/shared/config.ts";
import { readHistory } from "../src/shared/history.ts";
import { workflowHistory } from "../src/shared/workflow-edit.ts";
import { FakeTmux } from "./fake-tmux.ts";
import { testRoleFiles } from "./role-files.ts";

const config: Config = {
  keys: {},
  agents: [],
  layout: {},
  defaults: {},
  main: {},
  mcp: {},
  plugins: {},
  default_profile: "me",
  profiles: { me: { command: "/bin/claude_me", args: [], env: {} } },
};

const TEXT = `# why this exists
description = "Build and check"

[steps.build]
role = "developer"
prompt = "Build {{input}}"

[steps.check]
role = "reviewer"
depends_on = ["build"]
prompt = "Check {{steps.build.result}}"
`;

describe("a workflow written by an agent", () => {
  let dir = "";
  let tmux: FakeTmux;
  let store: Store;
  let workspace: Workspace;
  let workflows: Workflows;
  let absentRoles: string[] = [];
  let counter = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dwa-workflow-save-"));
    tmux = new FakeTmux();
    store = new Store(":memory:");
    absentRoles = [];
    counter = 0;
    const env = { XDG_CONFIG_HOME: join(dir, "home") };
    workspace = new Workspace({
      store,
      run: tmux.run,
      provider: claudeProvider,
      projectRoot: join(dir, "project"),
      socketPath: "/tmp/dwa.sock",
      selfArgv: ["bun", "/dwa/cli.ts"],
      runDir: join(dir, "project", ".dwa", "run"),
      writeFile: () => undefined,
      loadConfig: async () => config,
      roleFiles: {
        ...testRoleFiles(),
        read: (path) => (absentRoles.some((role) => path.endsWith(`/${role}.toml`)) ? null : ""),
      },
      schedule: () => undefined,
      env,
      newId: () => `id-${++counter}`,
      now: () => 1000 + counter,
    });
    workflows = new Workflows({ store, workspace, projectRoot: join(dir, "project"), env });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const file = (...parts: string[]) => join(dir, "project", ".dwa", "workflows", ...parts);
  const messages = () => store.recentMessages("user", 10).map((message) => message.body);
  const popups = () => tmux.commands("display-popup").map((command) => command.join(" "));

  test("a new workflow is written as given, told to the user and shown in the designer", async () => {
    await workspace.up();
    const author = await workspace.spawn({ name: "writer" });
    const saved = workflows.saveFile("check-it", TEXT, author.id);
    expect(saved).toMatchObject({ name: "check-it", version: 1, created: true });
    expect(saved.steps).toEqual(["build", "check"]);
    expect(readFileSync(file("check-it.toml"), "utf8")).toBe(TEXT);
    expect(messages()[0]).toContain(
      'Agent "writer" wrote a new workflow "check-it": build → check',
    );
    await Bun.sleep(0);
    expect(popups().at(-1)).toContain("wizard design 'project:check-it'");
  });

  test("saving it again makes a version by that agent and opens no second popup", async () => {
    await workspace.up();
    const author = await workspace.spawn({ name: "writer" });
    workflows.saveFile("check-it", TEXT, author.id);
    await Bun.sleep(0);
    const before = popups().length;
    const next = TEXT.replace("Build {{input}}", "Build {{input}} with tests");
    const saved = workflows.saveFile("check-it", next, author.id);
    expect(saved).toMatchObject({ version: 2, created: false });
    expect(readFileSync(file("check-it.toml"), "utf8")).toBe(next);
    const history = readHistory(
      workflowHistory(
        { name: "check-it", source: "project" },
        { projectRoot: join(dir, "project") },
      ),
    );
    expect(history.versions.map((version) => version.source)).toEqual([
      "agent writer",
      "agent writer",
    ]);
    expect(messages()[0]).toContain('changed workflow "check-it" (now v2)');
    await Bun.sleep(0);
    expect(popups()).toHaveLength(before);
  });

  test("a text that is wrong, or names a role nobody has, writes nothing", async () => {
    await workspace.up();
    const author = await workspace.spawn({ name: "writer" });
    expect(() => workflows.saveFile("bad", "[steps.a]\nprompt = 1\n", author.id)).toThrow();
    expect(() => workflows.saveFile("no good name", TEXT, author.id)).toThrow();
    absentRoles = ["reviewer"];
    expect(() => workflows.saveFile("check-it", TEXT, author.id)).toThrow(
      "There is no role reviewer",
    );
    expect(existsSync(file("bad.toml"))).toBe(false);
    expect(existsSync(file("check-it.toml"))).toBe(false);
    expect(messages()).toEqual([]);
  });

  test("a personal workflow goes to the personal folder", async () => {
    await workspace.up();
    const author = await workspace.spawn({ name: "writer" });
    const saved = workflows.saveFile("mine", TEXT, author.id, true);
    expect(saved.path).toBe(join(dir, "home", "dwa", "workflows", "mine.toml"));
    expect(existsSync(file("mine.toml"))).toBe(false);
    await Bun.sleep(0);
    expect(popups().at(-1)).toContain("wizard design 'personal:mine'");
  });

  test("describing a workflow starts a session of the author role with that as its task", async () => {
    await workspace.up();
    const agent = await workflows.author("review every commit on the branch", {
      name: "commits",
    });
    expect(agent.role).toBe(AUTHOR_ROLE);
    expect(agent.task).toContain("What it should do: review every commit on the branch");
    // The user asked for it, so its session is shown under the main one at once.
    expect(agent.open).toBe(true);
    expect(agent.task).toContain('Save it under the name "commits".');

    const named = await workflows.author("x", { name: "nightly", personal: true });
    expect(named.task).toContain('Save it under the name "nightly".');
    expect(named.task).toContain("Save it as a personal workflow (personal: true).");
    await expect(workflows.author("x", { name: "not a name" })).rejects.toThrow("letters, digits");
    workflows.saveFile("taken", TEXT, "user");
    await expect(workflows.author("x", { name: "taken" })).rejects.toThrow(
      'There is already a workflow "taken".',
    );

    absentRoles = [AUTHOR_ROLE];
    await expect(workflows.author("x", { name: "other" })).rejects.toThrow("init --roles");
  });
});
