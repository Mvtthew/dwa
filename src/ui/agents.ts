import {
  BoxRenderable,
  bold,
  type CliRenderer,
  dim,
  ScrollBoxRenderable,
  type TextRenderable,
} from "@opentui/core";
import { MAX_VISIBLE_AGENTS } from "../shared/constants.ts";
import type { WorkspaceState } from "../shared/protocol.ts";
import {
  agentsHeader,
  agentsSummary,
  tiles as buildTiles,
  fit,
  formatKey,
  moveCursor,
  statusModel,
  type Tile,
  wrap,
} from "./model.ts";
import { createText, type Part, styled } from "./text.ts";
import { accent, tone } from "./theme.ts";

/** Two lines of text plus a blank line between tiles. */
const TILE_HEIGHT = 3;
/** Questions and messages to the user the pane lists; the dialogs have the rest. */
const QUESTION_LINES = 4;
const INBOX_LINES = 3;

/** What a line under the list opens or does when clicked. */
type NoteAction = "questions" | "messages" | "clear-messages";

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface AgentsActions {
  /** Show this agent's session under main, or hide it when it is the one shown. */
  toggle(agentId: string): void;
  /** Hide the open agent. */
  close(): void;
  /** Open the tools dialog for this agent. */
  tools(agentId: string): void;
  /** Open the questions (at this one, by id) or the messages to the user. */
  open(kind: "questions" | "messages", subject?: string): void;
  /** Mark the messages to the user as read. */
  clearMessages(): void;
}

export interface AgentsView {
  update(state: WorkspaceState, nowMs: number): void;
  showMessage(message: string): void;
}

interface TileNodes {
  box: BoxRenderable;
  text: TextRenderable;
}

/**
 * The agents pane: how many agents are doing what, then one tile per running agent, at most
 * twelve visible, the rest reached by scrolling. Click a tile or press Enter on it to show that
 * agent under the main session, and again to hide it. Under the list, at the bottom of the pane:
 * the open questions and the messages to the user, each line opening its dialog.
 */
export function createAgentsView(renderer: CliRenderer, actions: AgentsActions): AgentsView {
  const root = new BoxRenderable(renderer, {
    id: "agents-root",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    paddingX: 1,
  });
  const header = createText(renderer, "agents-header", 2);
  let summary = "";
  const list = new ScrollBoxRenderable(renderer, {
    id: "agents-list",
    // As tall as its tiles and no taller, so the footer is not pushed up by an empty list.
    height: 0,
    flexGrow: 0,
    flexShrink: 1,
    verticalScrollbarOptions: { visible: false },
    horizontalScrollbarOptions: { visible: false },
  });
  /** Questions and messages. Its lines are clicked, so the text is not selectable. */
  const notes = createText(renderer, "agents-notes", 0, false);
  /** What a click on a line of the notes opens, by line number. */
  const targets = new Map<number, { action: NoteAction; subject?: string }>();
  notes.onMouseDown = (event) => {
    const target = targets.get(event.y - notes.screenY);
    if (!target) return;
    if (target.action === "clear-messages") return actions.clearMessages();
    actions.open(target.action, target.subject);
  };
  const footer = createText(renderer, "agents-footer");
  root.add(header);
  root.add(list);
  // Takes the rows the list leaves, which keeps the footer on the last rows of the pane.
  root.add(new BoxRenderable(renderer, { id: "agents-gap", flexGrow: 1, flexShrink: 1 }));
  root.add(notes);
  root.add(footer);
  renderer.root.add(root);

  let current: Tile[] = [];
  let nodes: TileNodes[] = [];
  let cursor = 0;

  const paintTile = (tile: Tile, node: TileNodes, selected: boolean) => {
    const status = `${tile.style.glyph} ${tile.style.label}`;
    // Pane width, less the side padding, the indent, the status and the " · " separator.
    const room = renderer.width - 2 - 3 - status.length - 3;
    const detail = tile.detail && room >= 4 ? fit(tile.detail, room) : null;
    node.text.content = styled([
      [
        selected ? accent("▌") : " ",
        tile.open ? "▸" : " ",
        bold(`${tile.position} ${tile.name}`),
        ...(tile.role ? [dim(` ${tile.role}`)] : []),
        // A session that is not as its role says any more; the footer says how.
        ...(tile.notices.length > 0 ? [tone("attention", " ↻")] : []),
      ],
      ["   ", tone(tile.style.tone, status), ...(detail ? [dim(` · ${detail}`)] : [])],
    ]);
  };

  const paint = () => {
    const first = Math.floor(list.scrollTop / TILE_HEIGHT);
    // The counts under the title, then a blank row before the tiles.
    header.height = summary ? 3 : 2;
    header.content = styled([
      [bold(agentsHeader(current.length, first))],
      ...(summary ? [[dim(fit(summary, renderer.width - 2))]] : []),
    ]);
    current.forEach((tile, index) => {
      const node = nodes[index];
      if (node) paintTile(tile, node, index === cursor);
    });
    footer.content =
      current.length === 0
        ? styled([[dim("No agents running.")], [dim("dwa agent spawn <name>")]])
        : styled([
            ...(current[cursor]?.notices ?? []).map((line) => [
              tone("attention", fit(`↻ ${line}`, renderer.width - 2)),
            ]),
            // What the selected agent may use, so the list stays two lines per agent.
            ...(current[cursor]?.capabilities ?? []).flatMap((line) =>
              wrap(line, renderer.width - 2).map((row) => [dim(row)]),
            ),
            [dim("enter: show / hide · t: tools")],
          ]);
  };

  const paintNotes = (state: WorkspaceState, nowMs: number) => {
    const model = statusModel(state, nowMs);
    const width = Math.max(10, renderer.width - 2);
    const lines: Part[][] = [];
    targets.clear();
    const link = (line: Part[], action: NoteAction, subject?: string) => {
      targets.set(lines.length, { action, subject });
      lines.push(line);
    };
    if (model.questions.length > 0) {
      const mine = model.questions.some((question) => question.forUser);
      const title = bold(`QUESTIONS ${model.questions.length}`);
      lines.push([mine ? tone("attention", title) : title]);
      for (const question of model.questions.slice(0, QUESTION_LINES)) {
        const id = String(question.id);
        link(
          [question.forUser ? tone("attention", "◆ ") : dim("◷ "), question.heading],
          "questions",
          id,
        );
        link([dim(`  ${fit(oneLine(question.text), width - 2)}`)], "questions", id);
      }
      link([dim(`  click, or ${formatKey(state.keyPrefix)} q for all`)], "questions");
      lines.push([]);
    }
    if (model.inbox.length > 0) {
      lines.push([bold(`MESSAGES TO YOU ${model.inbox.length}`)]);
      // Who and when only: a click on a line opens them all, each one whole. The heading
      // has the number, so the ones that are not listed need no line.
      for (const message of model.inbox.slice(0, INBOX_LINES)) {
        link([`from ${message.from}`, dim(`  ${message.age}`)], "messages");
      }
      link([accent("▸ "), "Clear messages"], "clear-messages");
      lines.push([]);
    }
    notes.height = lines.length;
    notes.content = styled(lines);
  };

  const rebuild = () => {
    for (const node of nodes) {
      list.remove(node.box);
      node.box.destroyRecursively();
    }
    list.height = Math.min(current.length, MAX_VISIBLE_AGENTS) * TILE_HEIGHT;
    nodes = current.map((tile, index) => {
      const box = new BoxRenderable(renderer, {
        id: `tile-${tile.id}`,
        height: TILE_HEIGHT,
        flexShrink: 0,
        onMouseDown: () => {
          cursor = index;
          paint();
          actions.toggle(tile.id);
        },
      });
      const text = createText(renderer, `tile-text-${tile.id}`, 2);
      box.add(text);
      list.add(box);
      return { box, text };
    });
  };

  const select = (index: number) => {
    cursor = moveCursor(index, 0, current.length);
    const node = nodes[cursor];
    if (node) list.scrollChildIntoView(node.box);
    paint();
  };

  renderer.keyInput.on("keypress", (key) => {
    if (key.name === "j" || key.name === "down") return select(cursor + 1);
    if (key.name === "k" || key.name === "up") return select(cursor - 1);
    if (key.name === "x") return actions.close();
    if (key.name === "t") {
      const tile = current[cursor];
      if (tile) actions.tools(tile.id);
      return;
    }
    if (key.name === "return" || key.name === "enter" || key.name === "linefeed") {
      const tile = current[cursor];
      if (tile) actions.toggle(tile.id);
      return;
    }
    if (/^[1-9]$/.test(key.name)) {
      const index = Number(key.name) - 1;
      const tile = current[index];
      if (!tile) return;
      select(index);
      actions.toggle(tile.id);
    }
  });

  return {
    update(state, nowMs) {
      summary = agentsSummary(state);
      paintNotes(state, nowMs);
      const next = buildTiles(state);
      const sameList =
        next.length === current.length && next.every((tile, i) => tile.id === current[i]?.id);
      // Keep the cursor on the same agent when others come and go.
      const selectedId = current[cursor]?.id;
      current = next;
      if (!sameList) {
        rebuild();
        const kept = next.findIndex((tile) => tile.id === selectedId);
        cursor = kept === -1 ? moveCursor(cursor, 0, next.length) : kept;
      }
      paint();
    },
    showMessage(message) {
      current = [];
      rebuild();
      targets.clear();
      notes.height = 0;
      notes.content = styled([]);
      header.height = 2;
      header.content = styled([[bold("AGENTS")]]);
      footer.content = styled([[dim(message)]]);
    },
  };
}
