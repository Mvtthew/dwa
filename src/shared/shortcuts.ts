import type { PopupKind } from "./protocol.ts";

/**
 * Every dwa shortcut, once. The tmux bindings (`buildTmuxConf`), the top bar's categories and
 * the dropdown menus they open are all made from this list, so a new action is added here only.
 */

export type ShortcutCategory = "Workflows" | "Agents" | "Panes" | "Workspace";

export const SHORTCUT_CATEGORIES: readonly ShortcutCategory[] = [
  "Workflows",
  "Agents",
  "Panes",
  "Workspace",
];

/** What a shortcut does: opens a popup, runs `dwa key <args>`, or runs a tmux command as is. */
export type ShortcutAction = { popup: PopupKind } | { key: string[] } | { tmux: string };

export interface Shortcut {
  /** The key after the prefix, and with Alt. */
  key: string;
  label: string;
  category: ShortcutCategory;
  action: ShortcutAction;
  /** Bound, but listed in the menus only through a hint. */
  hidden?: boolean;
  /** Not bound on Alt: the key is too common in the programs running in the panes. */
  prefixOnly?: boolean;
}

/** A menu line that is not a choice, such as the digits that open agents. */
export interface ShortcutHint {
  category: ShortcutCategory;
  label: string;
  key: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { key: "w", label: "Workflows", category: "Workflows", action: { popup: "workflows" } },
  { key: "g", label: "Workflow designer", category: "Workflows", action: { popup: "design" } },
  { key: "a", label: "New agent", category: "Agents", action: { popup: "agent" } },
  { key: "t", label: "Agent tools", category: "Agents", action: { popup: "tools" } },
  { key: "r", label: "Role settings", category: "Agents", action: { popup: "roles" } },
  { key: "q", label: "Answer questions", category: "Agents", action: { popup: "questions" } },
  ...Array.from(
    { length: 9 },
    (_, i): Shortcut => ({
      key: `${i + 1}`,
      label: `Open agent ${i + 1}`,
      category: "Agents",
      action: { key: ["open", `${i + 1}`] },
      hidden: true,
    }),
  ),
  { key: "s", label: "Shell", category: "Panes", action: { key: ["shell"] } },
  { key: "e", label: "Event feed", category: "Panes", action: { key: ["feed"] } },
  { key: "0", label: "Focus main", category: "Panes", action: { key: ["focus"] } },
  { key: "z", label: "Zoom pane", category: "Panes", action: { tmux: "resize-pane -Z" } },
  { key: "x", label: "Close pane", category: "Panes", action: { key: ["close"] } },
  { key: "p", label: "Menu", category: "Workspace", action: { popup: "palette" } },
  {
    key: "d",
    label: "Detach",
    category: "Workspace",
    action: { tmux: "detach-client" },
    prefixOnly: true,
  },
];

export const SHORTCUT_HINTS: readonly ShortcutHint[] = [
  { category: "Agents", label: "Open agent", key: "1-9" },
];

/** The shortcuts a category's menu lists, in order. */
export function categoryShortcuts(category: ShortcutCategory): Shortcut[] {
  return SHORTCUTS.filter((entry) => entry.category === category && !entry.hidden);
}

export function isShortcutCategory(value: unknown): value is ShortcutCategory {
  return SHORTCUT_CATEGORIES.includes(value as ShortcutCategory);
}
