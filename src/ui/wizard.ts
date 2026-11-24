// A small form engine for the wizards that open in a popup: a stack of screens, each a list of
// notes, buttons, text inputs and choices. Everything can be clicked; the keyboard works too.
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
  | { back: true }
  | { close: true }
  /** Ends the wizard and runs this dwa command in the same terminal (for `$EDITOR`). */
  | { exec: string[] };

export type Row =
  | { kind: "heading"; text: string }
  | { kind: "note"; text: string; tone?: Tone }
  | {
      kind: "button";
      label: string;
      /** Shown dimmed after the label. */
      hint?: string;
      tone?: Tone;
      run: (values: Values) => Outcome | Promise<Outcome>;
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
}

const FOCUSABLE = new Set(["button", "input", "choice"]);

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
    const hints = "click, or ↑↓ and enter · ←→ changes a choice · esc goes back";
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
    if (busy || row?.kind !== "button") return;
    busy = true;
    message = { text: "…", tone: "muted" };
    setFocus(index);
    try {
      const outcome = await row.run({ ...values });
      message = null;
      busy = false;
      if ("to" in outcome) {
        stack.push(outcome.to);
        show();
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
      return { row, box };
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

  function show(): void {
    const screen = stack.at(-1);
    if (!screen) return;
    for (const node of nodes) {
      list.remove(node.box);
      node.box.destroyRecursively();
    }
    values = { ...screen.values };
    for (const row of screen.rows) {
      if (row.kind === "choice" && values[row.key] === undefined) {
        values[row.key] = row.options[0]?.value ?? "";
      }
      if (row.kind === "input") values[row.key] ??= "";
    }
    nodes = screen.rows.map(build);
    for (const node of nodes) list.add(node.box);
    list.scrollTop = 0;
    focus = focusable()[0] ?? -1;
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
    if (key.name === "return" || key.name === "enter" || key.name === "linefeed") {
      if (row?.kind === "button") return void activate(focus);
      return move(1);
    }
  });

  stack.push(first);
  show();
  return done;
}
