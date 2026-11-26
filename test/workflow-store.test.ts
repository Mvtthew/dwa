// The workflow designer's real store, against a scratch project and a scratch personal folder.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/shared/config.ts";
import type { DesignTarget } from "../src/ui/designer-model.ts";
import {
  type Draft,
  diskWorkflowStore,
  draftPath,
  readTemplates,
  type WorkflowStore,
} from "../src/ui/workflow-store.ts";

const workflow = (description: string, steps: string[] = ["work"]) =>
  `# Kept: a comment.\ndescription = "${description}"\n\n${steps
    .map(
      (id, at) =>
        `[steps.${id}]\n${at > 0 ? `depends_on = ["${steps[at - 1]}"]\n` : ""}prompt = "Do ${id}: {{input}}"\n`,
    )
    .join("\n")}`;

let dir: string;
let env: Record<string, string>;
let store: WorkflowStore;
const project = (...parts: string[]) => join(dir, ".dwa", ...parts);
const home = (...parts: string[]) => join(dir, "home", "dwa", ...parts);
const projectText = (name: string) => readFileSync(project("workflows", `${name}.toml`), "utf8");
const personalText = (name: string) => readFileSync(home("workflows", `${name}.toml`), "utf8");
const places = () => store.list().map((entry) => [entry.name, entry.source, entry.hidden]);
const open = (config: Config | null = null) => diskWorkflowStore(dir, config, env);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dwa-workflow-store-"));
  // A personal folder of its own: the real one is never read or written.
  env = { XDG_CONFIG_HOME: join(dir, "home"), DWA_BUILTIN_DIR: "" };
  mkdirSync(project("workflows"), { recursive: true });
  mkdirSync(home("workflows"), { recursive: true });
  writeFileSync(project("workflows", "feature.toml"), workflow("Ours", ["explore", "build"]));
  writeFileSync(home("workflows", "feature.toml"), workflow("My feature"));
  writeFileSync(home("workflows", "mine.toml"), workflow("Mine"));
  store = open();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the workflow store on disk", () => {
  test("lists both places, with the personal workflow the project hides", () => {
    expect(places()).toEqual([
      ["feature", "project", false],
      ["feature", "user", true],
      ["mine", "user", false],
    ]);
    expect(store.list()[0]).toEqual({
      name: "feature",
      source: "project",
      hidden: false,
      description: "Ours",
      steps: ["explore", "build"],
      error: null,
    });
    expect(store.list()[1]).toMatchObject({ hidden: true, description: "My feature" });
  });

  test("a file that cannot be run is listed with why, and can still be read", () => {
    writeFileSync(project("workflows", "broken.toml"), '[steps.a]\ndepends_on = ["b"]\n');
    const broken = store.list().find((entry) => entry.name === "broken");
    expect(broken).toMatchObject({ source: "project", description: null, steps: [] });
    expect(broken?.error).toBeTruthy();
    expect(store.read({ name: "broken", source: "project" })).toContain("[steps.a]");
    // Files that are not workflows are not listed.
    writeFileSync(project("workflows", "notes.txt"), "x");
    expect(store.list().map((entry) => entry.name)).not.toContain("notes");
  });

  test("an empty project has nothing to list", () => {
    const empty = mkdtempSync(join(tmpdir(), "dwa-workflow-store-empty-"));
    try {
      const none = diskWorkflowStore(empty, null, {
        XDG_CONFIG_HOME: join(empty, "home"),
        DWA_BUILTIN_DIR: "",
      });
      expect(none.list()).toEqual([]);
      expect(none.draft({ kind: "run", id: 1, name: "x" })).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("opening it records what was written by hand in both places", () => {
    expect(store.history({ name: "feature", source: "project" })).toMatchObject({
      current: 1,
      versions: [{ n: 1 }],
    });
    expect(store.history({ name: "mine", source: "user" }).versions).toHaveLength(1);
    expect(existsSync(project("history", "workflows", "feature"))).toBe(true);
    expect(existsSync(home("history", "workflows", "feature"))).toBe(true);
  });

  test("reads a file by place and name, and a bare name as the one a run uses", () => {
    expect(store.read({ name: "feature", source: "project" })).toBe(projectText("feature"));
    expect(store.read({ name: "feature", source: "user" })).toBe(personalText("feature"));
    expect(store.read("feature")).toBe(projectText("feature"));
    expect(store.read("mine")).toBe(personalText("mine"));
    expect(() => store.read({ name: "mine", source: "project" })).toThrow(
      'Unknown project workflow "mine".',
    );
    expect(() => store.read("nobody")).toThrow('Unknown workflow "nobody".');
  });

  test("saves a valid text as a new version and refuses one that is not", () => {
    const ref = { name: "feature", source: "project" } as const;
    const next = workflow("Changed", ["explore", "build", "review"]);
    expect(store.save(ref, next)).toBe(2);
    expect(projectText("feature")).toBe(next);
    expect(store.history(ref)).toMatchObject({
      current: 2,
      versions: [{ n: 1 }, { n: 2, source: "workflow designer" }],
    });
    expect(personalText("feature")).toBe(workflow("My feature"));

    expect(() => store.save(ref, '[steps.a]\ndepends_on = ["nobody"]\nprompt = "x"\n')).toThrow(
      "nobody",
    );
    expect(() => store.save(ref, "not toml [")).toThrow();
    expect(projectText("feature")).toBe(next);
    expect(store.history(ref).versions).toHaveLength(2);
  });

  test("a change made in an editor while it was open gets its own version under a save", () => {
    const ref = { name: "mine", source: "user" } as const;
    writeFileSync(home("workflows", "mine.toml"), workflow("By hand"));
    expect(store.save(ref, workflow("From the designer"))).toBe(3);
    expect(store.history(ref).versions.map((version) => version.source)).toEqual([
      expect.any(String),
      "edited by hand",
      "workflow designer",
    ]);
    expect(store.diff(ref, 1, 2)).toContain('+ description = "By hand"');
  });

  test("saving the text the file already has makes no version and says where the file is", () => {
    const ref = { name: "feature", source: "project" } as const;
    expect(store.save(ref, projectText("feature"))).toBe(1);
    expect(store.history(ref).versions).toHaveLength(1);
  });

  test("creates a workflow in the place asked for", () => {
    store.create("notes", workflow("Notes"), "user");
    expect(personalText("notes")).toBe(workflow("Notes"));
    expect(existsSync(project("workflows", "notes.toml"))).toBe(false);
    store.create("ship", workflow("Ship"), "project");
    expect(projectText("ship")).toBe(workflow("Ship"));
    expect(places()).toContainEqual(["notes", "user", false]);
    expect(places()).toContainEqual(["ship", "project", false]);
    expect(store.history({ name: "ship", source: "project" })).toMatchObject({
      current: 1,
      versions: [{ n: 1 }],
    });
  });

  test("refuses to create over a name that is taken in either place, or from a bad text", () => {
    expect(() => store.create("feature", workflow("x"), "project")).toThrow(
      'There is already a workflow "feature".',
    );
    expect(() => store.create("mine", workflow("x"), "project")).toThrow(
      'There is already a personal workflow "mine".',
    );
    expect(() => store.create("bad name", workflow("x"), "project")).toThrow(
      "cannot be a workflow name",
    );
    expect(() => store.create("empty", "", "project")).toThrow();
    expect(existsSync(project("workflows", "empty.toml"))).toBe(false);
    expect(places()).toHaveLength(3);
  });

  test("a copy is kept where the original is unless a place is given", () => {
    store.duplicate({ name: "mine", source: "user" }, "mine-2");
    expect(personalText("mine-2")).toBe(personalText("mine"));
    store.duplicate({ name: "mine", source: "user" }, "ours", "project");
    expect(projectText("ours")).toBe(personalText("mine"));
    store.duplicate({ name: "feature", source: "project" }, "feature-2");
    expect(projectText("feature-2")).toBe(projectText("feature"));
    store.duplicate({ name: "feature", source: "project" }, "private", "user");
    expect(personalText("private")).toBe(projectText("feature"));
    expect(() => store.duplicate({ name: "feature", source: "project" }, "mine")).toThrow(
      "already",
    );
    expect(() => store.duplicate({ name: "nobody", source: "project" }, "copy")).toThrow("Unknown");
  });

  test("a rename keeps the text, the place and the history", () => {
    const text = projectText("feature");
    store.save({ name: "feature", source: "project" }, workflow("Second"));
    store.rename({ name: "feature", source: "project" }, "delivery");
    expect(projectText("delivery")).toBe(workflow("Second"));
    expect(existsSync(project("workflows", "feature.toml"))).toBe(false);
    const renamed = { name: "delivery", source: "project" } as const;
    expect(store.history(renamed).versions).toHaveLength(2);
    store.switchTo(renamed, 1);
    expect(projectText("delivery")).toBe(text);
    // The personal one of the old name is no longer hidden.
    expect(places()).toEqual([
      ["delivery", "project", false],
      ["feature", "user", false],
      ["mine", "user", false],
    ]);
    expect(() => store.rename(renamed, "mine")).toThrow("already");
    expect(() => store.rename(renamed, "not a name")).toThrow("cannot be a workflow name");
    expect(existsSync(project("workflows", "delivery.toml"))).toBe(true);
  });

  test("moves a workflow between the project and the personal folder, with its history", () => {
    store.save({ name: "mine", source: "user" }, workflow("Mine, again"));
    store.move({ name: "mine", source: "user" }, "project");
    expect(projectText("mine")).toBe(workflow("Mine, again"));
    expect(existsSync(home("workflows", "mine.toml"))).toBe(false);
    expect(store.history({ name: "mine", source: "project" }).versions).toHaveLength(2);
    store.move({ name: "mine", source: "project" }, "user");
    expect(personalText("mine")).toBe(workflow("Mine, again"));
    expect(places()).toContainEqual(["mine", "user", false]);

    // Not onto a file of the same name, and not to where it already is.
    const before = personalText("feature");
    expect(() => store.move({ name: "feature", source: "project" }, "user")).toThrow();
    expect(personalText("feature")).toBe(before);
    expect(existsSync(project("workflows", "feature.toml"))).toBe(true);
    expect(() => store.move({ name: "mine", source: "user" }, "user")).toThrow("already personal");
  });

  test("removing a file keeps its versions and brings a hidden one out", () => {
    store.remove({ name: "feature", source: "project" });
    expect(existsSync(project("workflows", "feature.toml"))).toBe(false);
    expect(readdirSync(project("history", "workflows", "feature")).length).toBeGreaterThan(0);
    expect(places()).toEqual([
      ["feature", "user", false],
      ["mine", "user", false],
    ]);
    expect(() => store.remove({ name: "feature", source: "project" })).toThrow("Unknown");
  });

  test("says what a change means outside the project's files", () => {
    const ours = { name: "feature", source: "project" } as const;
    expect(store.warnings("delete", ours)).toEqual([
      'Your personal workflow "feature" is hidden by this one and will be the one used here afterwards.',
    ]);
    expect(store.warnings("rename", ours)).toHaveLength(1);
    expect(store.warnings("move", ours)).toEqual([
      'Others who use this project will no longer have workflow "feature".',
    ]);
    const mine = { name: "mine", source: "user" } as const;
    expect(store.warnings("delete", mine)[0]).toContain("Other projects");
    expect(store.warnings("move", mine)[0]).toContain("roles");
    store.create("alone", workflow("Alone"), "project");
    expect(store.warnings("delete", { name: "alone", source: "project" })).toEqual([]);
  });

  test("shows the versions, what differs between two, and switches to one", () => {
    const ref = { name: "feature", source: "project" } as const;
    const first = projectText("feature");
    const second = workflow("Second", ["explore", "build"]);
    store.save(ref, second);
    store.save(ref, workflow("Third", ["explore"]));

    const history = store.history(ref);
    expect(history.current).toBe(3);
    expect(history.versions.map((version) => version.n)).toEqual([1, 2, 3]);

    const diff = store.diff(ref, 1, 2);
    expect(diff).toContain('- description = "Ours"');
    expect(diff).toContain('+ description = "Second"');
    expect(store.diff(ref, 2, 2)).toEqual(["No differences."]);
    expect(() => store.diff(ref, 1, 9)).toThrow();

    store.switchTo(ref, 2);
    expect(projectText("feature")).toBe(second);
    // Switching moves the pointer; no version goes away.
    expect(store.history(ref).current).toBe(2);
    expect(store.history(ref).versions.map((version) => version.n)).toEqual([1, 2, 3]);
    store.switchTo(ref, 1);
    expect(projectText("feature")).toBe(first);
    expect(() => store.switchTo(ref, 9)).toThrow();
    expect(projectText("feature")).toBe(first);
  });

  test("a version that is no longer a valid workflow is not switched to", () => {
    writeFileSync(project("workflows", "old.toml"), "[steps.a]\nrole = 5\n");
    store = open();
    const ref = { name: "old", source: "project" } as const;
    store.save(ref, workflow("Put right"));
    expect(() => store.switchTo(ref, 1)).toThrow();
    expect(projectText("old")).toBe(workflow("Put right"));
  });

  test("offers the names a step can pick from", () => {
    mkdirSync(project("roles"), { recursive: true });
    writeFileSync(project("roles", "developer.toml"), 'description = "Writes code"\n');
    mkdirSync(home("roles"), { recursive: true });
    writeFileSync(home("roles", "scribe.toml"), 'description = "Takes notes"\n');
    for (const skill of [
      project("skills", "handover"),
      join(dir, ".claude", "skills", "release"),
      home("skills", "handover"),
      home("skills", "own"),
    ]) {
      mkdirSync(skill, { recursive: true });
      writeFileSync(join(skill, "SKILL.md"), "# skill\n");
    }
    // A folder without a skill file is not a skill.
    mkdirSync(project("skills", "empty"), { recursive: true });
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { notes: {} } }));
    const config = {
      profiles: { me: {}, work: {} },
      mcp: { github: {} },
      plugins: { linter: {} },
    } as unknown as Config;
    const choices = open(config).choices();
    expect(choices.roles.sort()).toEqual(["developer", "scribe"]);
    expect(choices.profiles).toEqual(["me", "work"]);
    expect(choices.mcp).toEqual(["github"]);
    expect(choices.plugins).toEqual(["linter"]);
    expect(choices.skills.sort()).toEqual(["handover", "own", "release"]);
    expect(choices.projectMcp).toEqual(["notes"]);
  });

  test("without a config, roles, skills or servers there is nothing to pick from", () => {
    expect(store.choices()).toEqual({
      roles: [],
      profiles: [],
      mcp: [],
      plugins: [],
      skills: [],
      projectMcp: [],
    });
    writeFileSync(join(dir, ".mcp.json"), "{ not json");
    expect(store.choices().projectMcp).toEqual([]);
  });

  test("the templates it offers are the workflows dwa ships", () => {
    const templates = store.templates();
    expect(templates.map((template) => template.name)).toContain("feature");
    for (const template of templates) expect(template.text).toContain("[steps.");
  });
});

describe("drafts", () => {
  const file: DesignTarget = { kind: "file", name: "feature", source: "project" };
  const personal: DesignTarget = { kind: "file", name: "feature", source: "user" };
  const run: DesignTarget = { kind: "run", id: 7, name: "feature" };
  const draft = (target: DesignTarget, text: string): Draft => ({
    v: 1,
    target,
    base: "base\n",
    text,
    undo: ["base\n"],
    redo: [],
    renames: { a: "b" },
    savedAt: "2026-01-02T03:04:05.000Z",
  });

  test("each target has its own file under the run folder", () => {
    const drafts = join("/p", ".dwa", "run", "drafts");
    expect(draftPath("/p", file)).toBe(join(drafts, "workflow-project-feature.json"));
    expect(draftPath("/p", personal)).toBe(join(drafts, "workflow-personal-feature.json"));
    expect(draftPath("/p", run)).toBe(join(drafts, "run-7.json"));
    expect(draftPath("/p", { ...file, fresh: true })).toBe(draftPath("/p", file));
  });

  test("a draft that was put is read back, one per target, and nothing else is written", () => {
    expect(store.draft(file)).toBeNull();
    store.putDraft(draft(file, "ours"));
    store.putDraft(draft(personal, "mine"));
    store.putDraft(draft(run, "the run's"));
    expect(store.draft(file)).toEqual(draft(file, "ours"));
    expect(store.draft(personal)?.text).toBe("mine");
    expect(store.draft(run)?.text).toBe("the run's");
    expect(readdirSync(project("run", "drafts")).sort()).toEqual([
      "run-7.json",
      "workflow-personal-feature.json",
      "workflow-project-feature.json",
    ]);
    // The workflow itself is as it was.
    expect(projectText("feature")).toBe(workflow("Ours", ["explore", "build"]));
    expect(store.history({ name: "feature", source: "project" }).versions).toHaveLength(1);
  });

  test("a later draft replaces the earlier one and survives the store being opened again", () => {
    store.putDraft(draft(file, "one"));
    store.putDraft(draft(file, "two"));
    expect(open().draft(file)?.text).toBe("two");
    expect(readdirSync(project("run", "drafts"))).toEqual(["workflow-project-feature.json"]);
  });

  test("clearing removes one target's draft, and is fine when there is none", () => {
    store.putDraft(draft(file, "ours"));
    store.putDraft(draft(run, "the run's"));
    store.clearDraft(file);
    expect(store.draft(file)).toBeNull();
    expect(store.draft(run)?.text).toBe("the run's");
    expect(() => store.clearDraft(file)).not.toThrow();
    expect(() => store.clearDraft(personal)).not.toThrow();
  });

  test("a broken draft file, or one of another shape, reads as none", () => {
    const path = draftPath(dir, file);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, '{"v":1,"text":"half');
    expect(store.draft(file)).toBeNull();
    writeFileSync(path, JSON.stringify({ ...draft(file, "x"), v: 2 }));
    expect(store.draft(file)).toBeNull();
    writeFileSync(path, JSON.stringify({ v: 1, text: 5 }));
    expect(store.draft(file)).toBeNull();
    writeFileSync(path, "null");
    expect(store.draft(file)).toBeNull();
    // Putting one over it works again.
    store.putDraft(draft(file, "whole"));
    expect(store.draft(file)?.text).toBe("whole");
  });
});

describe("the shipped templates", () => {
  test("are read by name with their description, and a file that is not valid is left out", () => {
    const templates = join(dir, "templates");
    mkdirSync(templates);
    writeFileSync(join(templates, "zeta.toml"), workflow("Last"));
    writeFileSync(join(templates, "alpha.toml"), '[steps.work]\nprompt = "{{input}}"\n');
    writeFileSync(join(templates, "broken.toml"), '[steps.a]\ndepends_on = ["nobody"]\n');
    writeFileSync(join(templates, "garbage.toml"), "not toml [");
    writeFileSync(join(templates, "readme.md"), "# no\n");
    expect(readTemplates(templates)).toEqual([
      { name: "alpha", description: "", text: '[steps.work]\nprompt = "{{input}}"\n' },
      { name: "zeta", description: "Last", text: workflow("Last") },
    ]);
  });

  test("a folder that is not there has none, and the real one has the feature workflow", () => {
    expect(readTemplates(join(dir, "nowhere"))).toEqual([]);
    const feature = readTemplates().find((template) => template.name === "feature");
    expect(feature?.description).toBe("Explore the code, implement the change, review it");
    expect(feature?.text).toContain("[steps.review]");
  });
});
