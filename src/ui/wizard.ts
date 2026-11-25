// A small form engine for the wizards that open in a popup: a stack of screens, each a list of
// notes, buttons, text inputs, choices and switches. Everything can be clicked; the keyboard works too.
// The rows are a `Form`, which a larger view (the workflow designer) also uses for its own panel.
import {
  BoxRenderable,
  bold,
  type CliRenderer,
  dim,
  InputRenderable,
  InputRenderableEvents,
  type KeyEvent,
  type Renderable,
  RGBA,
  reverse,
  ScrollBoxRenderable,
  TextareaRenderable,
  type TextRenderable,
} from "@opentui/core";
import { fit, moveCursor, type Tone } from "./model.ts";
import { createText, styled } from "./text.ts";
import { accent, tone } from "./theme.ts";

/** What the form holds when a button is pressed: one string per input and choice, by key. */
export type Values = Record<string, string>;

/** What happens after a button: another screen, the previous one, the end, or a CLI command. */
export type Outcome =
  | { to: Screen }
  /**
   * Redraws the current screen from new rows. What the form holds is kept; the new screen's
   * `values` are laid over it, so they should name only what the redraw is meant to change.
   */
  | { replace: Screen }
  | { back: true }
  | { close: true }
  /** Ends the wizard and runs this dwa command in the same terminal (for `$EDITOR`). */
  | { exec: string[] }
  /**
   * Hands the whole popup to something that is not a list of rows. The wizard's screens stay
   * where they are and what the view resolves with is carried out as if a button had returned it,
   * with one difference: a screen a view goes `to` belongs to that view. Going back from it, or
   * leaving it with esc, shows the view again, and a view started from it takes its place. A
   * view that is done resolves with `home`.
   */
  | { view: View }
  /**
   * Ends a view for good: its screens go, and this screen is shown in place of the one the
   * view was opened from (a list that the view may have changed).
   */
  | { home: Screen };

/** A full-screen part of a wizard that draws itself and takes the keys until it resolves. */
export type View = (host: ViewHost) => Promise<Outcome>;

export interface ViewHost {
  renderer: CliRenderer;
  /** Where the view adds what it draws; it removes it again before it resolves. */
  parent: Renderable;
}

export type Row =
  | { kind: "heading"; text: string }
  | {
      kind: "note";
      text: string;
      tone?: Tone;
      /**
       * Makes the note follow the form: its text is worked out from the current values on every
       * repaint. It keeps the height of `text`, which is what it shows first.
       */
      live?: (values: Values) => string;
    }
  | {
      kind: "button";
      label: string;
      /** Shown dimmed after the label. */
      hint?: string;
      tone?: Tone;
      run: (values: Values) => Outcome | Promise<Outcome>;
    }
  | {
      /** A one-line switch. Its value is "on" or "off"; space, enter or a click changes it. */
      kind: "check";
      key: string;
      label: string;
      /** Shown dimmed after the label. */
      hint?: string;
      /** Says why the row cannot be switched; it is then shown but not changed. */
      fixed?: string;
      /** More about this row, reached with → or a click on the hint (which should end in ›). */
      more?: (values: Values) => Outcome | Promise<Outcome>;
    }
  | { kind: "input"; key: string; label: string; placeholder?: string }
  | {
      /** Text of several lines, typed in place. Tab leaves it; enter is a new line. */
      kind: "text";
      key: string;
      label: string;
      /** Lines of the field. */
      height: number;
      /** Pieces of text put in at the cursor by a click, or by alt and the piece's number. */
      inserts?: { label: string; text: string }[];
    }
  | { kind: "choice"; key: string; label: string; options: { value: string; label: string }[] };

export interface Screen {
  title: string;
  rows: Row[];
  /** Initial values of inputs and choices. A choice without one starts on its first option. */
  values?: Values;
}

interface RowNode {
  row: Row;
  box: BoxRenderable;
  text?: TextRenderable;
  input?: InputRenderable;
  area?: TextareaRenderable;
  chips?: TextRenderable[];
  /** The hint of a check row, which is clicked on its own. */
  aside?: TextRenderable;
}

const FOCUSABLE = new Set(["button", "input", "text", "choice", "check"]);

export const ON = "on";
export const OFF = "off";

export interface FormOptions {
  /** Start of the ids of what the form draws; two forms on one screen need different ones. */
  id: string;
  /** Columns a row may use. */
  width: () => number;
  /** After every repaint: what a footer shows, a message or null and the keys that work now. */
  status: (message: { text: string; tone: Tone } | null, hints: string) => void;
  /** What a button returned. */
  outcome: (outcome: Outcome) => void;
  /** A value was typed, switched or chosen. */
  changed?: (values: Values) => void;
}

/** The rows of one screen, with the keyboard and the mouse on them. */
export interface Form {
  /** The scrolling list the rows are in, to be added where they should show. */
  list: ScrollBoxRenderable;
  /** Builds a screen's rows. `keep` is for a redraw: values, position and focus stay. */
  show(screen: Screen, keep?: boolean): void;
  values(): Values;
  /** Gives the form a key. False when the key is not one of the form's. */
  key(key: KeyEvent): boolean;
  /** Without the keyboard no row is marked and no field takes typing. */
  setActive(active: boolean): void;
  /** Shows a message where the form's status goes, until the next action. */
  say(text: string, tone: Tone): void;
  busy(): boolean;
  destroy(): void;
}

export function createForm(renderer: CliRenderer, options: FormOptions): Form {
  const list = new ScrollBoxRenderable(renderer, {
    id: `${options.id}-list`,
    flexGrow: 1,
    flexShrink: 1,
    verticalScrollbarOptions: { visible: false },
    horizontalScrollbarOptions: { visible: false },
  });

  let nodes: RowNode[] = [];
  let values: Values = {};
  /** Index into `nodes` of the row that has the keyboard. */
  let focus = -1;
  let active = true;
  let busy = false;
  /** Counts the screens built, so every row ever drawn has its own id. */
  let built = 0;
  let message: { text: string; tone: Tone } | null = null;

  const focusable = () =>
    nodes.flatMap((node, index) => (FOCUSABLE.has(node.row.kind) ? [index] : []));

  const paint = () => {
    const width = Math.max(10, options.width());
    nodes.forEach((node, index) => {
      const { row } = node;
      const here = active && index === focus;
      const mark = here ? accent("▌ ") : "  ";
      if (row.kind === "button" && node.text) {
        // The row with the keyboard is shown in inverse video, which contrasts on any theme;
        // colour only marks a button as destructive or as needing attention.
        const plain = !row.tone || row.tone === "good" || row.tone === "muted";
        const label = here
          ? reverse(bold(` ${row.label} `))
          : plain
            ? row.tone === "good"
              ? bold(row.label)
              : row.label
            : tone(row.tone ?? "muted", row.label);
        const hint = row.hint ? fit(row.hint, width - row.label.length - 6) : "";
        node.text.content = styled([
          [mark, ...(here ? [] : [" "]), label, ...(hint ? [dim(`  ${hint}`)] : [])],
        ]);
      } else if (row.kind === "check" && node.text) {
        const box = values[row.key] === ON ? "[x]" : "[ ]";
        const label = `${box} ${row.label}`;
        const hint = fit(row.fixed ?? row.hint ?? "", Math.max(0, width - label.length - 6));
        node.text.content = styled([
          [mark, ...(here ? [reverse(bold(` ${label} `))] : [" ", row.fixed ? dim(label) : label])],
        ]);
        if (node.aside) node.aside.content = styled([[dim(`  ${hint}`)]]);
      } else if (row.kind === "note" && row.live && node.text) {
        const lines = row.live(values).split("\n");
        node.text.content = styled(
          row.text.split("\n").map((_, at) => {
            const line = fit(lines[at] ?? "", width);
            return [row.tone ? tone(row.tone, line) : dim(line)];
          }),
        );
      } else if ((row.kind === "input" || row.kind === "text") && node.text) {
        node.text.content = styled([[mark, " ", here ? bold(row.label) : row.label]]);
        if (row.kind === "text") {
          row.inserts?.forEach((insert, at) => {
            const chip = node.chips?.[at];
            if (chip) chip.content = styled([[dim(` ${at + 1} ${insert.label} `)]]);
          });
        }
      } else if (row.kind === "choice" && node.text) {
        node.text.content = styled([[mark, " ", here ? bold(row.label) : row.label]]);
        row.options.forEach((option, at) => {
          const chip = node.chips?.[at];
          if (!chip) return;
          chip.content = styled([
            values[row.key] === option.value
              ? [reverse(bold(`[${option.label}]`))]
              : [dim(` ${option.label} `)],
          ]);
        });
      }
      const field = node.input ?? node.area;
      if (field) {
        const on = here && !busy;
        // A line that is not being typed in shows how it starts; typing goes on at its end.
        if (node.input && on !== field.focused) {
          node.input.cursorOffset = on ? node.input.value.length : 0;
        }
        if (on) field.focus();
        else field.blur();
      }
    });
    const focused = nodes[focus]?.row;
    const hints =
      focused?.kind === "check"
        ? `click, or ↑↓ · space switches${focused.more ? " · → shows more" : ""} · esc goes back`
        : focused?.kind === "text"
          ? `type here · tab moves on${focused.inserts?.length ? " · alt and a number puts a piece in" : ""} · esc goes back`
          : "click, or ↑↓ and enter · ←→ changes a choice · esc goes back";
    options.status(message, hints);
  };

  const setFocus = (index: number) => {
    focus = index;
    const node = nodes[index];
    if (node) list.scrollChildIntoView(node.box);
    paint();
  };

  /**
   * For clicks. The renderer may move its own focus when the click is over, so the row's input
   * is given the keyboard once more after that.
   */
  const clickFocus = (index: number) => {
    setFocus(index);
    setTimeout(paint, 0);
  };

  const move = (delta: number) => {
    const order = focusable();
    if (order.length === 0) return;
    const next = order[moveCursor(order.indexOf(focus), delta, order.length)];
    if (next !== undefined) setFocus(next);
  };

  const activate = async (index: number) => {
    const row = nodes[index]?.row;
    if (busy) return;
    const run = row?.kind === "button" ? row.run : row?.kind === "check" ? row.more : undefined;
    if (!run) return;
    busy = true;
    message = { text: "…", tone: "muted" };
    setFocus(index);
    try {
      const outcome = await run({ ...values });
      message = null;
      busy = false;
      options.outcome(outcome);
    } catch (error) {
      busy = false;
      message = { text: (error as Error).message, tone: "bad" };
      paint();
    }
  };

  const toggle = (index: number) => {
    const row = nodes[index]?.row;
    if (busy || row?.kind !== "check") return;
    if (!row.fixed) {
      values[row.key] = values[row.key] === ON ? OFF : ON;
      options.changed?.({ ...values });
    }
    clickFocus(index);
  };

  const build = (row: Row, index: number): RowNode => {
    const id = `${options.id}-row-${built}-${index}`;
    if (row.kind === "heading" || row.kind === "note") {
      const lines = row.text.split("\n");
      const box = new BoxRenderable(renderer, { id, height: lines.length, flexShrink: 0 });
      const text = createText(renderer, `${id}-text`, lines.length);
      text.content = styled(
        lines.map((line) => [
          row.kind === "heading" ? bold(line) : row.tone ? tone(row.tone, line) : dim(line),
        ]),
      );
      box.add(text);
      return row.kind === "note" && row.live ? { row, box, text } : { row, box };
    }
    if (row.kind === "button") {
      const box = new BoxRenderable(renderer, {
        id,
        height: 1,
        flexShrink: 0,
        onMouseDown: () => void activate(index),
      });
      const text = createText(renderer, `${id}-text`, 1);
      box.add(text);
      return { row, box, text };
    }
    if (row.kind === "check") {
      const box = new BoxRenderable(renderer, {
        id,
        height: 1,
        flexShrink: 0,
        flexDirection: "row",
      });
      const text = createText(renderer, `${id}-text`, 1);
      text.onMouseDown = () => toggle(index);
      const aside = createText(renderer, `${id}-aside`, 1);
      aside.onMouseDown = () => (row.more ? void activate(index) : toggle(index));
      box.add(text);
      box.add(aside);
      return { row, box, text, aside };
    }
    if (row.kind === "text") {
      const inserts = row.inserts ?? [];
      const box = new BoxRenderable(renderer, {
        id,
        // The label, the frame around the lines, and a line of pieces to put in.
        height: 1 + row.height + 2 + (inserts.length > 0 ? 1 : 0),
        flexShrink: 0,
        flexDirection: "column",
        onMouseDown: () => clickFocus(index),
      });
      const text = createText(renderer, `${id}-text`, 1);
      box.add(text);
      const frame = new BoxRenderable(renderer, {
        id: `${id}-frame`,
        height: row.height + 2,
        marginLeft: 3,
        paddingX: 1,
        border: true,
        borderStyle: "rounded",
        borderColor: RGBA.defaultForeground(),
        focusedBorderColor: RGBA.defaultForeground(),
      });
      const area = new TextareaRenderable(renderer, {
        id: `${id}-area`,
        width: "100%",
        height: row.height,
        initialValue: values[row.key] ?? "",
        wrapMode: "word",
        textColor: RGBA.defaultForeground(),
        focusedTextColor: RGBA.defaultForeground(),
        backgroundColor: RGBA.defaultBackground(),
        focusedBackgroundColor: RGBA.defaultBackground(),
      });
      area.onContentChange = () => {
        if (values[row.key] === area.plainText) return;
        values[row.key] = area.plainText;
        options.changed?.({ ...values });
        paint();
      };
      frame.add(area);
      box.add(frame);
      const line = new BoxRenderable(renderer, {
        id: `${id}-chips`,
        height: 1,
        flexDirection: "row",
        marginLeft: 3,
      });
      const chips = inserts.map((insert, at) => {
        const chip = createText(renderer, `${id}-chip-${at}`, 1);
        chip.onMouseDown = () => {
          area.insertText(insert.text);
          clickFocus(index);
        };
        line.add(chip);
        return chip;
      });
      if (inserts.length > 0) box.add(line);
      return { row, box, text, area, chips };
    }
    const box = new BoxRenderable(renderer, {
      id,
      // An input is its label and a three-row frame; a choice its label, the chips and a gap.
      height: row.kind === "input" ? 4 : 3,
      flexShrink: 0,
      flexDirection: "column",
      onMouseDown: () => clickFocus(index),
    });
    const text = createText(renderer, `${id}-text`, 1);
    box.add(text);
    if (row.kind === "input") {
      // The frame has the same colour with and without the keyboard: the mark, the bold label
      // and the cursor show which field is being typed in.
      const frame = new BoxRenderable(renderer, {
        id: `${id}-frame`,
        height: 3,
        marginLeft: 3,
        paddingX: 1,
        border: true,
        borderStyle: "rounded",
        borderColor: RGBA.defaultForeground(),
        focusedBorderColor: RGBA.defaultForeground(),
      });
      const input = new InputRenderable(renderer, {
        id: `${id}-input`,
        width: "100%",
        value: values[row.key] ?? "",
        // Dimmed like every other hint, so it follows the terminal's theme. OpenTUI draws styled
        // text here as given, though the input's options only declare a string; its own default
        // is a fixed grey that disappears on some backgrounds.
        placeholder: (row.placeholder ? styled([[dim(row.placeholder)]]) : "") as unknown as string,
        placeholderColor: RGBA.defaultForeground(),
        textColor: RGBA.defaultForeground(),
        focusedTextColor: RGBA.defaultForeground(),
      });
      input.on(InputRenderableEvents.INPUT, () => {
        values[row.key] = input.value;
        options.changed?.({ ...values });
        // Notes that follow the form follow the typing too.
        paint();
      });
      input.cursorOffset = 0;
      frame.add(input);
      box.add(frame);
      return { row, box, text, input };
    }
    const line = new BoxRenderable(renderer, {
      id: `${id}-chips`,
      height: 1,
      flexDirection: "row",
      marginLeft: 2,
    });
    const chips = row.options.map((option, at) => {
      const chip = createText(renderer, `${id}-chip-${at}`, 1);
      chip.onMouseDown = () => {
        values[row.key] = option.value;
        options.changed?.({ ...values });
        clickFocus(index);
      };
      line.add(chip);
      return chip;
    });
    box.add(line);
    return { row, box, text, chips };
  };

  function show(screen: Screen, keep = false): void {
    for (const node of nodes) {
      list.remove(node.box);
      node.box.destroyRecursively();
    }
    built += 1;
    const scrolled = list.scrollTop;
    // On a redraw the form keeps what it holds; the new screen's values are changes to that.
    values = keep ? { ...values, ...screen.values } : { ...screen.values };
    for (const row of screen.rows) {
      if (row.kind === "choice" && values[row.key] === undefined) {
        values[row.key] = row.options[0]?.value ?? "";
      }
      if (row.kind === "input" || row.kind === "text") values[row.key] ??= "";
      if (row.kind === "check") values[row.key] ??= OFF;
    }
    nodes = screen.rows.map(build);
    for (const node of nodes) list.add(node.box);
    const order = focusable();
    if (keep) {
      list.scrollTop = scrolled;
      // The same row when it is still one that takes the keyboard, else the nearest before it.
      focus = order.findLast((index) => index <= focus) ?? order[0] ?? -1;
    } else {
      list.scrollTop = 0;
      focus = order[0] ?? -1;
    }
    paint();
  }

  const key = (event: KeyEvent): boolean => {
    if (busy) return true;
    const row = nodes[focus]?.row;
    if (event.name === "tab") {
      // The field itself must not get the tab it is left with.
      if (row?.kind === "text") event.preventDefault();
      move(event.shift ? -1 : 1);
      return true;
    }
    if (row?.kind === "text") {
      // Every other key is typing, except alt and a number, which puts a piece in.
      const insert = event.meta ? row.inserts?.[Number(event.name) - 1] : undefined;
      if (!insert) return false;
      event.preventDefault();
      nodes[focus]?.area?.insertText(insert.text);
      return true;
    }
    if (event.name === "down") {
      move(1);
      return true;
    }
    if (event.name === "up") {
      move(-1);
      return true;
    }
    if (row?.kind === "choice" && (event.name === "left" || event.name === "right")) {
      const at = row.options.findIndex((option) => option.value === values[row.key]);
      const next = row.options[moveCursor(at, event.name === "left" ? -1 : 1, row.options.length)];
      if (next) values[row.key] = next.value;
      options.changed?.({ ...values });
      paint();
      return true;
    }
    if (row?.kind === "check") {
      if (event.name === "space") {
        toggle(focus);
        return true;
      }
      if (event.name === "right" && row.more) {
        void activate(focus);
        return true;
      }
    }
    if (event.name === "return" || event.name === "enter" || event.name === "linefeed") {
      if (row?.kind === "button") void activate(focus);
      else if (row?.kind === "check") toggle(focus);
      else move(1);
      return true;
    }
    return false;
  };

  return {
    list,
    show,
    values: () => ({ ...values }),
    key,
    setActive: (next) => {
      active = next;
      paint();
    },
    say: (text, kind) => {
      message = { text, tone: kind };
      paint();
    },
    busy: () => busy,
    destroy: () => {
      for (const node of nodes) node.box.destroyRecursively();
      nodes = [];
      list.destroyRecursively();
    },
  };
}

/**
 * Shows `first` and runs until the user closes the wizard. Resolves with the dwa command to run
 * afterwards, or null when there is none. With `then`, that is carried out at once as if a
 * button of `first` had returned it: a screen or a view to open straight away.
 */
export function createWizard(
  renderer: CliRenderer,
  first: Screen,
  then?: Outcome,
): Promise<string[] | null> {
  const root = new BoxRenderable(renderer, {
    id: "wizard-root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    paddingX: 2,
    paddingY: 1,
  });
  const title = createText(renderer, "wizard-title", 2);
  const footer = createText(renderer, "wizard-footer", 2);
  /** `from` is the view a screen was opened by, which going back returns to. */
  const stack: { screen: Screen; from?: View }[] = [];
  /** A view has the popup: the screens are hidden and take no keys. */
  let viewing = false;
  let finish: (exec: string[] | null) => void = () => undefined;
  const done = new Promise<string[] | null>((resolve) => {
    finish = resolve;
  });
  const width = () => renderer.width - 4;

  const form = createForm(renderer, {
    id: "wizard",
    width,
    status: (message, hints) => {
      footer.content = styled([
        message ? [tone(message.tone, fit(message.text, width()))] : [],
        [dim(fit(hints, width()))],
      ]);
    },
    outcome: (outcome) => carryOut(outcome, stack.at(-1)?.from, false),
  });
  root.add(title);
  root.add(form.list);
  root.add(footer);
  renderer.root.add(root);

  const show = (keep = false) => {
    const screen = stack.at(-1)?.screen;
    if (!screen) return;
    title.content = styled([[bold(screen.title)]]);
    form.show(screen, keep);
  };

  const leave = () => {
    const from = stack.at(-1)?.from;
    if (stack.length <= 1 && !from) return finish(null);
    stack.pop();
    show();
    if (from) void runView(from);
  };

  const runView = async (view: View) => {
    viewing = true;
    root.visible = false;
    form.setActive(false);
    let outcome: Outcome | null = null;
    let failure: Error | null = null;
    try {
      outcome = await view({ renderer, parent: renderer.root });
    } catch (error) {
      failure = error as Error;
    }
    viewing = false;
    root.visible = true;
    form.setActive(true);
    if (outcome) carryOut(outcome, view, true);
    else form.say(failure?.message ?? "That did not work.", "bad");
  };

  /**
   * `owner` is the view the outcome has to do with: the one that resolved with it (`fromView`),
   * or the one that opened the screen whose button returned it.
   */
  function carryOut(outcome: Outcome, owner: View | undefined, fromView: boolean): void {
    if ("to" in outcome) {
      stack.push({ screen: outcome.to, from: owner });
      show();
    } else if ("replace" in outcome) {
      // A view that is done leaves nothing of its own behind.
      stack[stack.length - 1] = { screen: outcome.replace, from: fromView ? undefined : owner };
      show(true);
    } else if ("back" in outcome) {
      leave();
    } else if ("home" in outcome) {
      while (stack.length > 1 && stack.at(-1)?.from) stack.pop();
      stack[stack.length - 1] = { screen: outcome.home };
      show();
    } else if ("view" in outcome) {
      // A screen that belongs to a view makes way for the view that follows it.
      if (owner && !fromView) stack.pop();
      show();
      void runView(outcome.view);
    } else {
      finish("exec" in outcome ? outcome.exec : null);
    }
  }

  renderer.keyInput.on("keypress", (key) => {
    if (viewing || form.busy()) return;
    if (key.name === "escape") return leave();
    form.key(key);
  });

  stack.push({ screen: first });
  show();
  if (then) carryOut(then, undefined, false);
  return done;
}
