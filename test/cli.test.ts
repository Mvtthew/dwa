import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_TEMPLATE, initProject } from "../src/cli/init.ts";
import { projectRoles } from "../src/cli/palette.ts";
import { parseConfig } from "../src/shared/config.ts";
import { checkSessions, resolveSession } from "../src/shared/roles.ts";
import { listWorkflows, loadWorkflow } from "../src/shared/workflow.ts";

/** Keeps the roles of whoever runs the tests (~/.config/dwa/roles) out of them. */
const ENV = { XDG_CONFIG_HOME: "/nonexistent" };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dwa-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("init", () => {
  test("the config template is valid and sets only the models", () => {
    expect(parseConfig(CONFIG_TEMPLATE, "template")).toEqual({
      profiles: {},
      keys: {},
      agents: [],
      layout: {},
      defaults: { model: "sonnet", effort: "medium" },
      main: { model: "opus", effort: "medium" },
      mcp: {},
      plugins: {},
    });
  });

  test("creates the config, and roles and the ignore entry when asked and applicable", () => {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".gitignore"), "node_modules/");
    const result = initProject(dir, { roles: true });
    expect(existsSync(join(dir, ".dwa", "config.toml"))).toBe(true);
    expect(projectRoles(dir, ENV)).toEqual([
      "designer",
      "developer",
      "dwa-selfheal",
      "explore",
      "general",
      "main",
      "planner",
      "quick",
      "reviewer",
      "role-author",
      "runner",
      "web-chrome",
      "web-research",
      "workflow-author",
    ]);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(
      "node_modules/\n.dwa/reports/\n.dwa/run/\n",
    );
    expect(result.created).toHaveLength(22);
    // Every workflow that comes with the roles can be run with exactly those roles.
    expect(listWorkflows(dir).map((workflow) => [workflow.name, workflow.error])).toEqual([
      ["bugfix", null],
      ["feature", null],
      ["parallel-build", null],
      ["review-only", null],
    ]);
    const roles = projectRoles(dir, ENV);
    for (const workflow of listWorkflows(dir)) {
      const definition = loadWorkflow(dir, workflow.name, ENV);
      for (const step of Object.values(definition.steps)) expect(roles).toContain(step.role ?? "");
    }
    expect(readFileSync(join(dir, ".dwa", "roles", "reviewer.toml"), "utf8")).toContain(
      'extends = "explore"',
    );
  });

  test("the example roles resolve with the template config, and the workflow uses only them", () => {
    initProject(dir, { roles: true });
    const config = parseConfig(CONFIG_TEMPLATE, "template");
    const ctx = { projectRoot: dir, env: ENV };
    const session = (role: string) => resolveSession({ config, role }, ctx);
    // The main role's prompt is the user's own rules; its instructions are the built-in leader text.
    for (const role of projectRoles(dir, ENV)) {
      if (role === "main") expect(session(role).prompt).toBeUndefined();
      else expect(session(role).prompt).toBeTruthy();
    }
    expect(resolveSession({ config, main: true }, ctx)).toMatchObject({
      role: "main",
      leader: true,
    });
    expect(session("developer")).toMatchObject({
      model: "sonnet",
      effort: "high",
      permissionMode: "acceptEdits",
      deny: ["Bash(git push *)"],
      memory: false,
    });
    expect(session("explore")).toMatchObject({
      tools: ["Read", "Grep", "Glob", "Bash"],
      permissionMode: "dontAsk",
    });
    // The reviewer takes tools, mode and rules from explore and adds its own model and skill.
    const reviewer = session("reviewer");
    expect(reviewer).toMatchObject({
      model: "opus",
      tools: ["Read", "Grep", "Glob", "Bash"],
      permissionMode: "dontAsk",
      allow: session("explore").allow,
    });
    expect(reviewer.skills?.map((skill) => [skill.name, skill.source])).toEqual([
      ["review-checklist", "dwa"],
    ]);
    // [main] in the template wins over the role's effort.
    expect(resolveSession({ config, main: true }, ctx)).toMatchObject({
      role: "main",
      model: "opus",
      effort: "medium",
      memory: true,
    });
    expect(checkSessions(config, ctx)).toEqual([]);
    const steps = Object.values(loadWorkflow(dir, "feature").steps);
    expect(steps.every((step) => step.role && projectRoles(dir, ENV).includes(step.role))).toBe(
      true,
    );
  });

  test("never overwrites existing files and leaves non-git folders without .gitignore", () => {
    mkdirSync(join(dir, ".dwa"));
    writeFileSync(join(dir, ".dwa", "config.toml"), "# mine");
    const result = initProject(dir, { roles: false });
    expect(readFileSync(join(dir, ".dwa", "config.toml"), "utf8")).toBe("# mine");
    expect(result.created).toEqual([]);
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
  });

  test("running it twice adds the ignore entry once", () => {
    mkdirSync(join(dir, ".git"));
    initProject(dir, { roles: false });
    initProject(dir, { roles: false });
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".dwa/reports/\n.dwa/run/\n");
  });
});

const home = (...parts: string[]) => join(dir, "home", "dwa", ...parts);
/** Runs the CLI from source for the scratch project, with a personal folder of its own. */
function dwa(...args: string[]): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "../src/cli/index.ts"), ...args],
    {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "",
        // Never the real home: the personal files are the scratch ones.
        HOME: join(dir, "home"),
        XDG_CONFIG_HOME: join(dir, "home"),
        DWA_BUILTIN_DIR: "",
        DWA_PROJECT: dir,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    code: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

describe("the role command with a personal folder", () => {
  beforeEach(() => {
    initProject(dir, { roles: true });
    mkdirSync(home("roles"), { recursive: true });
    writeFileSync(home("roles", "mine.toml"), 'description = "Mine"\n');
    writeFileSync(home("roles", "explore.toml"), 'description = "My explore"\n');
  });

  test("role list shows where each role is and the personal one the project hides", () => {
    const list = dwa("role", "list");
    expect(list.code).toBe(0);
    const lines = list.out.trimEnd().split("\n");
    expect(lines.map((line) => line.split(/\s+/)[0])).toEqual([
      "designer",
      "developer",
      "dwa-selfheal",
      "explore",
      "explore",
      "general",
      "main",
      "mine",
      "planner",
      "quick",
      "reviewer",
      "role-author",
      "runner",
      "web-chrome",
      "web-research",
      "workflow-author",
    ]);
    expect(lines[3]).toMatch(/^explore {10}project {3}\S/);
    expect(lines[4]).toBe("explore          personal, hidden by the project's role  My explore");
    expect(lines[7]).toBe("mine             personal  Mine");

    const json = JSON.parse(dwa("role", "list", "--json").out) as Record<string, unknown>[];
    expect(json.filter((role) => role.name === "explore")).toMatchObject([
      { source: "project", hidden: false },
      {
        source: "user",
        hidden: true,
        description: "My explore",
        path: home("roles", "explore.toml"),
      },
    ]);
  });

  test("role new --personal creates the file in the personal folder", () => {
    const made = dwa("role", "new", "notes", "--personal", "--description", "Takes notes");
    expect(made).toMatchObject({ code: 0, out: `Created ${home("roles", "notes.toml")}\n` });
    expect(readFileSync(home("roles", "notes.toml"), "utf8")).toContain(
      'description = "Takes notes"',
    );
    expect(existsSync(join(dir, ".dwa", "roles", "notes.toml"))).toBe(false);
    expect(existsSync(home("history", "roles", "notes", "v1.toml"))).toBe(true);
    // Without the flag the project gets it; a name taken in either place is refused.
    expect(dwa("role", "new", "tester").out).toBe(
      `Created ${join(dir, ".dwa", "roles", "tester.toml")}\n`,
    );
    const taken = dwa("role", "new", "mine");
    expect(taken.code).toBe(1);
    expect(taken.err).toContain('There is already a personal role "mine".');
  });

  test("role copy --to personal copies a project role into the personal folder", () => {
    const copy = dwa("role", "copy", "reviewer", "critic", "--to", "personal");
    expect(copy).toMatchObject({ code: 0, out: `Created ${home("roles", "critic.toml")}\n` });
    expect(readFileSync(home("roles", "critic.toml"), "utf8")).toBe(
      readFileSync(join(dir, ".dwa", "roles", "reviewer.toml"), "utf8"),
    );
    // The hidden personal role is reached by its place, and the copy stays where it was.
    expect(dwa("role", "copy", "personal:explore", "scout").out).toBe(
      `Created ${home("roles", "scout.toml")}\n`,
    );
    expect(dwa("role", "copy", "explore", "reader", "--personal", "--to", "project").out).toBe(
      `Created ${join(dir, ".dwa", "roles", "reader.toml")}\n`,
    );
    expect(readFileSync(join(dir, ".dwa", "roles", "reader.toml"), "utf8")).toBe(
      'description = "My explore"\n',
    );
    expect(dwa("role", "copy", "reviewer", "other", "--to", "nowhere").code).toBe(1);
    expect(existsSync(join(dir, ".dwa", "roles", "other.toml"))).toBe(false);
  });

  test("role move --to project moves a personal role with its history and says what it means", () => {
    dwa("role", "list");
    writeFileSync(home("roles", "mine.toml"), 'description = "Mine, edited"\n');
    const moved = dwa("role", "move", "mine", "--to", "project");
    expect(moved.code).toBe(0);
    expect(moved.out).toBe(
      `Moved to ${join(dir, ".dwa", "roles", "mine.toml")}\n` +
        'Note: Other projects that use your personal role "mine" are not checked: ' +
        "they will no longer find it among your personal roles.\n",
    );
    expect(existsSync(home("roles", "mine.toml"))).toBe(false);
    expect(existsSync(home("history", "roles", "mine"))).toBe(false);
    const history = JSON.parse(dwa("role", "history", "mine", "--json").out) as {
      current: number;
      versions: { n: number; source: string }[];
    };
    expect(history.current).toBe(2);
    expect(history.versions.map((version) => [version.n, version.source])).toEqual([
      [1, "first version"],
      [2, "edited by hand"],
    ]);

    const again = dwa("role", "move", "mine", "--to", "project");
    expect(again.code).toBe(1);
    expect(again.err).toContain('role "mine" is already in the project.');
    const twin = dwa("role", "move", "personal:explore", "--to", "project");
    expect(twin.code).toBe(1);
    expect(twin.err).toContain('There is already a project role "explore"');
    expect(dwa("role", "move", "mine").code).toBe(1);
    expect(dwa("role", "move", "developer", "--to", "personal").out).toContain(
      'Note: Others who use this project will no longer have role "developer".',
    );
  });

  test("role history personal:<name> is the personal file's, not the project's of that name", () => {
    dwa("role", "list");
    writeFileSync(home("roles", "explore.toml"), 'description = "My explore, edited"\n');
    const personal = dwa("role", "history", "personal:explore");
    expect(personal.code).toBe(0);
    const lines = personal.out.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\* v2 {3}\d{4}-\d\d-\d\d \d\d:\d\d {2}edited by hand$/);
    expect(lines[1]).toMatch(/^ {2}v1 {3}.* {2}first version$/);
    expect(dwa("role", "history", "explore", "--personal").out).toBe(personal.out);
    for (const used of [
      dwa("role", "history", "explore"),
      dwa("role", "history", "project:explore"),
    ]) {
      expect(used.out.trimEnd().split("\n")).toHaveLength(1);
    }
    expect(dwa("role", "diff", "personal:explore").out).toContain(
      '+ description = "My explore, edited"',
    );
    const missing = dwa("role", "history", "personal:reviewer");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('Unknown personal role "reviewer".');
  });

  test("config check prints the notes and they never change the result", () => {
    const fine = dwa("config", "check");
    expect(fine.code).toBe(0);
    expect(fine.err).toBe("");
    expect(fine.out).toBe(
      "Configuration is fine: 15 roles checked.\n\nNotes:\n" +
        '  Your personal role "explore" is not used here: the project has a role of the same name.\n' +
        '  Role "web-chrome" is not offered for handing work to: it runs with the profile "chrome", which the config does not define ([profiles.chrome]).\n',
    );

    writeFileSync(
      join(dir, ".dwa", "roles", "child.toml"),
      'description = "Child"\nextends = "mine"\n',
    );
    const noted = dwa("config", "check");
    expect(noted.code).toBe(0);
    expect(noted.out).toContain("Configuration is fine: 16 roles checked.");
    expect(noted.out).toContain(
      '  Role "child" is in the project but starts from your personal role "mine", ' +
        "which others who use this project do not have.",
    );

    // A real problem still fails, with the notes after it.
    writeFileSync(join(dir, ".dwa", "roles", "broken.toml"), 'extends = "nobody"\n');
    const broken = dwa("config", "check");
    expect(broken.code).toBe(1);
    expect(broken.err).toContain('Unknown role "nobody"');
    expect(broken.out).not.toContain("Configuration is fine");
    expect(broken.out).toContain("Notes:");

    rmSync(join(dir, ".dwa", "roles", "broken.toml"));
    rmSync(join(dir, ".dwa", "roles", "child.toml"));
    rmSync(home("roles", "explore.toml"));
    expect(dwa("config", "check")).toMatchObject({
      code: 0,
      out:
        "Configuration is fine: 15 roles checked.\n\nNotes:\n" +
        `  Role "web-chrome" is not offered for handing work to: it runs with the profile "chrome", which the config does not define ([profiles.chrome]).\n`,
    });
  });
});

describe("the workflow command on the files", () => {
  const project = (name: string) => join(dir, ".dwa", "workflows", `${name}.toml`);
  const personal = (name: string) => home("workflows", `${name}.toml`);
  const read = (path: string) => readFileSync(path, "utf8");
  const TEMPLATE = '[steps.work]\nprompt = """\n{{input}}\n"""\n';
  const PICTURE = [
    "╭───────────╮",
    "│ explore   │",
    "│ explore   │",
    "╰─────┬─────╯",
    "      │",
    "╭─────▼─────╮",
    "│ build     │◀─×3─╮",
    "│ developer │     │",
    "╰─────┬─────╯     │",
    "      │           │",
    "╭─────▼─────╮     │",
    "│ review    │     │",
    "│ reviewer  ├─────╯",
    "╰───────────╯",
  ].join("\n");
  interface Listing {
    current: number;
    versions: { n: number; source: string; from?: number }[];
  }
  const history = (...ref: string[]) =>
    JSON.parse(dwa("workflow", "history", ...ref, "--json").out) as Listing;
  const sources = (...ref: string[]) => history(...ref).versions.map((version) => version.source);

  beforeEach(() => {
    initProject(dir, { roles: true });
  });

  test("workflow new creates a file to start from, in the project or with --personal", () => {
    const made = dwa("workflow", "new", "ship", "--description", "Ship it");
    expect(made).toEqual({ code: 0, out: `Created ${project("ship")}\n`, err: "" });
    expect(read(project("ship"))).toBe(`description = "Ship it"\n\n${TEMPLATE}`);
    expect(read(join(dir, ".dwa", "history", "workflows", "ship", "v1.toml"))).toBe(
      read(project("ship")),
    );
    expect(sources("ship")).toEqual(["workflow new"]);

    const mine = dwa("workflow", "new", "mine", "--personal");
    expect(mine).toEqual({ code: 0, out: `Created ${personal("mine")}\n`, err: "" });
    expect(read(personal("mine"))).toBe(TEMPLATE);
    expect(existsSync(project("mine"))).toBe(false);
    expect(existsSync(home("history", "workflows", "mine", "v1.toml"))).toBe(true);
    expect(existsSync(join(dir, ".dwa", "history", "workflows", "mine"))).toBe(false);

    // A name taken in either place, or one that cannot be a name, is refused.
    expect(dwa("workflow", "new", "ship")).toMatchObject({
      code: 1,
      err: 'There is already a workflow "ship".\n',
    });
    expect(dwa("workflow", "new", "mine").err).toBe(
      'There is already a personal workflow "mine".\n',
    );
    expect(dwa("workflow", "new", "feature", "--personal").code).toBe(1);
    expect(dwa("workflow", "new", "a b").err).toContain('"a b" cannot be a workflow name');
    const bare = dwa("workflow", "new");
    expect(bare.code).toBe(2);
    expect(bare.err).toContain("workflow new <name>");
  });

  test("workflow duplicate copies next to the original, or with --to into the other place", () => {
    const kept = dwa("workflow", "duplicate", "feature", "kept", "--to", "personal");
    expect(kept).toEqual({ code: 0, out: `Created ${personal("kept")}\n`, err: "" });
    expect(read(personal("kept"))).toBe(read(project("feature")));
    expect(sources("kept")).toEqual(["copy of feature"]);
    expect(existsSync(home("history", "workflows", "kept", "v1.toml"))).toBe(true);

    expect(dwa("workflow", "duplicate", "feature", "copy").out).toBe(
      `Created ${project("copy")}\n`,
    );
    // A personal one stays personal, unless the project is named.
    expect(dwa("workflow", "duplicate", "kept", "kept-2").out).toBe(
      `Created ${personal("kept-2")}\n`,
    );
    expect(dwa("workflow", "duplicate", "kept", "shared", "--to", "project").out).toBe(
      `Created ${project("shared")}\n`,
    );
    expect(dwa("workflow", "duplicate", "feature", "kept").err).toBe(
      'There is already a personal workflow "kept".\n',
    );
    expect(dwa("workflow", "duplicate", "feature", "other", "--to", "nowhere").code).toBe(2);
    expect(dwa("workflow", "duplicate", "feature").code).toBe(2);
    expect(existsSync(project("other"))).toBe(false);
    expect(dwa("workflow", "duplicate", "nope", "other")).toMatchObject({
      code: 1,
      err: 'Unknown workflow "nope".\n',
    });
  });

  test("workflow rename moves the file and its history to the new name", () => {
    dwa("workflow", "new", "ship");
    writeFileSync(project("ship"), `# mine\n${TEMPLATE}`);
    const renamed = dwa("workflow", "rename", "ship", "deliver");
    expect(renamed).toEqual({
      code: 0,
      out: `Renamed to ${project("deliver")}\nRuns already started keep the old name.\n`,
      err: "",
    });
    expect(existsSync(project("ship"))).toBe(false);
    expect(read(project("deliver"))).toBe(`# mine\n${TEMPLATE}`);
    expect(existsSync(join(dir, ".dwa", "history", "workflows", "ship"))).toBe(false);
    // The change made in an editor before the rename has its version.
    expect(sources("deliver")).toEqual(["workflow new", "edited by hand"]);

    dwa("workflow", "new", "mine", "--personal");
    expect(dwa("workflow", "rename", "mine", "own").out).toBe(
      `Renamed to ${personal("own")}\nRuns already started keep the old name.\n` +
        'Note: Other projects that use your personal workflow "mine" are not checked.\n',
    );
    expect(dwa("workflow", "rename", "deliver", "feature")).toMatchObject({
      code: 1,
      err: 'There is already a workflow "feature".\n',
    });
    expect(dwa("workflow", "rename", "deliver", "own").code).toBe(1);
    expect(dwa("workflow", "rename", "deliver").code).toBe(2);
    expect(existsSync(project("deliver"))).toBe(true);
  });

  test("workflow move --to project moves a personal workflow with its history", () => {
    dwa("workflow", "new", "mine", "--personal");
    writeFileSync(personal("mine"), `# edited\n${TEMPLATE}`);
    const moved = dwa("workflow", "move", "mine", "--to", "project");
    expect(moved).toEqual({
      code: 0,
      out:
        `Moved to ${project("mine")}\n` +
        'Note: Other projects that use your personal workflow "mine" are not checked. ' +
        "Its steps name roles; the project needs them too.\n",
      err: "",
    });
    expect(existsSync(personal("mine"))).toBe(false);
    expect(existsSync(home("history", "workflows", "mine"))).toBe(false);
    expect(read(project("mine"))).toBe(`# edited\n${TEMPLATE}`);
    const moves = history("mine");
    expect(moves.current).toBe(2);
    expect(moves.versions.map((version) => [version.n, version.source])).toEqual([
      [1, "workflow new"],
      [2, "edited by hand"],
    ]);

    const again = dwa("workflow", "move", "mine", "--to", "project");
    expect(again).toMatchObject({ code: 1, err: 'workflow "mine" is already in the project.\n' });
    expect(dwa("workflow", "move", "mine").code).toBe(2);
    expect(dwa("workflow", "move", "mine", "--to", "nowhere").code).toBe(2);
    expect(dwa("workflow", "move", "feature", "--to", "personal").out).toBe(
      `Moved to ${personal("feature")}\n` +
        'Note: Others who use this project will no longer have workflow "feature".\n',
    );
    // With a file of the name in both places, neither can move onto the other.
    writeFileSync(project("feature"), TEMPLATE);
    const twin = dwa("workflow", "move", "personal:feature", "--to", "project");
    expect(twin.code).toBe(1);
    expect(twin.err).toContain('There is already a project workflow "feature"');
  });

  test("workflow delete removes the file and keeps its history", () => {
    dwa("workflow", "new", "ship");
    expect(dwa("workflow", "delete", "ship")).toEqual({
      code: 0,
      out: "Deleted workflow ship. Its history is kept.\n",
      err: "",
    });
    expect(existsSync(project("ship"))).toBe(false);
    expect(read(join(dir, ".dwa", "history", "workflows", "ship", "v1.toml"))).toBe(TEMPLATE);
    expect(dwa("workflow", "delete", "ship")).toMatchObject({
      code: 1,
      err: 'Unknown workflow "ship".\n',
    });
    expect(dwa("workflow", "delete").code).toBe(2);

    // A personal workflow of the same name comes forward when the project's goes.
    mkdirSync(home("workflows"), { recursive: true });
    writeFileSync(personal("feature"), TEMPLATE);
    expect(dwa("workflow", "delete", "feature").out).toBe(
      "Deleted workflow feature. Its history is kept.\n" +
        'Note: Your personal workflow "feature" is hidden by this one and will be the one used here afterwards.\n',
    );
    expect(existsSync(project("feature"))).toBe(false);
    expect(read(personal("feature"))).toBe(TEMPLATE);
    expect(dwa("workflow", "show", "feature").out).toStartWith("feature (personal)\n");
  });

  test("workflow history, diff and switch show the versions and go back to one", () => {
    const first = read(project("feature"));
    expect(dwa("workflow", "history", "feature").out).toMatch(
      /^\* v1 {3}\d{4}-\d\d-\d\d \d\d:\d\d {2}first version\n$/,
    );
    expect(dwa("workflow", "diff", "feature").out).toBe(
      "v1 is the first version; there is nothing to compare it with.\n",
    );
    // Changed in an editor: the next command notices it.
    writeFileSync(project("feature"), first.replace("max_rounds = 3", "max_rounds = 5"));
    const listed = dwa("workflow", "history", "feature");
    expect(listed.code).toBe(0);
    const lines = listed.out.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\* v2 {3}\d{4}-\d\d-\d\d \d\d:\d\d {2}edited by hand$/);
    expect(lines[1]).toMatch(/^ {2}v1 {3}\d{4}-\d\d-\d\d \d\d:\d\d {2}first version$/);
    expect(history("feature")).toMatchObject({
      current: 2,
      versions: [
        { n: 1, source: "first version" },
        { n: 2, source: "edited by hand", from: 1 },
      ],
    });

    const diff = dwa("workflow", "diff", "feature");
    expect(diff.code).toBe(0);
    expect(diff.out).toBe(
      [
        "v1 → v2",
        '  depends_on = ["build"]',
        '  reviews = "build"',
        "- max_rounds = 3",
        "+ max_rounds = 5",
        '  prompt = """',
        "  Review the change that was just made for: {{input}}",
        "",
      ].join("\n"),
    );
    const back = dwa("workflow", "diff", "feature", "v2", "v1").out;
    expect(back).toStartWith("v2 → v1\n");
    expect(back).toContain("- max_rounds = 5\n+ max_rounds = 3\n");
    expect(dwa("workflow", "diff", "feature", "v2", "v2").out).toBe("v2 → v2\nNo differences.\n");
    expect(dwa("workflow", "diff", "feature", "vx").code).toBe(2);

    expect(dwa("workflow", "switch", "feature", "v1")).toEqual({
      code: 0,
      out: "Workflow feature is now at v1. Runs already started keep their own copy.\n",
      err: "",
    });
    expect(read(project("feature"))).toBe(first);
    // Nothing is deleted: both versions are there and the pointer moved.
    expect(history("feature")).toMatchObject({ current: 1, versions: [{ n: 1 }, { n: 2 }] });
    expect(dwa("workflow", "history", "feature").out).toMatch(/^ {2}v2 .*\n\* v1 /);
    expect(dwa("workflow", "switch", "feature", "2").code).toBe(0);
    expect(read(project("feature"))).toContain("max_rounds = 5");
    expect(dwa("workflow", "switch", "feature", "v9")).toMatchObject({
      code: 1,
      err: "There is no version v9.\n",
    });
    expect(dwa("workflow", "switch", "feature").code).toBe(2);
  });

  test("workflow switch refuses a version that is not a valid workflow any more", () => {
    const first = read(project("feature"));
    dwa("workflow", "history", "feature");
    writeFileSync(project("feature"), '[steps.a]\nrole = "explore"\n');
    dwa("workflow", "history", "feature");
    writeFileSync(project("feature"), first);
    expect(history("feature").current).toBe(1);
    const refused = dwa("workflow", "switch", "feature", "v2");
    expect(refused.code).toBe(1);
    expect(refused.err).toStartWith("v2: steps.a.prompt");
    expect(read(project("feature"))).toBe(first);
    expect(history("feature").current).toBe(1);
  });

  test("workflow show prints the steps as a picture", () => {
    const shown = dwa("workflow", "show", "feature");
    expect(shown.code).toBe(0);
    expect(shown.err).toBe("");
    expect(shown.out).toBe(
      `feature (project): Explore the code, implement the change, review it\n\n${PICTURE}\n`,
    );
    for (const name of ["explore", "build", "review"]) expect(shown.out).toContain(`│ ${name} `);
    for (const char of ["╭", "╮", "╰", "╯", "┬", "▼", "◀", "×3"]) {
      expect(shown.out).toContain(char);
    }
    dwa("workflow", "new", "plain");
    expect(dwa("workflow", "show", "plain").out).toBe(
      [
        "plain (project)",
        "",
        "╭───────────╮",
        "│ work      │",
        "│ no role   │",
        "╰───────────╯",
        "",
      ].join("\n"),
    );
    expect(dwa("workflow", "show", "nope")).toMatchObject({
      code: 1,
      out: "",
      err: 'Unknown workflow "nope".\n',
    });
    writeFileSync(project("broken"), "[steps");
    const broken = dwa("workflow", "show", "broken");
    expect(broken.code).toBe(1);
    expect(broken.err).toStartWith(`${project("broken")}: invalid TOML`);
    expect(dwa("workflow", "show").code).toBe(2);
  });

  test("personal:<name> names the personal file, also when the project hides it", () => {
    mkdirSync(home("workflows"), { recursive: true });
    writeFileSync(personal("feature"), `description = "Mine"\n\n${TEMPLATE}`);
    const mine = dwa("workflow", "show", "personal:feature");
    expect(mine.code).toBe(0);
    expect(mine.out).toStartWith(
      "feature (personal, hidden by the project's workflow): Mine\n\n╭───────────╮\n│ work      │\n",
    );
    expect(dwa("workflow", "show", "feature", "--personal").out).toBe(mine.out);
    // A bare name, project:<name> and --project all mean the project's file.
    const used = dwa("workflow", "show", "feature").out;
    expect(used).toStartWith("feature (project): Explore the code");
    expect(dwa("workflow", "show", "project:feature").out).toBe(used);
    expect(dwa("workflow", "show", "feature", "--project").out).toBe(used);

    // Each file has its own history, in its own place.
    writeFileSync(personal("feature"), `description = "Mine, edited"\n\n${TEMPLATE}`);
    expect(sources("personal:feature")).toEqual(["first version", "edited by hand"]);
    expect(sources("feature")).toEqual(["first version"]);
    expect(sources("project:feature")).toEqual(["first version"]);
    expect(existsSync(home("history", "workflows", "feature", "v2.toml"))).toBe(true);
    expect(existsSync(join(dir, ".dwa", "history", "workflows", "feature", "v2.toml"))).toBe(false);
    expect(dwa("workflow", "diff", "personal:feature").out).toContain(
      '- description = "Mine"\n+ description = "Mine, edited"\n',
    );
    expect(dwa("workflow", "switch", "personal:feature", "v1").code).toBe(0);
    expect(read(personal("feature"))).toBe(`description = "Mine"\n\n${TEMPLATE}`);
    expect(read(project("feature"))).toContain("[steps.explore]");

    expect(dwa("workflow", "duplicate", "personal:feature", "mine-2").out).toBe(
      `Created ${personal("mine-2")}\n`,
    );
    expect(dwa("workflow", "rename", "personal:feature", "solo").out).toStartWith(
      `Renamed to ${personal("solo")}\n`,
    );
    expect(existsSync(project("feature"))).toBe(true);
    expect(dwa("workflow", "delete", "personal:solo").out).toBe(
      "Deleted workflow solo. Its history is kept.\n" +
        'Note: Other projects that use your personal workflow "solo" are not checked.\n',
    );
    expect(existsSync(personal("solo"))).toBe(false);
    expect(existsSync(home("history", "workflows", "solo", "v1.toml"))).toBe(true);
    expect(dwa("workflow", "show", "personal:nope")).toMatchObject({
      code: 1,
      err: 'Unknown personal workflow "nope".\n',
    });
  });
});
