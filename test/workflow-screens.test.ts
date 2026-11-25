// The screens around the workflow designer as data: which rows they show and what their
// buttons do to the work in hand and to the files, with a store that lives in memory.
import { describe, expect, test } from "bun:test";
import type { History } from "../src/shared/history.ts";
import type { Scope } from "../src/shared/scope.ts";
import type { WorkflowRef } from "../src/shared/workflow-edit.ts";
import {
  apply,
  type DesignTarget,
  dirty,
  newSession,
  redo,
  type Session,
  undo,
  view,
} from "../src/ui/designer-model.ts";
import { OFF, ON, type Outcome, type Row, type Screen, type Values } from "../src/ui/wizard.ts";
import {
  addStepScreen,
  closeScreen,
  type DesignDeps,
  type DesignerHandle,
  designListScreen,
  draftOf,
  newWorkflowScreen,
  openDesign,
  PANEL,
  type PanelActions,
  panelScreen,
  saveScreen,
  staleScreen,
} from "../src/ui/workflow-screens.ts";
import type { Draft, Template, WorkflowStore } from "../src/ui/workflow-store.ts";

type Button = Extract<Row, { kind: "button" }>;
type FileTarget = DesignTarget & { kind: "file" };

const FEATURE = `# The team's usual way.
description = "Explore, build, review"

[steps.explore]
role = "explore"
prompt = "Look around: {{input}}"

[steps.build]
role = "developer"
depends_on = ["explore"]
prompt = "Build it: {{steps.explore.result}}"

[steps.review]
role = "reviewer"
depends_on = ["build"]
reviews = "build"
prompt = "Review it"
`;
const PLAIN = '[steps.work]\nprompt = "{{input}}"\n';
const TEMPLATE: Template = {
  name: "pair",
  description: "Two steps",
  text: '[steps.a]\nprompt = "{{input}}"\n\n[steps.b]\ndepends_on = ["a"]\nprompt = "Then"\n',
};

const button = (screen: Screen, label: string): Button => {
  const found = screen.rows.find(
    (row): row is Button => row.kind === "button" && row.label.startsWith(label),
  );
  if (!found) {
    throw new Error(`no button "${label}" on "${screen.title}": ${labels(screen, "button")}`);
  }
  return found;
};
const labels = (screen: Screen, kind: Row["kind"]) =>
  screen.rows.flatMap((row) => (row.kind === kind && "label" in row ? [row.label] : []));
/** The notes and headings of a screen, a note that follows the form as it reads now. */
const texts = (screen: Screen) =>
  screen.rows.flatMap((row) =>
    row.kind === "note"
      ? [row.live ? row.live({ ...screen.values }) : row.text]
      : row.kind === "heading"
        ? [row.text]
        : [],
  );
const hint = (screen: Screen, label: string) => button(screen, label).hint;
/** Presses a button with the screen's own values, changed by `values`. */
const press = async (screen: Screen, label: string, values: Values = {}): Promise<Outcome> =>
  button(screen, label).run({ ...screen.values, ...values });
async function next(screen: Screen, label: string, values: Values = {}): Promise<Screen> {
  const outcome = await press(screen, label, values);
  if (!("to" in outcome)) throw new Error(`"${label}" did not lead to a screen`);
  return outcome.to;
}

const keyOf = (ref: WorkflowRef, files: Map<string, string>): string => {
  if (typeof ref !== "string" && ref.source) return `${ref.source}:${ref.name}`;
  const name = typeof ref === "string" ? ref : ref.name;
  return files.has(`project:${name}`) ? `project:${name}` : `user:${name}`;
};
const draftKey = (target: DesignTarget) =>
  target.kind === "run" ? `run:${target.id}` : `${target.source}:${target.name}`;

/** A store in memory: files by place and name, their versions, drafts, and what was asked. */
function fakeStore(initial: Record<string, string> = { "project:feature": FEATURE }) {
  const files = new Map(Object.entries(initial));
  const versions = new Map<string, string[]>();
  for (const [key, text] of files) versions.set(key, [text]);
  const current = new Map<string, number>();
  const drafts = new Map<string, Draft>();
  const calls: string[] = [];
  const broken = new Map<string, string>();
  const need = (ref: WorkflowRef): string => {
    const key = keyOf(ref, files);
    if (!files.has(key)) throw new Error(`Unknown workflow "${key}".`);
    return key;
  };
  const free = (name: string) => {
    for (const key of files.keys()) {
      if (key.endsWith(`:${name}`)) throw new Error(`There is already a workflow "${name}".`);
    }
  };
  const put = (key: string, text: string): number => {
    files.set(key, text);
    const list = [...(versions.get(key) ?? []), text];
    versions.set(key, list);
    current.set(key, list.length);
    return list.length;
  };
  const store: WorkflowStore = {
    list: () =>
      [...files.keys()].sort().map((key) => {
        const [source, name] = key.split(":") as [Scope, string];
        const design = view(files.get(key) ?? "", name);
        return {
          name,
          source,
          hidden: source === "user" && files.has(`project:${name}`),
          description: design.definition?.description ?? null,
          steps: Object.keys(design.definition?.steps ?? {}),
          error: broken.get(key) ?? null,
        };
      }),
    read: (ref) => {
      calls.push(`read ${keyOf(ref, files)}`);
      return files.get(need(ref)) as string;
    },
    save: (ref, text) => {
      calls.push(`save ${keyOf(ref, files)}`);
      return put(need(ref), text);
    },
    create: (name, text, where) => {
      calls.push(`create ${where}:${name}`);
      free(name);
      put(`${where}:${name}`, text);
    },
    duplicate: (from, to, where) => {
      const origin = need(from);
      const place = where ?? (origin.split(":")[0] as Scope);
      calls.push(`duplicate ${origin} -> ${place}:${to}`);
      free(to);
      put(`${place}:${to}`, files.get(origin) as string);
    },
    rename: (from, to) => {
      const origin = need(from);
      calls.push(`rename ${origin} -> ${to}`);
      free(to);
      const key = `${origin.split(":")[0]}:${to}`;
      files.set(key, files.get(origin) as string);
      versions.set(key, versions.get(origin) ?? []);
      files.delete(origin);
    },
    move: (ref, to) => {
      const origin = need(ref);
      calls.push(`move ${origin} -> ${to}`);
      const key = `${to}:${origin.split(":")[1]}`;
      if (files.has(key)) throw new Error("There is one there already.");
      files.set(key, files.get(origin) as string);
      versions.set(key, versions.get(origin) ?? []);
      files.delete(origin);
    },
    remove: (ref) => {
      calls.push(`remove ${need(ref)}`);
      files.delete(need(ref));
    },
    warnings: (action, ref) => [`Warning about the ${action} of ${keyOf(ref, files)}.`],
    history: (ref): History => {
      const key = need(ref);
      const list = versions.get(key) ?? [];
      return {
        current: current.get(key) ?? list.length,
        versions: list.map((_, at) => ({
          n: at + 1,
          time: "2026-01-02T03:04:05.000Z",
          source: at === 0 ? "first version" : "workflow designer",
          hash: String(at),
        })),
      };
    },
    diff: (ref, from, to) => [`diff of ${keyOf(ref, files)} v${from}..v${to}`],
    switchTo: (ref, n) => {
      const key = need(ref);
      calls.push(`switch ${key} v${n}`);
      files.set(key, (versions.get(key) ?? [])[n - 1] as string);
      current.set(key, n);
    },
    templates: () => [TEMPLATE],
    choices: () => ({
      roles: ["developer", "explore", "reviewer"],
      profiles: [],
      mcp: [],
      plugins: [],
      skills: [],
      projectMcp: [],
    }),
    draft: (target) => drafts.get(draftKey(target)) ?? null,
    putDraft: (draft) => {
      drafts.set(draftKey(draft.target), draft);
    },
    clearDraft: (target) => {
      calls.push(`clearDraft ${draftKey(target)}`);
      drafts.delete(draftKey(target));
    },
  };
  return { store, files, drafts, calls, broken };
}

const HOME: Screen = { title: "The list", rows: [] };

function fakeDeps(initial?: Record<string, string>) {
  const fake = fakeStore(initial);
  const started: Session[] = [];
  const deps: DesignDeps = {
    api: {
      roles: [],
      profiles: [],
      call: async () => {
        throw new Error("no daemon");
      },
    },
    store: fake.store,
    start: (session) => {
      started.push(session);
      return async () => ({ close: true });
    },
    home: () => HOME,
  };
  return { ...fake, deps, started };
}

/** The designer as the screens see it, on a session held here. */
function fakeDesigner(start: Session) {
  let session = start;
  const handle: DesignerHandle = {
    session: () => session,
    design: () => view(session.text, session.target.name),
    apply: (op) => {
      session = apply(session, op);
    },
    set: (next) => {
      session = next;
    },
    undo: () => {
      session = undo(session);
    },
    redo: () => {
      session = redo(session);
    },
  };
  const shape = () =>
    handle.design().steps.map((step) => `${step.id}<-${step.dependsOn.join(",")}`);
  const step = (id: string) => {
    const found = handle.design().steps.find((other) => other.id === id);
    if (!found) throw new Error(`no step ${id}`);
    return found;
  };
  return { handle, shape, step };
}

const DESELECTED: Outcome = { replace: { title: "deselected", rows: [] } };
function fakeActions() {
  const asked: string[] = [];
  const say = (what: string): Outcome => {
    asked.push(what);
    return what === "deselect" ? DESELECTED : { back: true };
  };
  const actions: PanelActions = {
    move: (id) => say(`move ${id}`),
    link: (id) => say(`link ${id}`),
    editPrompt: (id) => say(`editPrompt ${id}`),
    save: () => say("save"),
    close: () => say("close"),
    deselect: () => say("deselect"),
  };
  return { actions, asked };
}

const feature: FileTarget = { kind: "file", name: "feature", source: "project" };
const draft = (target: DesignTarget, base: string, text: string): Draft => ({
  v: 1,
  target,
  base,
  text,
  undo: [base],
  redo: [],
  renames: { build: "make" },
  savedAt: "2026-01-02T03:04:05.000Z",
});

describe("the list of workflows to design", () => {
  test("lists every file with its place and what it does, and a broken one with why", () => {
    const { deps, broken } = fakeDeps({
      "project:feature": FEATURE,
      "user:feature": PLAIN,
      "user:plain": PLAIN,
      "project:odd": "[steps.a]\n",
    });
    broken.set("project:odd", "steps.a.prompt is missing");
    const screen = designListScreen(deps);
    expect(screen.title).toBe("Workflow designer");
    expect(
      screen.rows.flatMap((row) =>
        row.kind === "button" ? [[row.label, row.hint, row.tone]] : [],
      ),
    ).toEqual([
      ["feature", "project · Explore, build, review", undefined],
      ["odd", "project · cannot be run yet: steps.a.prompt is missing", "attention"],
      ["feature", "personal · hidden by the project's workflow · work", undefined],
      ["plain", "personal · work", undefined],
      ["New workflow…", undefined, "good"],
      ["Close", undefined, undefined],
    ]);
    expect(texts(screen)).not.toContain("No workflows yet.");
  });

  test("says so when there are none, and still offers a new one", async () => {
    const { deps } = fakeDeps({});
    const screen = designListScreen(deps);
    expect(texts(screen)).toContain("No workflows yet.");
    expect(labels(screen, "button")).toEqual(["New workflow…", "Close"]);
    expect((await next(screen, "New workflow…")).title).toBe("New workflow");
    expect(await press(screen, "Close")).toEqual({ close: true });
  });

  test("a workflow opens in the designer on its file's text, the one of the place listed", async () => {
    const { deps, started } = fakeDeps({ "project:feature": FEATURE, "user:feature": PLAIN });
    const screen = designListScreen(deps);
    const rows = screen.rows.filter((row): row is Button => row.kind === "button");
    expect(await rows[0]?.run({})).toHaveProperty("view");
    expect(await rows[1]?.run({})).toHaveProperty("view");
    expect(started.map((session) => [session.target, session.text])).toEqual([
      [{ kind: "file", name: "feature", source: "project" }, FEATURE],
      [{ kind: "file", name: "feature", source: "user" }, PLAIN],
    ]);
    expect(started.every((session) => !dirty(session) && session.undo.length === 0)).toBe(true);
  });
});

describe("starting a new workflow", () => {
  test("asks for a name and a place, then what to start from", () => {
    const { deps, broken } = fakeDeps({
      "project:feature": FEATURE,
      "user:plain": PLAIN,
      "project:odd": "[steps.a]\n",
    });
    broken.set("project:odd", "broken");
    const screen = newWorkflowScreen(deps);
    expect(screen.title).toBe("New workflow");
    expect(screen.rows.slice(0, 2)).toMatchObject([
      { kind: "input", key: "name" },
      { kind: "choice", key: "where", label: "Where the workflow is kept" },
    ]);
    expect(texts(screen).filter(Boolean)).toEqual(["START FROM", "OR A COPY OF"]);
    // A file that cannot be run is not offered to copy.
    expect(labels(screen, "button")).toEqual([
      "An empty workflow",
      "Template: pair",
      "Describe it to an agent…",
      "feature",
      "plain",
      "Back",
    ]);
    expect(hint(screen, "Template: pair")).toBe("Two steps");
    expect(hint(screen, "feature")).toBe("project · Explore, build, review");
    expect(hint(screen, "plain")).toBe("personal");
  });

  test("without workflows there is nothing to copy", () => {
    const screen = newWorkflowScreen(fakeDeps({}).deps);
    expect(texts(screen)).not.toContain("OR A COPY OF");
    expect(labels(screen, "button")).toEqual([
      "An empty workflow",
      "Template: pair",
      "Describe it to an agent…",
      "Back",
    ]);
  });

  test("refuses a missing name, one that cannot be a name and one that is taken", async () => {
    const { deps, started, calls } = fakeDeps({ "project:feature": FEATURE, "user:plain": PLAIN });
    const screen = newWorkflowScreen(deps);
    for (const label of ["An empty workflow", "Template: pair", "feature"]) {
      expect(() => button(screen, label).run({ name: "  " })).toThrow("Type a name first.");
      expect(() => button(screen, label).run({ name: "two words" })).toThrow(
        "A name uses letters, digits, - and _ (up to 40).",
      );
      expect(() => button(screen, label).run({ name: "feature" })).toThrow(
        'There is already a workflow "feature".',
      );
      // Taken in the other place too: a second file of a name would hide one of the two.
      expect(() => button(screen, label).run({ name: "plain", where: "project" })).toThrow(
        'There is already a workflow "plain".',
      );
    }
    expect(started).toEqual([]);
    expect(calls.filter((call) => !call.startsWith("read"))).toEqual([]);
  });

  test("an empty workflow opens in the designer and is not written yet", async () => {
    const { deps, started, files, calls } = fakeDeps();
    const outcome = await press(newWorkflowScreen(deps), "An empty workflow", {
      name: " ship ",
      where: "user",
    });
    expect(outcome).toHaveProperty("view");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      target: { kind: "file", name: "ship", source: "user", fresh: true },
      text: "",
      base: "",
    });
    expect([...files.keys()]).toEqual(["project:feature"]);
    expect(calls).toEqual([]);
  });

  test("a template is written under the name, in the place chosen, and opened", async () => {
    const { deps, started, files } = fakeDeps();
    const outcome = await press(newWorkflowScreen(deps), "Template: pair", {
      name: "duo",
      where: "user",
    });
    expect(outcome).toHaveProperty("view");
    expect(files.get("user:duo")).toBe(TEMPLATE.text);
    expect(started[0]?.target).toEqual({ kind: "file", name: "duo", source: "user" });
    expect(started[0]?.text).toBe(TEMPLATE.text);
    // Without a choice it goes into the project.
    await press(newWorkflowScreen(deps), "Template: pair", { name: "duo-2" });
    expect(files.get("project:duo-2")).toBe(TEMPLATE.text);
  });

  test("a copy has the original's text and its own place", async () => {
    const { deps, started, files } = fakeDeps();
    await press(newWorkflowScreen(deps), "feature", { name: "mine", where: "user" });
    expect(files.get("user:mine")).toBe(FEATURE);
    expect(files.get("project:feature")).toBe(FEATURE);
    expect(started[0]).toMatchObject({
      target: { kind: "file", name: "mine", source: "user" },
      text: FEATURE,
    });
    expect(await press(newWorkflowScreen(deps), "Back")).toEqual({ back: true });
  });
});

describe("opening a workflow in the designer", () => {
  test("without a draft it opens on the file's text", () => {
    const { deps, started, calls } = fakeDeps();
    expect(openDesign(deps, feature)).toHaveProperty("view");
    expect(started).toEqual([newSession(feature, FEATURE)]);
    expect(calls).toEqual(["read project:feature"]);
  });

  test("a file that is not there is an error to show", () => {
    const { deps, started } = fakeDeps();
    expect(() => openDesign(deps, { kind: "file", name: "gone", source: "project" })).toThrow(
      "Unknown workflow",
    );
    expect(started).toEqual([]);
  });

  test("a new workflow opens empty without reading a file", () => {
    const { deps, started, calls } = fakeDeps();
    const fresh: FileTarget = { kind: "file", name: "ship", source: "project", fresh: true };
    expect(openDesign(deps, fresh)).toHaveProperty("view");
    expect(started).toEqual([newSession(fresh, "")]);
    expect(calls).toEqual([]);
  });

  test("a draft that says what the file says is dropped without asking", () => {
    const { deps, started, drafts, store } = fakeDeps();
    store.putDraft(draft(feature, PLAIN, FEATURE));
    expect(openDesign(deps, feature)).toHaveProperty("view");
    expect(started).toEqual([newSession(feature, FEATURE)]);
    expect(drafts.size).toBe(0);
  });

  test("unsaved work is offered again, with what it changes", async () => {
    const { deps, started, drafts, store } = fakeDeps();
    const mine = FEATURE.replace("Review it", "Review it twice");
    store.putDraft(draft(feature, FEATURE, mine));
    const outcome = openDesign(deps, feature);
    if (!("to" in outcome)) throw new Error("no screen");
    const screen = outcome.to;
    expect(started).toEqual([]);
    expect(screen.title).toBe("Unsaved work on feature (project)");
    const notes = texts(screen);
    expect(notes[0]).toBe("There are changes from 2026-01-02 03:04 that were not saved.");
    expect(notes).toHaveLength(2);
    expect(notes[1]).toStartWith("Your unsaved changes:\n");
    expect(notes[1]).toContain('- prompt = "Review it"');
    expect(notes[1]).toContain('+ prompt = "Review it twice"');
    expect(labels(screen, "button")).toEqual([
      "Continue where I left off",
      "Drop them and start from the file",
      "Back",
    ]);

    expect(await press(screen, "Continue")).toHaveProperty("view");
    expect(started[0]).toEqual({
      target: feature,
      base: FEATURE,
      text: mine,
      undo: [FEATURE],
      redo: [],
      selected: null,
      renames: { build: "make" },
    });
    // Still a draft until it is saved or dropped.
    expect(drafts.size).toBe(1);
    expect(await press(screen, "Back")).toEqual({ back: true });
  });

  test("dropping the unsaved work starts from the file", async () => {
    const { deps, started, drafts, store } = fakeDeps();
    store.putDraft(draft(feature, FEATURE, PLAIN));
    const outcome = openDesign(deps, feature);
    if (!("to" in outcome)) throw new Error("no screen");
    expect(await press(outcome.to, "Drop them")).toHaveProperty("view");
    expect(started).toEqual([newSession(feature, FEATURE)]);
    expect(drafts.size).toBe(0);
  });

  test("when the file changed since, that is shown too and the work goes on from the file", async () => {
    const { deps, started, store } = fakeDeps();
    const old = FEATURE.replace("Explore, build, review", "As it was");
    const mine = old.replace("Review it", "Review it twice");
    store.putDraft(draft(feature, old, mine));
    const outcome = openDesign(deps, feature);
    if (!("to" in outcome)) throw new Error("no screen");
    const screen = outcome.to;
    const notes = texts(screen);
    expect(notes).toHaveLength(4);
    expect(notes[1]).toStartWith("The file has changed since then.");
    expect(screen.rows[1]).toMatchObject({ tone: "attention" });
    expect(notes[2]).toStartWith("What changed in the file:\n");
    expect(notes[2]).toContain('+ description = "Explore, build, review"');
    expect(notes[3]).toContain('+ prompt = "Review it twice"');
    expect(notes[3]).not.toContain("description");

    await press(screen, "Continue");
    // What is saved later is counted from the file as it is now.
    expect(started[0]).toMatchObject({ base: FEATURE, text: mine, undo: [old] });
  });

  test("a session is kept as a draft with everything needed to go on", () => {
    const session = apply(newSession(feature, FEATURE), {
      op: "renameStep",
      from: "build",
      to: "make",
    });
    expect(draftOf(session, new Date("2026-03-04T05:06:07.000Z"))).toEqual({
      v: 1,
      target: feature,
      base: FEATURE,
      text: session.text,
      undo: [FEATURE],
      redo: [],
      renames: { build: "make" },
      savedAt: "2026-03-04T05:06:07.000Z",
    });
  });
});

describe("a new step", () => {
  const setup = () => {
    const { store } = fakeStore();
    return { store, ...fakeDesigner(newSession(feature, FEATURE)) };
  };

  test("asks for a name, offering a free one, and the role it runs as", () => {
    const { store, handle } = setup();
    const screen = addStepScreen(handle, store, { below: "review" });
    expect(screen.title).toBe("New step");
    expect(screen.values).toEqual({ name: "step" });
    expect(texts(screen)[0]).toStartWith("It starts when review is done.");
    expect(labels(screen, "input")).toEqual(["Name"]);
    expect(labels(screen, "button")).toEqual([
      "developer",
      "explore",
      "reviewer",
      "No role",
      "Back",
    ]);
    handle.apply({ op: "addStep", id: "step", fields: {} });
    expect(addStepScreen(handle, store, {}).values).toEqual({ name: "step-2" });
  });

  test("says where the step goes", () => {
    const { store, handle } = setup();
    const where = (place: Parameters<typeof addStepScreen>[2]) =>
      texts(addStepScreen(handle, store, place))[0]?.split("\n")[0];
    expect(where({})).toBe("It depends on nothing yet; put it in place on the picture.");
    expect(where({ below: null })).toBe(
      "It depends on nothing yet; put it in place on the picture.",
    );
    expect(where({ edge: { from: "explore", to: "build" } })).toBe(
      "It goes between explore and build.",
    );
  });

  test("a role adds the step under the step named and goes back", async () => {
    const { store, handle, shape, step } = setup();
    const screen = addStepScreen(handle, store, { below: "build" });
    expect(await press(screen, "developer", { name: " test " })).toEqual({ back: true });
    expect(shape()).toContain("test<-build");
    expect(step("test").fields.role).toBe("developer");
    expect(handle.session().selected).toEqual({ kind: "step", id: "test" });
    // One step, one thing to take back.
    handle.undo();
    expect(handle.session().text).toBe(FEATURE);
  });

  test("without a role and a place it is a step of its own", async () => {
    const { store, handle, shape, step } = setup();
    await press(addStepScreen(handle, store, {}), "No role");
    expect(shape()).toContain("step<-");
    expect(step("step").fields.role).toBeUndefined();
  });

  test("on a line it goes between the two steps", async () => {
    const { store, handle, shape } = setup();
    const screen = addStepScreen(handle, store, { edge: { from: "explore", to: "build" } });
    expect(await press(screen, "reviewer", { name: "check" })).toEqual({ back: true });
    expect(shape()).toEqual(["explore<-", "check<-explore", "build<-check", "review<-build"]);
  });

  test("refuses no name, a name that is taken and one that cannot be a name", () => {
    const { store, handle } = setup();
    const screen = addStepScreen(handle, store, { below: "build" });
    expect(() => button(screen, "developer").run({ name: " " })).toThrow("Type a name first.");
    expect(() => button(screen, "No role").run({ name: "build" })).toThrow(
      'There is already a step "build".',
    );
    expect(() => button(screen, "No role").run({ name: "a b" })).toThrow("cannot be a step name");
    expect(handle.session().text).toBe(FEATURE);
  });
});

describe("the panel for the workflow as a whole", () => {
  const setup = (target: DesignTarget = feature, text = FEATURE) => {
    const fake = fakeDeps();
    const designer = fakeDesigner(newSession(target, text));
    const panel = fakeActions();
    const screen = () => panelScreen(fake.deps, designer.handle, panel.actions);
    return { ...fake, ...designer, ...panel, screen };
  };

  test("shows the description and what can be done with the workflow and its file", () => {
    const { screen } = setup();
    const panel = screen();
    expect(panel.title).toBe("feature (project)");
    expect(panel.rows[0]).toEqual({ kind: "heading", text: "FEATURE (PROJECT)" });
    expect(panel.values).toEqual({ [PANEL.description]: "Explore, build, review" });
    expect(labels(panel, "input")).toEqual(["Description"]);
    expect(labels(panel, "button")).toEqual([
      "Add a step…",
      "Save…",
      "Undo",
      "Redo",
      "History…",
      "Rename…",
      "Duplicate…",
      "Move to your personal folder…",
      "Delete…",
      "Close",
    ]);
  });

  test("a workflow that is not written yet, and a run, have no file to manage", () => {
    const fresh = setup({ ...feature, fresh: true }, "").screen();
    const run = setup({ kind: "run", id: 3, name: "feature" }).screen();
    expect(run.title).toBe("run #3 of feature");
    for (const panel of [fresh, run]) {
      const buttons = labels(panel, "button");
      expect(buttons).toContain("Add a step…");
      expect(buttons).toContain("Save…");
      expect(buttons).toContain("Close");
      for (const label of ["History…", "Rename…", "Duplicate…", "Delete…"]) {
        expect(buttons).not.toContain(label);
      }
      expect(buttons.some((label) => label.startsWith("Move"))).toBe(false);
    }
  });

  test("the note at the top follows what is wrong with the workflow itself", () => {
    const { screen, handle } = setup({ ...feature, fresh: true }, "");
    const panel = screen();
    const before = texts(panel)[1];
    expect(before).toBeTruthy();
    handle.apply({ op: "addStep", id: "work", fields: { prompt: "{{input}}" } });
    // The same rows, read again after the change.
    expect(texts(panel)[1]).toBe("");
    // What is wrong with one step is shown at that step, not here.
    handle.apply({ op: "setFields", id: "work", changes: { depends_on: ["nobody"] } });
    expect(handle.design().problems).toHaveLength(1);
    expect(texts(panel)[1]).toBe("");
  });

  test("adds a step after the last one, or a first one", async () => {
    const { screen } = setup();
    expect(texts(await next(screen(), "Add a step…"))[0]).toStartWith(
      "It starts when review is done.",
    );
    const empty = setup({ ...feature, fresh: true }, "");
    expect(texts(await next(empty.screen(), "Add a step…"))[0]).toStartWith(
      "It depends on nothing yet",
    );
  });

  test("save and close are the designer's, undo and redo go through it", async () => {
    const { screen, handle, asked } = setup();
    handle.apply({ op: "setDescription", description: "Changed" });
    const changed = handle.session().text;
    expect(await press(screen(), "Undo")).toEqual({ back: true });
    expect(handle.session().text).toBe(FEATURE);
    expect(await press(screen(), "Redo")).toEqual({ back: true });
    expect(handle.session().text).toBe(changed);
    await press(screen(), "Save…");
    await press(screen(), "Close");
    expect(asked).toEqual(["save", "close"]);
  });

  test("the file is not managed while there are unsaved changes", () => {
    const { screen, handle, calls } = setup();
    handle.apply({ op: "setDescription", description: "Changed" });
    const panel = screen();
    for (const label of ["History…", "Rename…", "Duplicate…", "Move to your personal folder…"]) {
      expect(() => button(panel, label).run({})).toThrow("Save or undo your changes first.");
    }
    expect(calls).toEqual([]);
  });

  test("history shows the versions, and switching to one loads its text", async () => {
    const { screen, handle, store, files } = setup();
    const second = FEATURE.replace("Review it", "Review it twice");
    store.save(feature, second);
    handle.set(newSession(feature, second));
    const history = await next(screen(), "History…");
    expect(history.title).toBe("History: feature");
    expect(labels(history, "button")).toEqual(["* v2", "  v1", "Back"]);
    const first = await next(history, "  v1");
    expect(texts(first).join("\n")).toContain("diff of project:feature v2..v1");
    const switched = await next(first, "Switch to this version");
    expect(texts(switched)).toEqual([
      "Workflow feature is at v1 now. Runs already started keep their own copy.",
    ]);
    expect(files.get("project:feature")).toBe(FEATURE);
    expect(handle.session()).toEqual(newSession(feature, FEATURE));
  });

  test("a rename moves the file and the designer goes on with the new name", async () => {
    const { screen, handle, files } = setup();
    const rename = await next(screen(), "Rename…");
    expect(rename.title).toBe("Rename feature");
    expect(texts(rename)[0]).toBe(
      "Runs already started keep the old name.\nWarning about the rename of project:feature.",
    );
    expect(() => button(rename, "Rename").run({ name: "" })).toThrow("Type a name first.");
    expect(await press(rename, "Rename", { name: "delivery" })).toEqual({ back: true });
    expect([...files.keys()]).toEqual(["project:delivery"]);
    expect(handle.session()).toEqual(
      newSession({ kind: "file", name: "delivery", source: "project" }, FEATURE),
    );
    expect(panelTitle(screen())).toBe("delivery (project)");
  });

  test("a copy is made where asked and the designer goes on with the copy", async () => {
    const { screen, handle, files } = setup();
    const copy = await next(screen(), "Duplicate…");
    expect(copy.title).toBe("Copy of feature");
    // It starts at the place the original is kept.
    expect(copy.values).toEqual({ where: "project" });
    expect(await press(copy, "Create", { name: "mine", where: "user" })).toEqual({ back: true });
    expect(files.get("user:mine")).toBe(FEATURE);
    expect(files.get("project:feature")).toBe(FEATURE);
    expect(handle.session()).toEqual(
      newSession({ kind: "file", name: "mine", source: "user" }, FEATURE),
    );
  });

  // DEFECT (src/ui/workflow-screens.ts, "Duplicate…" in `workflowPanel`, which calls `nameScreen`
  // from src/ui/role-screens.ts:238; the row is built at role-screens.ts:252 with
  // `scopeRow("role")`): the screen that copies a workflow asks "Where the role is kept".
  // `nameScreen` has no way to be told what is being named.
  test("the copy screen asks where the workflow is kept, not a role", async () => {
    const copy = await next(setup().screen(), "Duplicate…");
    expect(labels(copy, "choice")).toEqual(["Where the workflow is kept"]);
  });

  test("a move is confirmed first, with what it means", async () => {
    const { screen, handle, files, calls } = setup();
    const confirm = await next(screen(), "Move to your personal folder…");
    expect(confirm.title).toBe("Move feature");
    expect(texts(confirm)[0]).toBe(
      [
        "The file goes to your personal dwa folder and leaves the project.",
        "Its history moves with it, and the name stays.",
        "Warning about the move of project:feature.",
      ].join("\n"),
    );
    expect(calls.filter((call) => call.startsWith("move"))).toEqual([]);
    expect(await press(confirm, "Move it to my personal folder")).toEqual({ back: true });
    expect([...files.keys()]).toEqual(["user:feature"]);
    expect(handle.session()).toEqual(
      newSession({ kind: "file", name: "feature", source: "user" }, FEATURE),
    );

    // And back again from there.
    const panel = screen();
    expect(panel.title).toBe("feature (personal)");
    const back = await next(panel, "Move into the project…");
    expect(texts(back)[0]).toStartWith("The file goes into the project, for everyone who uses it.");
    await press(back, "Move it into the project");
    expect([...files.keys()]).toEqual(["project:feature"]);
    expect(handle.session().target).toEqual(feature);
  });

  test("deleting is confirmed, removes the file and its draft, and returns to the list", async () => {
    const { screen, files, drafts, store, calls } = setup();
    store.putDraft(draft(feature, FEATURE, PLAIN));
    const confirm = await next(screen(), "Delete…");
    expect(confirm.title).toBe("Delete feature?");
    expect(texts(confirm)[0]).toBe(
      "The file is removed. Its versions stay in the history folder.\nWarning about the delete of project:feature.",
    );
    expect(files.size).toBe(1);
    expect(await press(confirm, "Back")).toEqual({ back: true });
    expect(calls.filter((call) => call.startsWith("remove"))).toEqual([]);
    expect(await press(confirm, "Yes, delete it")).toEqual({ home: HOME });
    expect(files.size).toBe(0);
    expect(drafts.size).toBe(0);
  });
});

const panelTitle = (screen: Screen) => screen.title;

describe("the panel for a step", () => {
  const setup = (id = "build", text = FEATURE) => {
    const fake = fakeDeps();
    const designer = fakeDesigner({
      ...newSession(feature, text),
      selected: { kind: "step", id },
    });
    const panel = fakeActions();
    const screen = () => panelScreen(fake.deps, designer.handle, panel.actions);
    return { ...fake, ...designer, ...panel, screen };
  };

  test("shows what the step is set to", () => {
    const panel = setup().screen();
    expect(panel.title).toBe("build");
    expect(panel.rows[0]).toEqual({ kind: "heading", text: "STEP build" });
    expect(hint(panel, "Name")).toBe("build ›");
    expect(hint(panel, "Role")).toBe("developer ›");
    expect(hint(panel, "Model")).toBe("inherit ›");
    expect(hint(panel, "Effort")).toBe("inherit ›");
    expect(hint(panel, "Starts after")).toBe("explore ›");
    expect(hint(panel, "Reviews")).toBe("nothing ›");
    expect(hint(panel, "More settings…")).toBe("tools, MCP, plugins, skills, rules");
    expect(panel.values).toEqual({
      [PANEL.keep]: OFF,
      [PANEL.prompt]: "Build it: {{steps.explore.result}}",
    });
    expect(labels(panel, "check")).toEqual(["Keeps its agent"]);
    // No profiles to choose from and none set: nothing to show.
    expect(labels(panel, "button")).not.toContain("Profile");
  });

  test("shows a review, a first step and what a step has of its own", () => {
    const review = setup("review").screen();
    expect(hint(review, "Reviews")).toBe("build, up to 3 passes ›");
    expect(hint(setup("explore").screen(), "Starts after")).toBe("nothing: at the start ›");

    const { screen, handle } = setup("review");
    handle.apply({
      op: "setFields",
      id: "review",
      changes: {
        max_rounds: 5,
        keep_agent: true,
        model: "opus",
        tools: ["Read"],
        profile: "work",
      },
    });
    const panel = screen();
    expect(hint(panel, "Reviews")).toBe("build, up to 5 passes ›");
    expect(hint(panel, "Model")).toBe("opus ›");
    expect(hint(panel, "Profile")).toBe("work ›");
    expect(panel.values?.[PANEL.keep]).toBe(ON);
    // The model and the effort have rows of their own and are not counted.
    expect(hint(panel, "More settings…")).toStartWith("1 set here");
  });

  test("the prompt can take the run's input and the results of the steps before it", () => {
    const inserts = (id: string) => {
      const row = setup(id)
        .screen()
        .rows.find((other) => other.kind === "text");
      return row?.kind === "text" ? row : undefined;
    };
    expect(inserts("explore")).toMatchObject({
      key: PANEL.prompt,
      inserts: [{ label: "input", text: "{{input}}" }],
    });
    const review = inserts("review")?.inserts ?? [];
    expect(review[0]).toEqual({ label: "input", text: "{{input}}" });
    expect(review.slice(1).sort((a, b) => a.label.localeCompare(b.label))).toEqual([
      { label: "build", text: "{{steps.build.result}}" },
      { label: "explore", text: "{{steps.explore.result}}" },
    ]);
  });

  test("the note at the top follows what is wrong with this step", () => {
    const { screen, handle } = setup("build");
    const panel = screen();
    expect(texts(panel)[1]).toBe("");
    handle.apply({ op: "setFields", id: "build", changes: { depends_on: [] } });
    expect(texts(panel)[1]).toBe(
      'step "build" uses the result of "explore" but does not depend on it',
    );
  });

  test("a rename is followed through the workflow", async () => {
    const { screen, handle, shape } = setup();
    const rename = await next(screen(), "Name");
    expect(rename.title).toBe("Rename step build");
    expect(rename.values).toEqual({ name: "build" });
    expect(() => button(rename, "Rename").run({ name: "review" })).toThrow(
      'There is already a step "review".',
    );
    expect(await press(rename, "Rename", { name: "make" })).toEqual({ back: true });
    expect(shape()).toEqual(["explore<-", "make<-explore", "review<-make"]);
    expect(handle.session().selected).toEqual({ kind: "step", id: "make" });
    expect(screen().title).toBe("make");
  });

  test("the role is picked from the project's roles, or taken away", async () => {
    const { screen, step } = setup();
    const pick = await next(screen(), "Role");
    expect(pick.title).toBe("Role of build");
    expect(labels(pick, "button")).toEqual([
      "  No role",
      "* developer",
      "  explore",
      "  reviewer",
      "Back",
    ]);
    expect(await press(pick, "  reviewer")).toEqual({ back: true });
    expect(step("build").fields.role).toBe("reviewer");
    await press(await next(screen(), "Role"), "  No role");
    expect(step("build").fields.role).toBeUndefined();
    expect(hint(screen(), "Role")).toBe("none ›");
    expect(labels(await next(screen(), "Role"), "button")[0]).toBe("* No role");
  });

  test("a role the project does not have is still shown as the one set", async () => {
    const { screen, handle } = setup();
    handle.apply({ op: "setFields", id: "build", changes: { role: "stranger" } });
    expect(labels(await next(screen(), "Role"), "button")).toContain("* stranger");
  });

  test("model, effort and profile are picked or left to the role", async () => {
    const { screen, step, handle } = setup();
    const model = await next(screen(), "Model");
    expect(labels(model, "button")).toEqual(["* Inherit", "  opus", "  sonnet", "  haiku", "Back"]);
    await press(model, "  sonnet");
    expect(step("build").fields.model).toBe("sonnet");
    await press(await next(screen(), "Model"), "  Inherit");
    expect(step("build").fields.model).toBeUndefined();

    const effort = await next(screen(), "Effort");
    const level = labels(effort, "button")[1] as string;
    await press(effort, level);
    expect(step("build").fields.effort).toBe(level.trim());
    expect(hint(screen(), "Effort")).toBe(`${level.trim()} ›`);

    handle.apply({ op: "setFields", id: "build", changes: { profile: "work" } });
    const profile = await next(screen(), "Profile");
    expect(labels(profile, "button")).toEqual(["  Inherit", "Back"]);
    await press(profile, "  Inherit");
    expect(step("build").fields.profile).toBeUndefined();
  });

  test("what it starts after is ticked from the steps that do not come after it", async () => {
    const { screen, handle, shape } = setup();
    handle.apply({ op: "addStep", id: "docs", fields: {} });
    handle.set({ ...handle.session(), selected: { kind: "step", id: "build" } });
    const depends = await next(screen(), "Starts after");
    expect(depends.title).toBe("build starts after");
    // Not itself, and not review, which waits for it.
    expect(labels(depends, "check")).toEqual(["explore", "docs"]);
    expect(depends.values).toEqual({ explore: ON, docs: OFF });
    expect(await press(depends, "Apply", { explore: OFF, docs: ON })).toEqual({ back: true });
    expect(shape()).toContain("build<-docs");
    await press(await next(screen(), "Starts after"), "Apply", { docs: OFF });
    expect(shape()).toContain("build<-");
  });

  test("a step is made the review of an earlier one, with its passes", async () => {
    const { screen, handle, step } = setup("build");
    const review = await next(screen(), "Reviews");
    expect(review.title).toBe("What build reviews");
    expect(review.values).toEqual({ rounds: "3" });
    expect(labels(review, "button")).toEqual(["  explore", "* Nothing: an ordinary step", "Back"]);
    expect(hint(review, "  explore")).toBeUndefined();
    for (const rounds of ["0", "1.5", "many", "-2"]) {
      expect(() => button(review, "  explore").run({ rounds })).toThrow(
        "The passes are a whole number, 1 or more.",
      );
    }
    expect(handle.session().text).toBe(FEATURE);

    // The usual number of passes is not written down.
    expect(await press(review, "  explore")).toEqual({ back: true });
    expect(step("build")).toMatchObject({ reviews: "explore" });
    expect(step("build").fields.max_rounds).toBeUndefined();

    const again = await next(screen(), "Reviews");
    expect(labels(again, "button").slice(0, 2)).toEqual([
      "* explore",
      "  Nothing: an ordinary step",
    ]);
    await press(again, "* explore", { rounds: " 5 " });
    expect(step("build").fields.max_rounds).toBe(5);
    expect(hint(screen(), "Reviews")).toBe("explore, up to 5 passes ›");

    await press(await next(screen(), "Reviews"), "  Nothing");
    expect(step("build").reviews).toBeUndefined();
    expect(step("build").fields.max_rounds).toBeUndefined();
    expect(handle.design().problems).toEqual([]);
  });

  test("reviewing a step it does not follow yet says it will then wait for it", async () => {
    const { screen, handle, step } = setup();
    handle.apply({ op: "addStep", id: "docs", fields: {} });
    handle.set({ ...handle.session(), selected: { kind: "step", id: "docs" } });
    const review = await next(screen(), "Reviews");
    expect(hint(review, "  build")).toBe("also makes it depend on that step");
    await press(review, "  build");
    expect(step("docs")).toMatchObject({ reviews: "build", dependsOn: ["build"] });
  });

  test("choosing nothing for an ordinary step changes nothing", async () => {
    const { screen, handle } = setup();
    const review = await next(screen(), "Reviews");
    expect(await press(review, "* Nothing")).toEqual({ back: true });
    expect(handle.session().text).toBe(FEATURE);
    expect(handle.session().undo).toEqual([]);
  });

  test("more settings are the step's own, written into the workflow's text", async () => {
    const { screen, step, handle } = setup();
    const settings = await next(screen(), "More settings…");
    expect(settings.title).toBe("Settings of step build");
    expect(await press(settings, "Apply")).toEqual({ back: true });
    expect(handle.session().text).toBe(FEATURE);
    expect(await press(settings, "Apply", { permission_mode: "plan" })).toEqual({ back: true });
    expect(step("build").fields.permission_mode).toBe("plan");
    expect(hint(screen(), "More settings…")).toStartWith("1 set here");
  });

  test("moving, drawing a line and the editor are the designer's to do", async () => {
    const { screen, asked } = setup();
    const panel = screen();
    await press(panel, "Move it…");
    await press(panel, "Draw a line from it…");
    await press(panel, "Open the prompt in $EDITOR");
    expect(await press(panel, "The whole workflow")).toBe(DESELECTED);
    expect(asked).toEqual(["move build", "link build", "editPrompt build", "deselect"]);
  });

  test("a step is added after it, and deleting it lets go of it", async () => {
    const { screen, shape, asked } = setup();
    expect(texts(await next(screen(), "Add a step after it…"))[0]).toStartWith(
      "It starts when build is done.",
    );
    expect(await press(screen(), "Delete the step")).toBe(DESELECTED);
    expect(shape()).toEqual(["explore<-", "review<-explore"]);
    expect(asked).toEqual(["deselect"]);
    // With the step gone the panel is the workflow's again.
    expect(screen().title).toBe("feature (project)");
  });
});

describe("the panel for a line", () => {
  const setup = (selected: Session["selected"]) => {
    const fake = fakeDeps();
    const designer = fakeDesigner({ ...newSession(feature, FEATURE), selected });
    const panel = fakeActions();
    const screen = () => panelScreen(fake.deps, designer.handle, panel.actions);
    return { ...fake, ...designer, ...panel, screen };
  };

  test("a dependency can take a new step or be removed", async () => {
    const { screen, shape } = setup({ kind: "edge", from: "explore", to: "build" });
    const panel = screen();
    expect(panel.title).toBe("explore → build");
    expect(texts(panel)).toEqual(["LINE explore → build", "build starts when explore is done."]);
    expect(labels(panel, "button")).toEqual([
      "Put a new step here…",
      "Remove this line",
      "The whole workflow",
    ]);
    const add = await next(panel, "Put a new step here…");
    expect(texts(add)[0]).toStartWith("It goes between explore and build.");
    await press(add, "No role", { name: "check" });
    expect(shape()).toEqual(["explore<-", "check<-explore", "build<-check", "review<-build"]);
  });

  test("removing the line ends the waiting and lets go of the line", async () => {
    const { screen, shape, asked } = setup({ kind: "edge", from: "explore", to: "build" });
    expect(hint(screen(), "Remove this line")).toBe("build no longer waits for explore");
    expect(await press(screen(), "Remove this line")).toBe(DESELECTED);
    expect(shape()).toEqual(["explore<-", "build<-", "review<-build"]);
    expect(asked).toEqual(["deselect"]);
  });

  test("a review can be changed or ended", async () => {
    const { screen, step, asked } = setup({ kind: "review", from: "review", to: "build" });
    const panel = screen();
    expect(panel.title).toBe("review reviews build");
    expect(texts(panel)).toEqual([
      "REVIEW review ↺ build",
      "review may send build back for another pass instead of completing.",
    ]);
    const change = await next(panel, "Change what it reviews, or the passes…");
    expect(change.title).toBe("What review reviews");
    expect(labels(change, "button").slice(0, 3)).toEqual([
      "  explore",
      "* build",
      "  Nothing: an ordinary step",
    ]);
    expect(await press(panel, "Stop reviewing")).toBe(DESELECTED);
    expect(step("review").reviews).toBeUndefined();
    expect(step("review").dependsOn).toEqual(["build"]);
    expect(asked).toEqual(["deselect"]);
    expect(await press(panel, "The whole workflow")).toBe(DESELECTED);
  });
});

describe("saving", () => {
  const setup = (target: DesignTarget = feature, text = FEATURE) => {
    const fake = fakeDeps();
    const designer = fakeDesigner(newSession(target, text));
    return { ...fake, ...designer };
  };

  test("is refused when nothing was changed", () => {
    const { deps, handle } = setup();
    expect(() => saveScreen(deps, handle)).toThrow("Nothing was changed.");
  });

  test("is refused while something is wrong, saying how much and what first", () => {
    const { deps, handle, calls } = setup();
    handle.apply({ op: "setFields", id: "build", changes: { depends_on: [] } });
    expect(() => saveScreen(deps, handle)).toThrow(
      'Not saved: one thing is still wrong. step "build" uses the result of "explore" but does not depend on it',
    );
    handle.apply({ op: "setFields", id: "explore", changes: { depends_on: ["nobody"] } });
    expect(() => saveScreen(deps, handle)).toThrow(/^Not saved: \d+ things are still wrong\. /);
    expect(calls).toEqual([]);
  });

  test("a run is not saved as a file", () => {
    const { deps, handle } = setup({ kind: "run", id: 3, name: "feature" });
    handle.apply({ op: "setDescription", description: "Changed" });
    expect(() => saveScreen(deps, handle)).toThrow("This is not a workflow file.");
  });

  test("shows what changes, writes it, and the work in hand is clean again", async () => {
    const { deps, handle, files, drafts, store } = setup();
    handle.apply({ op: "setDescription", description: "Changed" });
    const text = handle.session().text;
    store.putDraft(draftOf(handle.session()));
    const screen = saveScreen(deps, handle);
    expect(screen.title).toBe("Save feature (project)");
    expect(texts(screen)[0]).toStartWith("What changes in the file:\n");
    expect(texts(screen)[0]).toContain('+ description = "Changed"');
    expect(labels(screen, "button")).toEqual(["Save", "Back"]);
    // Nothing is written by looking.
    expect(files.get("project:feature")).toBe(FEATURE);
    expect(await press(screen, "Back")).toEqual({ back: true });

    const saved = await next(screen, "Save");
    expect(files.get("project:feature")).toBe(text);
    expect(drafts.size).toBe(0);
    expect(handle.session()).toEqual(newSession(feature, text));
    expect(saved.title).toBe("Saved");
    expect(texts(saved)[0]).toStartWith("Workflow feature is at v2.");
    expect(labels(saved, "button")).toEqual([
      "Back to the designer",
      "To the list of workflows",
      "Close",
    ]);
    expect(await press(saved, "Back to the designer")).toEqual({ back: true });
    expect(await press(saved, "To the list of workflows")).toEqual({ home: HOME });
    expect(await press(saved, "Close")).toEqual({ close: true });
    expect(() => saveScreen(deps, handle)).toThrow("Nothing was changed.");
  });

  test("a new workflow is created by its first save and is a file from then on", async () => {
    const fresh: FileTarget = { kind: "file", name: "ship", source: "user", fresh: true };
    const { deps, handle, files, calls } = setup(fresh, "");
    // Empty, it is not a workflow yet.
    expect(() => saveScreen(deps, handle)).toThrow("Not saved:");
    handle.apply({ op: "addStep", id: "work", fields: { prompt: "{{input}}" } });
    const text = handle.session().text;
    const screen = saveScreen(deps, handle);
    expect(screen.title).toBe("Save ship (personal)");
    expect(texts(screen)).toEqual(["A new personal workflow file is written."]);
    expect(labels(screen, "button")).toEqual(["Create the workflow", "Back"]);
    expect(files.has("user:ship")).toBe(false);

    const saved = await next(screen, "Create the workflow");
    expect(texts(saved)[0]).toStartWith("Workflow ship is at v1.");
    expect(files.get("user:ship")).toBe(text);
    expect(calls).toContain("create user:ship");
    expect(handle.session()).toEqual(
      newSession({ kind: "file", name: "ship", source: "user" }, text),
    );
    // The panel now has the file to manage.
    expect(labels(panelScreen(deps, handle, fakeActions().actions), "button")).toContain(
      "History…",
    );
  });

  test("a save that the store refuses leaves the work as it is", async () => {
    const { deps, handle, files, store, drafts } = setup();
    handle.apply({ op: "setDescription", description: "Changed" });
    store.putDraft(draftOf(handle.session()));
    const before = handle.session();
    const screen = saveScreen(deps, handle);
    files.delete("project:feature");
    expect(() => button(screen, "Save").run({})).toThrow("Unknown workflow");
    expect(handle.session()).toBe(before);
    expect(drafts.size).toBe(1);
  });
});

describe("a file that changed underneath", () => {
  const theirs = FEATURE.replace("Explore, build, review", "Theirs");
  const setup = () => {
    const designer = fakeDesigner(newSession(feature, FEATURE));
    designer.handle.apply({ op: "removeStep", id: "review" });
    return designer;
  };

  test("shows what changed in the file", () => {
    const { handle } = setup();
    const screen = staleScreen(handle, theirs);
    expect(screen.title).toBe("The file has changed");
    expect(screen.rows[0]).toMatchObject({ kind: "note", tone: "attention" });
    expect(texts(screen)[1]).toStartWith("What changed in the file:\n");
    expect(texts(screen)[1]).toContain('+ description = "Theirs"');
    // Not what was changed here.
    expect(texts(screen)[1]).not.toContain("steps.review");
    expect(labels(screen, "button")).toEqual([
      "Keep my changes",
      "Drop mine and load the file",
      "Back",
    ]);
  });

  test("keeping the work counts it from the file as it is now", async () => {
    const { handle } = setup();
    const mine = handle.session();
    expect(await press(staleScreen(handle, theirs), "Keep my changes")).toEqual({ back: true });
    expect(handle.session()).toEqual({ ...mine, base: theirs });
    expect(dirty(handle.session())).toBe(true);
    handle.undo();
    expect(handle.session().text).toBe(FEATURE);
  });

  test("dropping it loads the file with nothing to take back", async () => {
    const { handle } = setup();
    expect(await press(staleScreen(handle, theirs), "Drop mine")).toEqual({ back: true });
    expect(handle.session()).toEqual(newSession(feature, theirs));
  });

  test("going back leaves everything as it is", async () => {
    const { handle } = setup();
    const mine = handle.session();
    expect(await press(staleScreen(handle, theirs), "Back")).toEqual({ back: true });
    expect(handle.session()).toBe(mine);
  });

  test("a run's steps that changed are told as the run's", () => {
    const run = fakeDesigner(newSession({ kind: "run", id: 3, name: "feature" }, FEATURE));
    const screen = staleScreen(run.handle, theirs);
    expect(labels(screen, "button")).toHaveLength(3);
    expect(labels(screen, "button")[0]).toBe("Keep my changes");
    expect(texts(screen)[1]).toContain('+ description = "Theirs"');
  });
});

describe("leaving with unsaved work", () => {
  const setup = () => {
    const fake = fakeDeps();
    const designer = fakeDesigner(newSession(feature, FEATURE));
    designer.handle.apply({ op: "removeStep", id: "review" });
    fake.store.putDraft(draftOf(designer.handle.session()));
    return { ...fake, ...designer };
  };

  test("says the work is kept and offers to drop it", () => {
    const { deps, handle } = setup();
    const screen = closeScreen(deps, handle);
    expect(screen.title).toBe("Unsaved changes");
    expect(texts(screen)[0]).toContain("kept as a draft");
    expect(labels(screen, "button")).toEqual(["Leave them as a draft", "Drop the changes", "Back"]);
  });

  test("leaving keeps the draft and the file, and returns to the list", async () => {
    const { deps, handle, drafts, files } = setup();
    const mine = handle.session();
    expect(await press(closeScreen(deps, handle), "Leave them as a draft")).toEqual({
      home: HOME,
    });
    expect(drafts.get("project:feature")?.text).toBe(mine.text);
    expect(handle.session()).toBe(mine);
    expect(files.get("project:feature")).toBe(FEATURE);
    // Opening the workflow again offers the work.
    expect(openDesign(deps, feature)).toHaveProperty("to");
  });

  test("dropping clears the draft and the work, and returns to the list", async () => {
    const { deps, handle, drafts, files, started } = setup();
    expect(await press(closeScreen(deps, handle), "Drop the changes")).toEqual({ home: HOME });
    expect(drafts.size).toBe(0);
    expect(handle.session()).toEqual(newSession(feature, FEATURE));
    expect(files.get("project:feature")).toBe(FEATURE);
    expect(openDesign(deps, feature)).toHaveProperty("view");
    expect(started).toEqual([newSession(feature, FEATURE)]);
  });

  test("going back stays in the designer", async () => {
    const { deps, handle, drafts } = setup();
    expect(await press(closeScreen(deps, handle), "Back")).toEqual({ back: true });
    expect(drafts.size).toBe(1);
    expect(dirty(handle.session())).toBe(true);
  });
});
