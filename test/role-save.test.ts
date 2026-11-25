import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/daemon/db.ts";
import { ROLE_AUTHOR_ROLE, RoleAuthor } from "../src/daemon/role-author.ts";
import { Workspace } from "../src/daemon/workspace.ts";
import { claudeProvider } from "../src/providers/claude/launch.ts";
import type { Config } from "../src/shared/config.ts";
import { readHistory } from "../src/shared/history.ts";
import { roleHistory } from "../src/shared/role-edit.ts";
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

const TEXT = `# why this exists
description = "Writes the docs"

model = "sonnet"
tools = ["Read", "Grep", "Glob", "Edit"]
permission_mode = "acceptEdits"

prompt = """
You write the docs.
"""
`;

describe("a role written by an agent", () => {
  let dir = "";
  let tmux: FakeTmux;
  let store: Store;
  let workspace: Workspace;
  let roles: RoleAuthor;
  let counter = 0;

  const project = () => join(dir, "project");
  const file = (...parts: string[]) => join(project(), ".dwa", "roles", ...parts);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dwa-role-save-"));
    tmux = new FakeTmux();
    store = new Store(":memory:");
    counter = 0;
    // Real role files: a role is checked by resolving it as a session start would.
    mkdirSync(file(), { recursive: true });
    writeFileSync(file(`${ROLE_AUTHOR_ROLE}.toml`), 'tools = ["Read"]\n');
    writeFileSync(file("explore.toml"), 'tools = ["Read"]\n');
    const env = { XDG_CONFIG_HOME: join(dir, "home") };
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
    roles = new RoleAuthor({ store, workspace, loadConfig: async () => config, env });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const messages = () => store.recentMessages("user", 10).map((message) => message.body);
  const popups = () => tmux.commands("display-popup").map((command) => command.join(" "));

  test("a new role is written as given, told to the user and shown in the role settings", async () => {
    await workspace.up();
    const author = await roles.author("writes the docs", { name: "docs" });
    const saved = await roles.saveFile("docs", TEXT, author.id);
    expect(saved).toEqual({ name: "docs", path: file("docs.toml"), version: 1, created: true });
    expect(readFileSync(file("docs.toml"), "utf8")).toBe(TEXT);
    expect(messages()[0]).toBe(
      'Wrote a new role "docs": model sonnet; permissions acceptEdits; tools Read, Grep, Glob, Edit\nLook at it with: dwa role show docs',
    );
    await Bun.sleep(0);
    expect(popups().at(-1)).toContain("wizard roles 'project:docs'");
  });

  test("saving it again makes a version by that agent and opens no second popup", async () => {
    await workspace.up();
    const author = await roles.author("writes the docs", { name: "docs" });
    await roles.saveFile("docs", TEXT, author.id);
    await Bun.sleep(0);
    const before = popups().length;
    const next = TEXT.replace('"acceptEdits"', '"manual"').replace(
      "model",
      'extends = "explore"\nmodel',
    );
    const saved = await roles.saveFile("docs", next, author.id);
    expect(saved).toMatchObject({ version: 2, created: false });
    expect(readFileSync(file("docs.toml"), "utf8")).toBe(next);
    const history = readHistory(roleHistory("docs", { projectRoot: project() }));
    expect(history.versions.map((version) => version.source)).toEqual([
      `agent ${author.name}`,
      `agent ${author.name}`,
    ]);
    expect(messages()[0]).toContain('Changed role "docs" (now v2): starts from explore; model');
    await Bun.sleep(0);
    expect(popups()).toHaveLength(before);
  });

  test("a text that is wrong, or names what does not exist, writes nothing", async () => {
    await workspace.up();
    const author = await roles.author("writes the docs", { name: "docs" });
    const save = (text: string) => roles.saveFile("docs", text, author.id);
    await expect(save("tools = [")).rejects.toThrow("invalid TOML");
    await expect(save("colour = 1\n")).rejects.toThrow("the definition");
    await expect(save('tools = ["Read"]\ndeny_tools = ["Bash"]\n')).rejects.toThrow();
    await expect(save('extends = "nobody"\n')).rejects.toThrow('Unknown role "nobody"');
    await expect(save('extends = "docs"\n')).rejects.toThrow("loop");
    await expect(save('mcp = ["jira"]\n')).rejects.toThrow('unknown MCP server "jira"');
    await expect(save('skills = ["nothing"]\n')).rejects.toThrow('unknown skill "nothing"');
    expect(existsSync(file("docs.toml"))).toBe(false);
    expect(messages()).toEqual([]);
    // What the catalogue has is fine.
    expect(await save('mcp = ["github"]\n')).toMatchObject({ created: true });
  });

  test("only the session started for a role saves it, and only that role", async () => {
    await workspace.up();
    const author = await roles.author("writes the docs", { name: "docs" });
    await expect(roles.saveFile("other", TEXT, author.id)).rejects.toThrow(
      "You were started to write the role project:docs and may save only that one, not project:other.",
    );
    await expect(roles.saveFile("docs", TEXT, author.id, true)).rejects.toThrow(
      "not personal:docs",
    );
    // Its own role and the others stay as they are.
    await expect(roles.saveFile(ROLE_AUTHOR_ROLE, TEXT, author.id)).rejects.toThrow(
      "may save only that one",
    );
    const other = await workspace.spawn({ name: "writer" });
    await expect(roles.saveFile("docs", TEXT, other.id)).rejects.toThrow("Only the session");
    // A session of the author's role that the user did not start for a role has none to write.
    const stray = await workspace.spawn({ name: "stray", role: ROLE_AUTHOR_ROLE });
    await expect(roles.saveFile("docs", TEXT, stray.id)).rejects.toThrow("Only the session");
    await expect(roles.saveFile("docs", TEXT, "user")).rejects.toThrow("Only the session");
    await expect(roles.saveFile("docs", TEXT, "gone")).rejects.toThrow("Only the session");
    expect(existsSync(file("docs.toml"))).toBe(false);
    expect(existsSync(file("other.toml"))).toBe(false);
    expect(readFileSync(file(`${ROLE_AUTHOR_ROLE}.toml`), "utf8")).toBe('tools = ["Read"]\n');
  });

  test("a personal role goes to the personal folder", async () => {
    await workspace.up();
    const author = await roles.author("my notes", { name: "mine", personal: true });
    expect(author.task).toContain("Save it as a personal role (personal: true).");
    const saved = await roles.saveFile("mine", TEXT, author.id, true);
    expect(saved.path).toBe(join(dir, "home", "dwa", "roles", "mine.toml"));
    expect(existsSync(file("mine.toml"))).toBe(false);
    await Bun.sleep(0);
    expect(popups().at(-1)).toContain("wizard roles 'personal:mine'");
  });

  test("describing a role starts a session of the author role with that as its task", async () => {
    await workspace.up();
    const agent = await roles.author("keeps the changelog", { name: "changelog" });
    expect(agent.role).toBe(ROLE_AUTHOR_ROLE);
    expect(agent.task).toBe(
      'Write a role for this project and save it with save_role. Save it under the name "changelog".\n\nWhat it is for: keeps the changelog',
    );
    // The user asked for it, so its session is shown under the main one at once.
    expect(agent.open).toBe(true);

    await expect(roles.author("x", { name: "not a name" })).rejects.toThrow(
      "cannot be a role name",
    );
    await expect(roles.author("x", { name: "explore" })).rejects.toThrow(
      'There is already a role "explore".',
    );
    rmSync(file(`${ROLE_AUTHOR_ROLE}.toml`));
    await expect(roles.author("x", { name: "other" })).rejects.toThrow("init --roles");
  });
});
