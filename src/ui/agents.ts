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
import { agentsHeader, tiles as buildTiles, fit, moveCursor, type Tile } from "./model.ts";
import { createText, styled } from "./text.ts";
import { accent, tone } from "./theme.ts";

/** Two lines of text plus a blank line between tiles. */
const TILE_HEIGHT = 3;

export interface AgentsActions {
  /** Show this agent's session under main, or hide it when it is the one shown. */
  toggle(agentId: string): void;
  /** Hide the open agent. */
  close(): void;
}

export interface AgentsView {
  update(state: WorkspaceState): void;
  showMessage(message: string): void;
}

interface TileNodes {
  box: BoxRenderable;
  text: TextRenderable;
}

/**
 * The agents pane: one tile per running agent, at most twelve visible, the rest reached by
 * scrolling. Click a tile or press Enter on it to show that agent under the main session, and
 * again to hide it.
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
  const list = new ScrollBoxRenderable(renderer, {
    id: "agents-list",
    flexGrow: 1,
    flexShrink: 1,
    maxHeight: MAX_VISIBLE_AGENTS * TILE_HEIGHT,
    verticalScrollbarOptions: { visible: false },
    horizontalScrollbarOptions: { visible: false },
  });
  const footer = createText(renderer, "agents-footer");
  root.add(header);
  root.add(list);
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
      ],
      ["   ", tone(tile.style.tone, status), ...(detail ? [dim(` · ${detail}`)] : [])],
    ]);
  };

  const paint = () => {
    const first = Math.floor(list.scrollTop / TILE_HEIGHT);
    header.content = styled([[bold(agentsHeader(current.length, first))]]);
    current.forEach((tile, index) => {
      const node = nodes[index];
      if (node) paintTile(tile, node, index === cursor);
    });
    footer.content =
      current.length === 0
        ? styled([[dim("No agents running.")], [dim("dwa agent spawn <name>")]])
        : styled([[dim("click or enter: show / hide")]]);
  };

  const rebuild = () => {
    for (const node of nodes) {
      list.remove(node.box);
      node.box.destroyRecursively();
    }
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
    update(state) {
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
      header.content = styled([[bold("AGENTS")]]);
      footer.content = styled([[dim(message)]]);
    },
  };
}
