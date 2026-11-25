// A small form engine for the wizards that open in a popup: a stack of screens, each a list of
// notes, buttons, text inputs, choices and switches. Everything can be clicked; the keyboard works too.
import {
  BoxRenderable,
  bold,
  type CliRenderer,
  dim,
  InputRenderable,
  InputRenderableEvents,
  RGBA,
  reverse,
  ScrollBoxRenderable,
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
  | { exec: string[] };

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
  chips?: TextRenderable[];
  /** The hint of a check row, which is clicked on its own. */
  aside?: TextRenderable;
}

const FOCUSABLE = new Set(["button", "input", "choice", "check"]);

export const ON = "on";
export const OFF = "off";

/**
 * Shows `first` and runs until the user closes the wizard. Resolves with the dwa command to run
 * afterwards, or null when there is none.
 */
export function createWizard(renderer: CliRenderer, first: Screen): Promise<string[] | null> {
  const root = new BoxRenderable(renderer, {
    id: "wizard-root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    paddingX: 2,
    paddingY: 1,
  });
  const title = createText(renderer, "wizard-title", 2);
  const list = new ScrollBoxRenderable(renderer, {
    id: "wizard-list",
    flexGrow: 1,
    flexShrink: 1,
    verticalScrollbarOptions: { visible: false },
    horizontalScrollbarOptions: { visible: false },
  });
  const footer = createText(renderer, "wizard-footer", 2);
  root.add(title);
  root.add(list);
  root.add(footer);
  renderer.root.add(root);

  const stack: Screen[] = [];
  let nodes: RowNode[] = [];
  let values: Values = {};
  /** Index into `nodes` of the row that has the keyboard. */
  let focus = -1;
  let busy = false;
  let message: { text: string; tone: Tone } | null = null;
  let finish: (exec: string[] | null) => void = () => undefined;
  const done = new Promise<string[] | null>((resolve) => {
    finish = resolve;
  });

  const focusable = () =>
    nodes.flatMap((node, index) => (FOCUSABLE.has(node.row.kind) ? [index] : []));

  const paint = () => {
    const screen = stack.at(-1);
    title.content = styled([[bold(screen?.title ?? "")]]);
    const width = Math.max(10, renderer.width - 4);
    nodes.forEach((node, index) => {
      const { row } = node;
      const here = index === focus;
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
      } else if (row.kind === "input" && node.text) {
        node.text.content = styled([[mark, " ", here ? bold(row.label) : row.label]]);
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
      if (node.input) {
        if (here && !busy) node.input.focus();
        else node.input.blur();
      }
    });
    const focused = nodes[focus]?.row;
    const hints =
      focused?.kind === "check"
        ? `click, or ↑↓ · space switches${focused.more ? " · → shows more" : ""} · esc goes back`
        : "click, or ↑↓ and enter · ←→ changes a choice · esc goes back";
    footer.content = styled([
      message ? [tone(message.tone, fit(message.text, width))] : [],
      [dim(fit(hints, width))],
    ]);
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

  const leave = () => {
    if (stack.length <= 1) return finish(null);
    stack.pop();
    show();
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
      if ("to" in outcome) {
        stack.push(outcome.to);
        show();
      } else if ("replace" in outcome) {
        stack[stack.length - 1] = outcome.replace;
        show(true);
      } else if ("back" in outcome) {
        leave();
      } else {
        finish("exec" in outcome ? outcome.exec : null);
      }
    } catch (error) {
      busy = false;
      message = { text: (error as Error).message, tone: "bad" };
      paint();
    }
  };

  const toggle = (index: number) => {
    const row = nodes[index]?.row;
    if (busy || row?.kind !== "check") return;
    if (!row.fixed) values[row.key] = values[row.key] === ON ? OFF : ON;
    clickFocus(index);
  };

  const build = (row: Row, index: number): RowNode => {
    const id = `wizard-row-${stack.length}-${index}`;
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
    const box = new BoxRenderable(renderer, {
      id,
      height: 3,
      flexShrink: 0,
      flexDirection: "column",
      onMouseDown: () => clickFocus(index),
    });
    const text = createText(renderer, `${id}-text`, 1);
    box.add(text);
    if (row.kind === "input") {
      const input = new InputRenderable(renderer, {
        id: `${id}-input`,
        width: "100%",
        marginLeft: 3,
        value: values[row.key] ?? "",
        placeholder: row.placeholder ?? "",
        textColor: RGBA.defaultForeground(),
        focusedTextColor: RGBA.defaultForeground(),
      });
      input.on(InputRenderableEvents.INPUT, () => {
        values[row.key] = input.value;
        // Notes that follow the form follow the typing too.
        paint();
      });
      box.add(input);
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
        clickFocus(index);
      };
      line.add(chip);
      return chip;
    });
    box.add(line);
    return { row, box, text, chips };
  };

  /** Builds the top screen. `keep` is for a redraw: values, position and focus stay. */
  function show(keep = false): void {
    const screen = stack.at(-1);
    if (!screen) return;
    for (const node of nodes) {
      list.remove(node.box);
      node.box.destroyRecursively();
    }
    const scrolled = list.scrollTop;
    // On a redraw the form keeps what it holds; the new screen's values are changes to that.
    values = keep ? { ...values, ...screen.values } : { ...screen.values };
    for (const row of screen.rows) {
      if (row.kind === "choice" && values[row.key] === undefined) {
        values[row.key] = row.options[0]?.value ?? "";
      }
      if (row.kind === "input") values[row.key] ??= "";
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

  renderer.keyInput.on("keypress", (key) => {
    if (busy) return;
    if (key.name === "escape") return leave();
    if (key.name === "tab") return move(key.shift ? -1 : 1);
    if (key.name === "down") return move(1);
    if (key.name === "up") return move(-1);
    const row = nodes[focus]?.row;
    if (row?.kind === "choice" && (key.name === "left" || key.name === "right")) {
      const at = row.options.findIndex((option) => option.value === values[row.key]);
      const next = row.options[moveCursor(at, key.name === "left" ? -1 : 1, row.options.length)];
      if (next) values[row.key] = next.value;
      return paint();
    }
    if (row?.kind === "check") {
      if (key.name === "space") return toggle(focus);
      if (key.name === "right" && row.more) return void activate(focus);
    }
    if (key.name === "return" || key.name === "enter" || key.name === "linefeed") {
      if (row?.kind === "button") return void activate(focus);
      if (row?.kind === "check") return toggle(focus);
      return move(1);
    }
  });

  stack.push(first);
  show();
  return done;
}
