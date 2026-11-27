import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../src/shared/capabilities.ts";
import { readHistory, trackedConfig } from "../src/shared/history.ts";
import { editConfigText, saveConfig } from "../src/shared/role-edit.ts";
import {
  addArrayTable,
  removeArrayTable,
  removeTableTree,
  setKeys,
  setKeysAt,
  TomlEditError,
} from "../src/shared/toml.ts";

const CONFIG = `# the project's config
default_profile = "me"

[defaults]
model = "sonnet" # cheap

# the tracker
[mcp.github]
command = "github-mcp"
args = ["serve"]

[mcp.github.env]
GITHUB_TOKEN = "t" # from the vault

[profiles.me]
command = "~/claude_me"

# watches the build
[[agents]]
name = "watcher"
role = "explore" # reads only

[[agents]]
name = "helper"
task = "wait"

[main]
leader = false
`;

describe("one of a list of tables", () => {
  test("a key is set in the table at an index, and only there", () => {
    const next = setKeysAt(CONFIG, "agents", 1, { role: "developer", task: undefined });
    expect(next).toBe(
      CONFIG.replace('name = "helper"\ntask = "wait"\n', 'name = "helper"\nrole = "developer"\n'),
    );
    expect(setKeysAt(CONFIG, "agents", 0, { role: "reviewer" })).toBe(
      CONFIG.replace('role = "explore" # reads only', 'role = "reviewer" # reads only'),
    );
  });

  test("a plain table and a list of tables are not mistaken for each other", () => {
    expect(() => setKeys(CONFIG, "agents", { role: "x" })).toThrow("is a list of tables");
    expect(() => setKeysAt(CONFIG, "main", 0, { leader: true })).toThrow("is not a list of tables");
    expect(() => setKeysAt(CONFIG, "agents", 5, { role: "x" })).toThrow(TomlEditError);
  });

  test("a table is added after the last of the list and removed with its comment", () => {
    const added = addArrayTable(CONFIG, "agents", { name: "third", role: "explore" });
    expect(added).toBe(
      CONFIG.replace(
        'task = "wait"\n',
        'task = "wait"\n\n[[agents]]\nname = "third"\nrole = "explore"\n',
      ),
    );
    expect(removeArrayTable(CONFIG, "agents", 0)).toBe(
      CONFIG.replace(
        '# watches the build\n[[agents]]\nname = "watcher"\nrole = "explore" # reads only\n\n',
        "",
      ),
    );
    // The first of a list in a file that has none goes at the end.
    expect(addArrayTable("a = 1\n", "agents", { name: "x" })).toBe(
      'a = 1\n\n[[agents]]\nname = "x"\n',
    );
  });
});

describe("a table with tables inside it", () => {
  test("goes with them and with its comment", () => {
    expect(removeTableTree(CONFIG, "mcp.github")).toBe(
      CONFIG.replace(
        '# the tracker\n[mcp.github]\ncommand = "github-mcp"\nargs = ["serve"]\n\n[mcp.github.env]\nGITHUB_TOKEN = "t" # from the vault\n\n',
        "",
      ),
    );
    expect(() => removeTableTree(CONFIG, "mcp.nothing")).toThrow("there is no table");
  });
});

describe("changes to a config's own tables", () => {
  test("entries are added, changed key by key and removed, the rest untouched", () => {
    const next = editConfigText(CONFIG, [
      { op: "table", table: "mcp", name: "jira", body: { command: "jira-mcp", env: { A: "b" } } },
      { op: "key", table: "mcp", name: "github", key: "args", value: ["serve", "--ro"] },
      { op: "key", table: "main", key: "model", value: "opus" },
      { op: "key", table: "main", key: "leader", value: null },
      { op: "key", table: "agents", name: "helper", key: "role", value: "developer" },
      { op: "table", table: "agents", name: "watcher", body: null },
      { op: "table", table: "profiles", name: "work", body: { command: "~/claude_work" } },
    ]);
    expect(next).toBe(`# the project's config
default_profile = "me"

[defaults]
model = "sonnet" # cheap

# the tracker
[mcp.github]
command = "github-mcp"
args = ["serve", "--ro"]

[mcp.github.env]
GITHUB_TOKEN = "t" # from the vault

[mcp.jira]
command = "jira-mcp"
env = { A = "b" }

[profiles.me]
command = "~/claude_me"

[profiles.work]
command = "~/claude_work"

[[agents]]
name = "helper"
task = "wait"
role = "developer"

[main]
model = "opus"
`);
  });

  test("an entry that is there is not added again, and one that is not is not changed", () => {
    expect(() =>
      editConfigText(CONFIG, [
        { op: "table", table: "mcp", name: "github", body: { command: "x" } },
      ]),
    ).toThrow("There is already a [mcp.github]");
    expect(() =>
      editConfigText(CONFIG, [
        { op: "key", table: "mcp", name: "jira", key: "command", value: "x" },
      ]),
    ).toThrow("There is no [mcp.jira]");
    expect(() =>
      editConfigText(CONFIG, [
        { op: "key", table: "agents", name: "nobody", key: "role", value: "x" },
      ]),
    ).toThrow('There is no [[agents]] entry "nobody"');
    expect(() =>
      editConfigText(CONFIG, [{ op: "table", table: "agents", name: "helper", body: {} }]),
    ).toThrow("There is already an [[agents]] entry");
  });
});

describe("a config saved with table changes", () => {
  let dir = "";
  const path = () => join(dir, ".dwa", "config.toml");
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dwa-config-edit-"));
    mkdirSync(join(dir, ".dwa"), { recursive: true });
    writeFileSync(path(), CONFIG);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = () => ({ projectRoot: dir, env: { XDG_CONFIG_HOME: join(dir, "home") } });

  test("defaults and tables go into one version", () => {
    const version = saveConfig(
      "project",
      { effort: "high" },
      [{ op: "key", table: "main", key: "model", value: "opus" }],
      "selfheal, fix #1",
      ctx(),
    );
    const text = readFileSync(path(), "utf8");
    expect(text).toContain('model = "sonnet" # cheap\neffort = "high"\n');
    expect(text).toContain('[main]\nleader = false\nmodel = "opus"\n');
    const history = readHistory(trackedConfig(dir, "project", ctx().env));
    expect(history.versions.at(-1)).toMatchObject({ n: version.n, source: "selfheal, fix #1" });
  });

  test("a result that is no valid config is not written", () => {
    expect(() =>
      saveConfig(
        "project",
        {},
        [{ op: "table", table: "mcp", name: "bad", body: { nonsense: "x" } }],
        "test",
        ctx(),
      ),
    ).toThrow(ConfigError);
    expect(readFileSync(path(), "utf8")).toBe(CONFIG);
  });
});
