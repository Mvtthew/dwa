// The workflow designer on screen: the picture of the steps on the left, a panel for whatever
// the cursor is on at the right, and a footer that says what is wrong and which keys work.
// Everything is done on the picture or in the panel; both work with the keyboard and the mouse.
import { BoxRenderable, bold, type CliRenderer, dim, type KeyEvent, RGBA } from "@opentui/core";
import {
  type Diagram,
  layoutDiagram,
  MARKS,
  neighbour,
  type Region,
  SLOT_MARK,
  sameRegion,
} from "../shared/diagram.ts";
import type { WorkflowRunInfo, WorkflowRunView } from "../shared/protocol.ts";
import { gesture, layersOf } from "./designer-gesture.ts";
import {
  apply,
  applyMore,
  type DesignView,
  dirty,
  linkOp,
  type Op,
  rebase,
  redo,
  type Session,
  undo,
  view as viewOf,
} from "./designer-model.ts";
import { createDiagramView } from "./diagram-view.ts";
import { fit, type Tone } from "./model.ts";
import { fetchRun, type RunActions, type RunLive, runPanel, runSaveScreen } from "./run-screens.ts";
import { createText, styled } from "./text.ts";
import { tone } from "./theme.ts";
import { createForm, OFF, ON, type Outcome, type Values, type View } from "./wizard.ts";
import {
  addStepScreen,
  closeScreen,
  type DesignDeps,
  type DesignerHandle,
  draftOf,
  PANEL,
  type PanelActions,
  panelScreen,
  saveScreen,
  staleScreen,
  targetTitle,
} from "./workflow-screens.ts";

/** How far a run is, in a line. */
function progress(run: WorkflowRunInfo): string {
  const count = (state: string) => run.steps.filter((step) => step.state === state).length;
  const parts = [`${count("done")} of ${run.steps.length} steps done`];
  if (count("running") > 0) parts.push(`${count("running")} running`);
  if (count("rejected") > 0) parts.push(`${count("rejected")} waiting for your decision`);
  if (count("failed") > 0) parts.push(`${count("failed")} failed`);
  return `Run #${run.id} is ${run.state}: ${parts.join(", ")}.`;
}

/** How often an open file, or a run, is looked at for changes made elsewhere. */
const STALE_CHECK_MS = 2000;
/** Columns of the panel at the right. */
const PANEL_WIDTH = 46;

export interface DesignerOptions extends DesignDeps {
  /**
   * Opens a text in the user's editor and gives back what it was left as, or null when the
   * editor did not end well. Without it the prompt is only edited in the panel.
   */
  editText?: (text: string, label: string) => Promise<string | null>;
  /** Milliseconds between looks at the file or the run for changes made elsewhere. */
  checkEvery?: number;
}

/** What the picture is being used for besides looking at it. */
type Mode =
  | { kind: "browse" }
  /** A step was picked up; `cursor` is the place it would go. */
  | { kind: "move"; id: string; cursor: number; dragging: boolean }
  /** A line is being drawn from a step; `to` is the step the cursor is on. */
  | { kind: "link"; from: string; to: string };

export interface Designer extends DesignerHandle {
  /** The designer as a view of a wizard; showing it again goes on from where it was. */
  view: View;
}

/**
 * A designer for one piece of work. It holds the session, so the screens it opens (rename,
 * save, history) change it through the handle and the view shows the result when it returns.
 */
export function createDesigner(
  options: DesignerOptions,
  first: Session,
  /** For a run: the run as it is now. Its steps are locked until the user asks to edit them. */
  started?: WorkflowRunView,
): Designer {
  let session = first;
  // Unsaved changes to a run's steps open as they were left: being edited.
  let live: RunLive | null = started ? { ...started, editing: dirty(first) } : null;
  const look = () => viewOf(session.text, session.target.name, live?.run);
  let design: DesignView = look();
  /** Called when the session changed while the view is up. */
  let changed: () => void = () => undefined;
  /** The field being typed in, so its changes are taken back as one. */
  let typing: string | null = null;

  const persist = () => {
    try {
      if (dirty(session)) options.store.putDraft(draftOf(session));
      else options.store.clearDraft(session.target);
    } catch {
      // A draft is a convenience; a folder that cannot be written must not stop the work.
    }
  };
  const put = (next: Session, keepTyping = false) => {
    if (next === session) return;
    const textChanged = next.text !== session.text || next.target !== session.target;
    session = next;
    if (!keepTyping) typing = null;
    if (textChanged) {
      design = look();
      persist();
    }
    changed();
  };
  /** Takes in what the daemon says the run is now. With `watch` the editing ends as well. */
  const take = (next: WorkflowRunView, watch = false) => {
    const editing = !watch && live?.editing === true && next.editable;
    live = { ...next, editing };
    // A run that is only watched always shows the steps it has.
    if (!editing && (session.text !== next.text || session.base !== next.text)) {
      session = rebase(session, next.text);
      typing = null;
    }
    design = look();
    persist();
    changed();
  };

  const handle: DesignerHandle = {
    session: () => session,
    design: () => design,
    apply: (op) => put(apply(session, op)),
    set: (next) => put(next),
    undo: () => put(undo(session)),
    redo: () => put(redo(session)),
  };

  const view: View = ({ renderer, parent }) =>
    new Promise<Outcome>((resolve) => {
      const up = mount(renderer, parent, resolve);
      changed = up.refresh;
    });

  function mount(
    renderer: CliRenderer,
    parent: Parameters<View>[0]["parent"],
    resolve: (outcome: Outcome) => void,
  ): { refresh: () => void } {
    const root = new BoxRenderable(renderer, {
      id: "designer-root",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      paddingX: 1,
    });
    const header = createText(renderer, "designer-header", 2);
    const body = new BoxRenderable(renderer, {
      id: "designer-body",
      flexDirection: "row",
      flexGrow: 1,
      flexShrink: 1,
    });
    const side = new BoxRenderable(renderer, {
      id: "designer-side",
      flexDirection: "column",
      width: Math.min(PANEL_WIDTH, Math.max(24, Math.floor(renderer.width * 0.45))),
      flexShrink: 0,
      marginLeft: 1,
      paddingLeft: 1,
      border: ["left"],
      // The terminal's own text colour: OpenTUI's default border is a fixed white.
      borderColor: RGBA.defaultForeground(),
    });
    const footer = createText(renderer, "designer-footer", 3);

    let focus: "picture" | "panel" = "picture";
    let mode: Mode = { kind: "browse" };
    let diagram: Diagram = layoutDiagram(design.input);
    let message: { text: string; tone: Tone } | null = null;
    /** The file's text when it is no longer what the work started from. */
    let fileStale: string | null = null;
    /** The same for a run whose steps are being edited: what the run has now. */
    const staleText = (): string | null =>
      live ? (live.editing && live.text !== session.base ? live.text : null) : fileStale;
    /** A run that is watched: nothing about its steps can be changed. */
    const locked = () => live !== null && !live.editing;
    const LOCKED = "Press e to change the steps of this run.";
    /** What the panel was last built for, so typing does not rebuild the field typed in. */
    let shown = "";
    let over = false;

    const say = (text: string, kind: Tone = "bad") => {
      message = { text, tone: kind };
    };
    const attempt = (work: () => void): boolean => {
      try {
        work();
        return true;
      } catch (error) {
        say((error as Error).message);
        paint();
        return false;
      }
    };
    const finish = (outcome: Outcome) => {
      if (over) return;
      over = true;
      clearInterval(timer);
      renderer.keyInput.off("keypress", onKey);
      changed = () => undefined;
      persist();
      form.destroy();
      picture.destroy();
      parent.remove(root);
      root.destroyRecursively();
      resolve(outcome);
    };
    /** Leaves the view for a screen of the wizard; coming back shows the view again. */
    const go = (screen: () => ReturnType<typeof saveScreen>) => {
      attempt(() => finish({ to: screen() }));
    };
    /** The same for a step that may take a moment or be refused. */
    const leave = async (make: () => Outcome | Promise<Outcome>) => {
      try {
        finish(await make());
      } catch (error) {
        say((error as Error).message);
        paint();
      }
    };
    /** Starts or ends the editing of a run's steps. */
    const setEditing = (on: boolean) => {
      if (!live) return;
      if (on && !live.editable) {
        throw new Error(`This run is ${live.run.state}; its steps can no longer be changed.`);
      }
      if (!on && dirty(session)) throw new Error("Save or undo your changes first.");
      live = { ...live, editing: on };
      if (!on) session = rebase(session, live.text);
      design = look();
      mode = { kind: "browse" };
      shown = "";
    };

    const select = (region: Region | null) => {
      handle.set({ ...session, selected: region });
    };
    const selectedStep = () => (session.selected?.kind === "step" ? session.selected.id : null);

    const actions: PanelActions = {
      move: (id) => {
        mode = { kind: "move", id, cursor: 0, dragging: false };
        focus = "picture";
        return { back: true };
      },
      link: (id) => {
        mode = { kind: "link", from: id, to: id };
        focus = "picture";
        return { back: true };
      },
      editPrompt: async (id) => {
        const step = design.steps.find((other) => other.id === id);
        if (!options.editText || !step) throw new Error("No editor can be opened from here.");
        const before = typeof step.fields.prompt === "string" ? step.fields.prompt : "";
        const after = await options.editText(before, `${session.target.name}-${id}-prompt.md`);
        if (after === null)
          throw new Error("The editor did not exit cleanly; nothing was changed.");
        if (after !== before) {
          // A prompt always ends its last line, so the closing quotes stand on their own.
          const prompt = after === "" || after.endsWith("\n") ? after : `${after}\n`;
          handle.apply({ op: "setFields", id, changes: { prompt } });
          shown = "";
        }
        return { back: true };
      },
      save: async () => {
        const other = staleText();
        if (other !== null) return { to: staleScreen(handle, other) };
        if (session.target.kind === "run") {
          return { to: await runSaveScreen(options, handle, (now) => take(now, true)) };
        }
        return { to: saveScreen(options, handle) };
      },
      close: async () =>
        dirty(session) ? { to: closeScreen(options, handle) } : { home: await options.home() },
      deselect: () => {
        select(null);
        focus = "picture";
        return { back: true };
      },
      watch: () => {
        setEditing(false);
        return { back: true };
      },
    };
    const runActions: RunActions = {
      edit: () => {
        setEditing(true);
        return { back: true };
      },
      reload: async () => {
        if (session.target.kind === "run") take(await fetchRun(options, session.target.id));
      },
      select: (id) => {
        select({ kind: "step", id });
        return { back: true };
      },
      deselect: actions.deselect,
      close: actions.close,
    };

    const form = createForm(renderer, {
      id: "designer-panel",
      width: () => side.width - 3,
      status: () => paintFooter(),
      outcome: (outcome) => {
        if ("back" in outcome) {
          shown = "";
          refresh();
        } else if ("replace" in outcome) {
          form.show(outcome.replace, true);
        } else {
          finish(outcome);
        }
      },
      changed: (values) => typed(values),
    });

    const picture = createDiagramView(renderer, "designer-picture", {
      press: (region) => {
        message = null;
        focus = "picture";
        if (mode.kind === "move") {
          if (region?.kind === "slot") return dropAt(region.index);
          mode = { kind: "browse" };
          return refresh();
        }
        if (mode.kind === "link") {
          const from = mode.from;
          mode = { kind: "browse" };
          if (region?.kind === "step") return link(from, region.id);
          return refresh();
        }
        select(region?.kind === "slot" ? null : region);
        refresh();
      },
      drag: (from, under) => {
        if (from?.kind !== "step" || locked()) return;
        // The places a step can go show as soon as it is dragged.
        const cursor = under?.kind === "slot" ? under.index : -1;
        if (mode.kind === "move" && mode.id === from.id && mode.cursor === cursor) return;
        mode = { kind: "move", id: from.id, cursor, dragging: true };
        refresh();
      },
      drop: (from, under) => {
        if (locked()) {
          say(LOCKED, "attention");
          return paint();
        }
        // `under` was read off the picture as it is drawn, places to put a step included.
        const op = gesture(design, diagram, from, under);
        mode = { kind: "browse" };
        if (op) change(op);
        else refresh();
      },
    });

    body.add(picture.box);
    side.add(form.list);
    body.add(side);
    root.add(header);
    root.add(body);
    root.add(footer);
    parent.add(root);

    function change(op: Op): void {
      message = null;
      if (!attempt(() => handle.apply(op))) return;
      refresh();
    }

    function dropAt(index: number): void {
      if (mode.kind !== "move") return;
      const slot = diagram.slots[index]?.slot;
      const id = mode.id;
      mode = { kind: "browse" };
      if (slot) change({ op: "drop", id, slot });
      else refresh();
    }

    function link(from: string, to: string): void {
      const op = linkOp(design, layersOf(diagram), from, to);
      if (op) change(op);
      else refresh();
    }

    /** What was typed or switched in the panel, as changes to the workflow. */
    function typed(values: Values): void {
      if (locked()) return;
      const id = selectedStep();
      const step = design.steps.find((other) => other.id === id);
      let op: Op | null = null;
      let field = "";
      if (step && id) {
        const prompt = typeof step.fields.prompt === "string" ? step.fields.prompt : "";
        const keep = step.fields.keep_agent === true ? ON : OFF;
        if (values[PANEL.prompt] !== undefined && values[PANEL.prompt] !== prompt) {
          op = { op: "setFields", id, changes: { prompt: values[PANEL.prompt] } };
          field = `${id}:prompt`;
        } else if (values[PANEL.keep] !== undefined && values[PANEL.keep] !== keep) {
          op = { op: "setFields", id, changes: { keep_agent: values[PANEL.keep] === ON } };
        }
      } else if (!session.selected) {
        const description = values[PANEL.description];
        if (description !== undefined && description !== design.description) {
          op = { op: "setDescription", description: description || null };
          field = "description";
        }
      }
      if (!op) return;
      const next = op;
      const more = field !== "" && typing === field;
      attempt(() => {
        // Letters typed one after another are one thing to take back.
        const after = more ? applyMore(session, next) : apply(session, next);
        const was = changed;
        // The panel is being typed in: it must not be rebuilt under the cursor.
        changed = () => undefined;
        put(after, true);
        changed = was;
        typing = field || null;
        shown = subject();
      });
      draw();
      paint();
    }

    function draw(): void {
      const selected = selectedStep();
      diagram = layoutDiagram(design.input, {
        selected: mode.kind === "link" ? mode.to : selected,
        origin: mode.kind === "link" ? mode.from : null,
        picked: session.selected?.kind === "step" ? null : session.selected,
        carrying: mode.kind === "move" ? mode.id : null,
        slotCursor: mode.kind === "move" ? mode.cursor : undefined,
      });
      picture.draw(diagram);
      const at = mode.kind === "link" ? mode.to : selected;
      const box = diagram.boxes.find((other) => other.id === at);
      // Not while a step is carried with the mouse: the picture then follows the pointer.
      if (box && !(mode.kind === "move" && mode.dragging)) {
        picture.reveal(box.x, box.y, box.width, box.height);
      }
    }

    function paintFooter(): void {
      const width = Math.max(10, renderer.width - 2);
      const count = design.problems.length;
      const first = design.problems[0]?.message ?? "";
      const status = message
        ? [tone(message.tone, fit(message.text, width))]
        : count > 0
          ? [
              tone(
                "bad",
                fit(
                  `${count === 1 ? "Not ready to save" : `${count} things to put right`}: ${first}`,
                  width,
                ),
              ),
            ]
          : live
            ? [dim(fit(progress(live.run), width))]
            : [dim(fit("Nothing is wrong with this workflow.", width))];
      const keys =
        mode.kind === "move"
          ? `${SLOT_MARK} marks where ${mode.id} can go: on a line between two steps, at a corner next to a step, under a step · ←→ choose · enter puts it there · esc leaves it`
          : mode.kind === "link"
            ? `line from ${mode.from}: ←→↑↓ choose a step · enter joins (down: it waits for ${mode.from}; up: ${mode.from} reviews it) · esc leaves it`
            : focus === "panel"
              ? "panel: ↑↓ and enter · esc back to the picture"
              : locked()
                ? "←→↑↓ steps · enter or tab: the panel · e edit the steps · q close"
                : `←→↑↓ steps · enter or tab: the panel · a add · m move · c line · del remove · u undo · U redo · s save · ${live ? "e stop editing · " : ""}q close`;
      footer.content = styled([
        status,
        [dim(fit(keys, width))],
        [
          dim(
            fit(
              locked()
                ? `○ waits   ● running   ✓ done   ✖ failed   ◆ needs you   – skipped   #N the pass it is on   ${MARKS.keepsAgent} keeps its agent`
                : `${MARKS.problem} something wrong   ${MARKS.keepsAgent} keeps its agent   ${MARKS.ownSettings} own settings   ×N review passes   drag a step to move or join it`,
              width,
            ),
          ),
        ],
      ]);
    }

    function paint(): void {
      const width = Math.max(10, renderer.width - 2);
      const steps = design.steps.length;
      const stale = staleText();
      const notes = [
        ...(live ? [live.run.state] : []),
        `${steps} step${steps === 1 ? "" : "s"}`,
        locked()
          ? live?.editable
            ? "live · e edits the steps"
            : "its steps can no longer be changed"
          : dirty(session)
            ? "unsaved changes (kept as a draft)"
            : live
              ? "editing · nothing changed yet"
              : "saved",
        ...(stale !== null ? [`THE ${live ? "RUN" : "FILE"} CHANGED ELSEWHERE: f shows what`] : []),
      ];
      header.content = styled([
        [bold(fit(`Workflow ${targetTitle(session.target)}`, width))],
        [
          stale !== null
            ? tone("attention", fit(notes.join(" · "), width))
            : dim(fit(notes.join(" · "), width)),
        ],
      ]);
      paintFooter();
    }

    /** Rebuilds what shows from the session: the picture, and the panel when its subject changed. */
    function refresh(): void {
      if (over) return;
      if (
        mode.kind === "move" &&
        !design.steps.some((step) => step.id === (mode as { id: string }).id)
      ) {
        mode = { kind: "browse" };
      }
      draw();
      if (subject() !== shown) {
        const keep = shown !== "" && sameSubject(shown, subject());
        shown = subject();
        form.show(
          live && !live.editing
            ? runPanel(options, handle, live, runActions)
            : panelScreen(options, handle, actions),
          keep,
        );
      }
      form.setActive(focus === "panel");
      paint();
    }

    /** What the panel is built from; when it changes, the panel is built again. */
    function subject(): string {
      // A watched run's panel shows how far it is, so it follows the run as well.
      return JSON.stringify([
        session.selected,
        session.target,
        session.text,
        live ? [live.editing, live.editable, locked() ? live.run : null] : null,
      ]);
    }

    /** True when two panel subjects are the same thing with another text: the place is kept. */
    function sameSubject(a: string, b: string): boolean {
      const [first] = JSON.parse(a) as [Region | null];
      const [second] = JSON.parse(b) as [Region | null];
      return sameRegion(first, second);
    }

    function moveCursor(direction: "up" | "down" | "left" | "right"): void {
      const from = mode.kind === "link" ? mode.to : selectedStep();
      const next = from
        ? neighbour(diagram, design.input, from, direction)
        : (diagram.boxes[0]?.id ?? null);
      if (!next) return;
      if (mode.kind === "link") mode = { ...mode, to: next };
      else select({ kind: "step", id: next });
      refresh();
    }

    function onKey(key: KeyEvent): void {
      if (over || form.busy()) return;
      message = null;
      const name = key.name;
      if (focus === "panel") {
        if (name === "escape") {
          focus = "picture";
          refresh();
          return;
        }
        form.key(key);
        return;
      }
      if (mode.kind === "move") {
        const count = diagram.slots.length;
        if (name === "escape") mode = { kind: "browse" };
        else if (name === "return" || name === "enter") {
          dropAt(mode.cursor);
          return;
        } else if (count > 0 && (name === "right" || name === "down")) {
          mode = { ...mode, cursor: (Math.max(-1, mode.cursor) + 1) % count };
        } else if (count > 0 && (name === "left" || name === "up")) {
          mode = { ...mode, cursor: (mode.cursor - 1 + count) % count };
        }
        refresh();
        return;
      }
      if (mode.kind === "link") {
        if (name === "escape") mode = { kind: "browse" };
        else if (name === "return" || name === "enter") {
          const { from, to } = mode;
          mode = { kind: "browse" };
          link(from, to);
          return;
        } else if (name === "up" || name === "down" || name === "left" || name === "right") {
          moveCursor(name);
          return;
        }
        refresh();
        return;
      }
      const step = selectedStep();
      if (name === "up" || name === "down" || name === "left" || name === "right") {
        moveCursor(name);
        return;
      }
      if (name === "return" || name === "enter" || name === "tab") {
        focus = "panel";
        refresh();
        return;
      }
      if (name === "escape") {
        if (session.selected) {
          select(null);
          refresh();
          return;
        }
        close();
        return;
      }
      if (name === "q") {
        close();
        return;
      }
      if (name === "e" && live) {
        const on = !live.editing;
        if (attempt(() => setEditing(on))) refresh();
        return;
      }
      if (locked()) {
        if (["a", "s", "u", "m", "c", "x", "delete", "backspace"].includes(name)) {
          say(LOCKED, "attention");
          paint();
        }
        return;
      }
      if (name === "a") {
        const below = step ?? design.steps.at(-1)?.id ?? null;
        go(() => addStepScreen(handle, options.store, { below }));
        return;
      }
      if (name === "s") {
        leave(() => actions.save());
        return;
      }
      const other = staleText();
      if (name === "f" && other !== null) {
        go(() => staleScreen(handle, other));
        return;
      }
      if (name === "u") {
        if (key.shift) handle.redo();
        else handle.undo();
        shown = "";
        refresh();
        return;
      }
      if (!step) return;
      if (name === "m") mode = { kind: "move", id: step, cursor: 0, dragging: false };
      else if (name === "c") mode = { kind: "link", from: step, to: step };
      else if (name === "delete" || name === "backspace" || name === "x") {
        change({ op: "removeStep", id: step });
        return;
      }
      refresh();
    }

    async function close(): Promise<void> {
      finish(await actions.close());
    }

    let asking = false;
    const check = () => {
      const { target } = session;
      if (target.kind === "run") {
        // Not while a button of the panel is at work: it may be changing the run itself.
        if (asking || form.busy()) return;
        asking = true;
        fetchRun(options, target.id)
          .then((now) => {
            if (!over) take(now);
          })
          // The daemon is away for a moment; the next look says more.
          .catch(() => undefined)
          .finally(() => {
            asking = false;
          });
        return;
      }
      if (target.fresh) return;
      try {
        const text = options.store.read(target);
        if (text !== session.base && !dirty(session)) {
          // Nothing of the user's is at stake, so the picture simply follows the file: an
          // agent that refines a workflow is seen at work.
          fileStale = null;
          put(rebase(session, text));
          say("The file was changed elsewhere; this is how it is now.", "attention");
          shown = "";
          refresh();
          return;
        }
        const next = text === session.base ? null : text;
        if (next === fileStale) return;
        fileStale = next;
        paint();
      } catch {
        // The file is gone or cannot be read; saving will say so.
      }
    };
    const timer = setInterval(check, options.checkEvery ?? STALE_CHECK_MS);
    timer.unref?.();

    renderer.keyInput.on("keypress", onKey);
    refresh();
    // A run may have moved on while another screen was up.
    if (live) check();
    return { refresh };
  }

  return { ...handle, view };
}
