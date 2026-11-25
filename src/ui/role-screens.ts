// The "Role settings" wizard: the roles as a list, one role as a form, its history, and
// creating, copying, renaming and deleting roles. The files are reached through `RoleStore`,
// so the screens are tested without a disk.
import { EFFORT_LEVELS, PERMISSION_MODES } from "../shared/capabilities.ts";
import type { History } from "../shared/history.ts";
import { formatTime } from "../shared/history.ts";
import type { WorkspaceState } from "../shared/protocol.ts";
import type { RoleChanges, RoleFields, RoleRef } from "../shared/role-edit.ts";
import { formatRef, type ItemRef, type Scope } from "../shared/scope.ts";
import { BUILTIN_TOOLS } from "../shared/tools.ts";
import { moveLabel, scopeHint, scopeRow, scopeTitle, scopeValue, WHERE } from "./scope-rows.ts";
import { OFF, ON, type Outcome, type Row, type Screen, type Values } from "./wizard.ts";
import type { WizardApi } from "./wizards.ts";

export interface RoleListEntry {
  name: string;
  source: Scope;
  /** A personal role the project has one of the same name for; no session here uses it. */
  hidden: boolean;
  description: string | null;
  /** Why the file cannot be used, when it cannot. */
  error: string | null;
}

/**
 * What the role settings need from the files. Every method may throw with a message to show.
 * A role is named by place and name; a bare name is the role sessions here use.
 */
export interface RoleStore {
  /** Every role file in both places, the hidden personal ones included. */
  list(): RoleListEntry[];
  /** The role's own file content as values; nothing inherited. */
  load(role: RoleRef): RoleFields;
  /** Returns the version the file is at afterwards. */
  save(role: RoleRef, changes: RoleChanges): number;
  create(name: string, description: string, where: Scope): void;
  /** Without `where` the copy is kept where the original is. */
  duplicate(from: RoleRef, to: string, where?: Scope): void;
  rename(from: RoleRef, to: string): void;
  /** To the other place, with the history. */
  move(role: RoleRef, to: Scope): void;
  remove(role: RoleRef): void;
  /** What refers to the role in the files. */
  users(role: RoleRef): string[];
  /** What the change means outside this project's files; shown before or after it. */
  warnings(action: "save" | "rename" | "delete" | "move", role: RoleRef): string[];
  history(role: RoleRef): History;
  diff(role: RoleRef, from: number, to: number): string[];
  switchTo(role: RoleRef, n: number): void;
  /** Names a role can pick from. */
  choices(): { mcp: string[]; plugins: string[]; skills: string[]; projectMcp: string[] };
}

const back: Row = { kind: "button", label: "Back", run: () => ({ back: true }) };
const close: Row = { kind: "button", label: "Close", run: () => ({ close: true }) };
const gap: Row = { kind: "note", text: "" };

const INHERIT = "";
const OWN = "own";
const inheritOr = (values: readonly string[]) => [
  { value: INHERIT, label: "inherit" },
  ...values.map((value) => ({ value, label: value })),
];
const MODELS = ["opus", "sonnet", "haiku"];

/** The list keys shown as "inherit, or these" with one switch per name. */
const NAME_LISTS = [
  ["mcp", "MCP SERVERS", "MCP servers from the catalogue"],
  ["plugins", "PLUGINS", "Plugins from the catalogue"],
  ["skills", "SKILLS", "Skills (with a list, the role has no others of the project)"],
  ["off_mcp", "PROJECT MCP SERVERS TO LEAVE OUT", "Servers of .mcp.json this role does not get"],
] as const;
const RULE_LISTS = [
  ["allow", "ALLOWED WITHOUT ASKING"],
  ["deny", "REFUSED"],
] as const;
const ID_LISTS = [
  ["off_plugins", "Built-in plugins to switch off", "ids, separated by commas"],
  ["off_skills", "Built-in skills to switch off", "names, separated by commas"],
] as const;

const itemKey = (list: string, name: string) => `${list}:${name}`;
const modeKey = (list: string) => `${list}Mode`;
const split = (text: string | undefined) =>
  (text ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Names offered for a list: what can be picked, plus what the file already has. */
function offered(known: string[], own: string[] | undefined, extra: string[] = []): string[] {
  return [...new Set([...known, ...(own ?? []), ...extra])];
}

interface Local {
  /** Rules typed in on this screen, by list. */
  rules: { allow: string[]; deny: string[] };
}

/** The form's values turned back into the role's fields. */
function fieldsFrom(
  values: Values,
  names: Record<string, string[]>,
  tools: string[],
  before: RoleFields,
): RoleFields {
  const fields: RoleFields = {};
  const text = (key: string) => values[key]?.trim() || undefined;
  fields.description = text("description");
  fields.extends = text("extends");
  fields.model = text("otherModel") ?? text("model");
  fields.effort = text("effort") as RoleFields["effort"];
  fields.permission_mode = text("permission_mode") as RoleFields["permission_mode"];
  if (values.memory) fields.memory = values.memory === ON;

  const more = split(values.moreTools);
  // What the file already lists keeps its order, so an untouched list is not a change.
  const inFileOrder = (own: string[] | undefined, picked: string[]) => [
    ...new Set([...(own ?? []).filter((name) => picked.includes(name)), ...picked]),
  ];
  const ticked = (list: string, all: string[]) =>
    all.filter((name) => values[itemKey(list, name)] === ON);
  if (values.toolsMode === "only") {
    fields.tools = inFileOrder(before.tools, [...ticked("tools", tools), ...more]);
  } else if (values.toolsMode === "except") {
    const denied = tools.filter((name) => values[itemKey("tools", name)] !== ON);
    fields.deny_tools = inFileOrder(before.deny_tools, [...denied, ...more]);
  }
  for (const list of [...NAME_LISTS.map(([key]) => key), ...RULE_LISTS.map(([key]) => key)]) {
    if (values[modeKey(list)] === OWN) {
      fields[list] = inFileOrder(before[list], ticked(list, names[list] ?? []));
    }
  }
  for (const [list] of ID_LISTS) {
    const ids = split(values[list]);
    if (ids.length > 0) fields[list] = ids;
  }
  return fields;
}

/** Only what differs from the file; a key the form no longer has is removed. */
export function roleChanges(before: RoleFields, after: RoleFields): RoleChanges {
  const changes: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "prompt") continue;
    const next = (after as Record<string, unknown>)[key];
    if (!same((before as Record<string, unknown>)[key], next)) changes[key] = next ?? null;
  }
  return changes as RoleChanges;
}

/** What the history screens need of one file: a role's, a workflow's. */
export interface VersionSource {
  /** The file's name as titles show it. */
  name: string;
  history(): History;
  diff(from: number, to: number): string[];
  switchTo(n: number): void;
  /** What to say after a switch, given the version it is at now. */
  switched(n: number): string;
}

/** The versions of a file, what each changed, and the way back to one. */
export function historyScreen(source: VersionSource): Screen {
  const { name } = source;
  const history = source.history();
  const versions = [...history.versions].reverse();
  const rows: Row[] = [];
  if (versions.length === 0) rows.push({ kind: "note", text: "Nothing has been recorded yet." });
  for (const version of versions) {
    const current = version.n === history.current;
    // The version it was made from, which after a switch is not the number before it.
    const older =
      history.versions.find((other) => other.n === version.from) ??
      (version.from === undefined
        ? history.versions.filter((other) => other.n < version.n).at(-1)
        : undefined);
    rows.push({
      kind: "button",
      label: `${current ? "*" : " "} v${version.n}`,
      hint: `${formatTime(version.time)}  ${version.source}${current ? "  · current" : ""}`,
      run: () => ({
        to: {
          title: `${name} v${version.n}`,
          rows: [
            {
              kind: "note",
              text: older
                ? [`Changes from v${older.n}:`, ...source.diff(older.n, version.n)].join("\n")
                : "The first version.",
            },
            ...(history.current !== null && history.current !== version.n
              ? [
                  {
                    kind: "note" as const,
                    text: [
                      `Compared with the current v${history.current}:`,
                      ...source.diff(history.current, version.n),
                    ].join("\n"),
                  },
                  {
                    kind: "button" as const,
                    label: "Switch to this version",
                    hint: "every version stays in the history",
                    tone: "good" as const,
                    run: (): Outcome => {
                      source.switchTo(version.n);
                      return {
                        to: {
                          title: "Switched",
                          rows: [
                            {
                              kind: "note",
                              text: source.switched(version.n),
                            },
                            close,
                          ],
                        },
                      };
                    },
                  },
                ]
              : []),
            back,
          ],
        },
      }),
    });
  }
  rows.push(gap, back);
  return { title: `History: ${name}`, rows };
}

export function nameScreen(
  title: string,
  note: string,
  label: string,
  done: (name: string, where: Scope) => Outcome | Promise<Outcome>,
  /** With a place, the screen also asks where the new file is kept, starting at this one. */
  where?: Scope,
  /** What is being named, for the wording of that question. */
  what: Parameters<typeof scopeRow>[0] = "role",
): Screen {
  return {
    title,
    values: where ? { [WHERE]: where } : undefined,
    rows: [
      { kind: "note", text: note },
      { kind: "input", key: "name", label: "Name", placeholder: "letters, digits, - and _" },
      ...(where ? [scopeRow(what)] : []),
      {
        kind: "button",
        label,
        tone: "good",
        run: (values) => {
          const name = values.name?.trim() ?? "";
          if (!name) throw new Error("Type a name first.");
          return done(name, scopeValue(values));
        },
      },
      back,
    ],
  };
}

/** The names of running sessions that use the role, from the daemon when it is running. */
async function sessionsOf(api: WizardApi, name: string): Promise<string[]> {
  try {
    const state = await api.call<WorkspaceState>("GET", "/state");
    return [...(state.main ? [state.main] : []), ...state.agents]
      .filter((agent) => agent.role === name)
      .map((agent) => agent.name);
  } catch {
    return [];
  }
}

export function roleScreen(
  api: WizardApi,
  store: RoleStore,
  ref: RoleRef,
  local: Local = { rules: { allow: [], deny: [] } },
  /**
   * Shows only what a session may use, for something that is not a role file but has the same
   * settings (a workflow step). The store then only has to load and save.
   */
  embed?: { title: string; word: string; done: (changed: boolean) => Outcome },
): Screen {
  const word = embed?.word ?? "role";
  const wanted = typeof ref === "string" ? { name: ref, source: undefined } : ref;
  const listed = store.list();
  const entry = listed.find(
    (other) =>
      other.name === wanted.name &&
      (wanted.source ? other.source === wanted.source : !other.hidden),
  );
  const { name } = wanted;
  const key: ItemRef = { name, source: entry?.source ?? wanted.source ?? "project" };
  const hidden = entry?.hidden ?? false;
  const role = store.load(key);
  const choices = store.choices();
  // A name means the role that is used, so a hidden twin adds nothing to the list.
  const others = [...new Set(listed.map((other) => other.name))].filter((other) => other !== name);
  // No session runs as a hidden role: the name means the project's.
  const running = (): Promise<string[]> => (hidden ? Promise.resolve([]) : sessionsOf(api, name));
  const warned = (action: "save" | "rename" | "delete" | "move", lines: string[]): string =>
    [...lines, ...store.warnings(action, key)].join("\n");
  const tools = offered([...BUILTIN_TOOLS], role.tools, role.deny_tools);
  const names: Record<string, string[]> = {
    mcp: offered(choices.mcp, role.mcp),
    plugins: offered(choices.plugins, role.plugins),
    skills: offered(choices.skills, role.skills),
    off_mcp: offered(choices.projectMcp, role.off_mcp),
    allow: offered([], role.allow, local.rules.allow),
    deny: offered([], role.deny, local.rules.deny),
  };

  const values: Values = {
    description: role.description ?? "",
    extends: role.extends ?? INHERIT,
    model: role.model && MODELS.includes(role.model) ? role.model : INHERIT,
    otherModel: role.model && !MODELS.includes(role.model) ? role.model : "",
    effort: role.effort ?? INHERIT,
    permission_mode: role.permission_mode ?? INHERIT,
    memory: role.memory === undefined ? INHERIT : role.memory ? ON : OFF,
    toolsMode: role.tools ? "only" : role.deny_tools ? "except" : INHERIT,
    moreTools: "",
  };
  for (const tool of tools) {
    const has = role.tools ? role.tools.includes(tool) : !(role.deny_tools ?? []).includes(tool);
    values[itemKey("tools", tool)] = has ? ON : OFF;
  }
  for (const list of Object.keys(names)) {
    const own = (role as Record<string, string[] | undefined>)[list];
    const typed = (local.rules as Record<string, string[] | undefined>)[list] ?? [];
    values[modeKey(list)] = own || typed.length > 0 ? OWN : INHERIT;
    for (const item of names[list] ?? []) {
      values[itemKey(list, item)] = own?.includes(item) || typed.includes(item) ? ON : OFF;
    }
  }
  for (const [list] of ID_LISTS) values[list] = (role[list] ?? []).join(", ");

  const rows: Row[] = [];
  const describe = embed ? undefined : api.describeRole?.(name);
  if (describe) {
    rows.push(
      { kind: "heading", text: "A SESSION OF THIS ROLE GETS (AS SAVED)" },
      { kind: "note", text: describe },
      gap,
    );
  }
  if (!embed) {
    rows.push(
      { kind: "input", key: "description", label: "Description", placeholder: "one line" },
      {
        kind: "choice",
        key: "extends",
        label: "Starts from (extends)",
        options: [{ value: INHERIT, label: "nothing" }, ...inheritOr(others).slice(1)],
      },
    );
  }
  rows.push(
    { kind: "choice", key: "model", label: "Model", options: inheritOr(MODELS) },
    { kind: "input", key: "otherModel", label: "Other model", placeholder: "a full model name" },
    { kind: "choice", key: "effort", label: "Effort", options: inheritOr(EFFORT_LEVELS) },
    {
      kind: "choice",
      key: "permission_mode",
      label: "Permission mode",
      options: inheritOr(PERMISSION_MODES),
    },
    {
      kind: "choice",
      key: "memory",
      label: "The Claude command's own project memory",
      options: [
        { value: INHERIT, label: "inherit" },
        { value: ON, label: "on" },
        { value: OFF, label: "off" },
      ],
    },
    gap,
    { kind: "heading", text: "BUILT-IN TOOLS" },
    {
      kind: "choice",
      key: "toolsMode",
      label: `This ${word} has`,
      options: [
        { value: INHERIT, label: "what it inherits" },
        { value: "except", label: "all but the unticked" },
        { value: "only", label: "only the ticked" },
      ],
    },
    ...tools.map((tool): Row => ({ kind: "check", key: itemKey("tools", tool), label: tool })),
    {
      kind: "input",
      key: "moreTools",
      label: "Other tool names",
      placeholder: "separated by commas; added to the list the choice above keeps",
    },
  );

  for (const [list, heading, label] of NAME_LISTS) {
    const items = names[list] ?? [];
    rows.push(gap, { kind: "heading", text: heading });
    rows.push({
      kind: "choice",
      key: modeKey(list),
      label: label.replace("role", word),
      options: [
        { value: INHERIT, label: "inherit" },
        { value: OWN, label: items.length > 0 ? "the ticked ones" : "none" },
      ],
    });
    for (const item of items) rows.push({ kind: "check", key: itemKey(list, item), label: item });
  }

  for (const [list, heading] of RULE_LISTS) {
    rows.push(gap, { kind: "heading", text: `RULES: ${heading}` });
    rows.push({
      kind: "choice",
      key: modeKey(list),
      label: `This ${word} has`,
      options: [
        { value: INHERIT, label: "what it inherits" },
        { value: OWN, label: "the ticked rules" },
      ],
    });
    for (const rule of names[list] ?? []) {
      rows.push({ kind: "check", key: itemKey(list, rule), label: rule });
    }
    const inputKey = `new:${list}`;
    rows.push(
      { kind: "input", key: inputKey, label: "Add a rule", placeholder: "Bash(git log *)" },
      {
        kind: "button",
        label: `Add to the ${list} rules`,
        run: (current) => {
          const rule = current[inputKey]?.trim() ?? "";
          if (!rule) throw new Error("Type the rule first.");
          if ((names[list] ?? []).includes(rule)) throw new Error("That rule is already listed.");
          local.rules[list].push(rule);
          const next = roleScreen(api, store, key, local, embed);
          return {
            replace: {
              ...next,
              values: { [inputKey]: "", [itemKey(list, rule)]: ON, [modeKey(list)]: OWN },
            },
          };
        },
      },
    );
  }

  rows.push(gap, { kind: "heading", text: "BUILT INTO THE CLAUDE COMMAND" });
  for (const [list, label, placeholder] of ID_LISTS) {
    rows.push({ kind: "input", key: list, label, placeholder });
  }

  const edited = (current: Values) => roleChanges(role, fieldsFrom(current, names, tools, role));
  const unsaved = (current: Values) => Object.keys(edited(current)).length;
  const needSaved = (current: Values) => {
    if (unsaved(current) > 0) throw new Error("Save or undo your changes on this screen first.");
  };

  const changeCount: Row = {
    kind: "note",
    text: "",
    live: (current) => {
      const count = unsaved(current);
      return count === 0 ? "No changes" : `${count} setting${count === 1 ? "" : "s"} changed`;
    },
  };
  if (embed) {
    rows.push(
      gap,
      changeCount,
      {
        kind: "button",
        label: "Apply",
        tone: "good",
        run: (current) => {
          const changes = edited(current);
          if (Object.keys(changes).length === 0) return embed.done(false);
          store.save(key, changes);
          return embed.done(true);
        },
      },
      back,
    );
    return { title: embed.title, rows, values };
  }

  rows.push(
    gap,
    changeCount,
    {
      kind: "button",
      label: "Save",
      tone: "good",
      run: async (current) => {
        const changes = edited(current);
        if (Object.keys(changes).length === 0) throw new Error("Nothing was changed.");
        const version = store.save(key, changes);
        const sessions = await running();
        const note =
          sessions.length > 0
            ? `Running now with the old settings: ${sessions.join(", ")}.\nThe tools dialog can bring a session up to date.`
            : "Sessions started from now on use it.";
        return {
          to: {
            title: "Saved",
            rows: [
              { kind: "note", text: warned("save", [`Role ${name} is at v${version}.`, note]) },
              ...(sessions.length > 0
                ? [
                    {
                      kind: "button" as const,
                      label: "Bring them up to date",
                      hint: "a working session restarts when its turn ends",
                      tone: "good" as const,
                      run: async (): Promise<Outcome> => {
                        await api.call("POST", "/agents/refresh", {
                          targets: sessions,
                          when: "turn-end",
                        });
                        return { to: rolesScreen(api, store) };
                      },
                    },
                  ]
                : []),
              {
                kind: "button",
                label: "Back to the roles",
                run: () => ({ to: rolesScreen(api, store) }),
              },
              close,
            ],
          },
        };
      },
    },
    {
      kind: "button",
      label: "Edit the prompt…",
      hint: "opens $EDITOR",
      run: (current) => {
        needSaved(current);
        return { exec: ["role", "edit-prompt", formatRef(key)] };
      },
    },
    {
      kind: "button",
      label: "History…",
      run: () => ({
        to: historyScreen({
          name,
          history: () => store.history(key),
          diff: (from, to) => store.diff(key, from, to),
          switchTo: (n) => store.switchTo(key, n),
          switched: (n) =>
            `Role ${name} is at v${n} now. Sessions that are running keep what\nthey were started with; the tools dialog can bring them up to date.`,
        }),
      }),
    },
    {
      kind: "button",
      label: "Duplicate…",
      run: (current) => {
        needSaved(current);
        return {
          to: nameScreen(
            `Copy of ${name}`,
            "The new role starts as an exact copy.",
            "Create",
            (to, where) => {
              store.duplicate(key, to, where);
              return { to: roleScreen(api, store, { name: to, source: where }) };
            },
            key.source,
          ),
        };
      },
    },
    {
      kind: "button",
      label: "Rename…",
      run: async (current) => {
        needSaved(current);
        const sessions = await running();
        if (sessions.length > 0) {
          throw new Error(`Stop its running sessions first: ${sessions.join(", ")}.`);
        }
        return {
          to: nameScreen(
            `Rename ${name}`,
            warned("rename", [
              hidden
                ? "Only this file is renamed: what names the role here means the project's."
                : "Roles that extend it, the config and the workflows are changed to the new name.",
            ]),
            "Rename",
            (to) => {
              store.rename(key, to);
              return { to: roleScreen(api, store, { name: to, source: key.source }) };
            },
          ),
        };
      },
    },
    {
      kind: "button",
      label: moveLabel(key.source),
      run: (current) => {
        needSaved(current);
        const to: Scope = key.source === "user" ? "project" : "user";
        return {
          to: {
            title: `Move ${name}`,
            rows: [
              {
                kind: "note",
                text: warned("move", [
                  to === "user"
                    ? "The file goes to your personal dwa folder and leaves the project."
                    : "The file goes into the project, for everyone who uses it.",
                  "Its history moves with it, and the name stays.",
                ]),
              },
              {
                kind: "button",
                label: to === "user" ? "Move it to my personal folder" : "Move it into the project",
                tone: "good",
                run: () => {
                  store.move(key, to);
                  return { to: roleScreen(api, store, { name, source: to }) };
                },
              },
              back,
            ],
          },
        };
      },
    },
    {
      kind: "button",
      label: "Delete…",
      tone: "bad",
      run: async () => {
        const users = [
          ...store.users(key),
          ...(await running()).map((session) => `running session ${session}`),
        ];
        if (users.length > 0) {
          return {
            to: {
              title: `${name} is in use`,
              rows: [
                {
                  kind: "note",
                  text: `It cannot be deleted while these use it:\n${users.join("\n")}`,
                },
                back,
              ],
            },
          };
        }
        return {
          to: {
            title: `Delete ${name}?`,
            rows: [
              {
                kind: "note",
                text: warned("delete", [
                  "The file is removed. Its versions stay in the history folder.",
                ]),
              },
              {
                kind: "button",
                label: "Yes, delete it",
                tone: "bad",
                run: () => {
                  store.remove(key);
                  return { to: rolesScreen(api, store) };
                },
              },
              back,
            ],
          },
        };
      },
    },
    back,
  );
  return { title: `Role: ${scopeTitle(name, key.source)}`, rows, values };
}

/** The roles, and a way to add one. */
export function rolesScreen(api: WizardApi, store: RoleStore): Screen {
  const roles = store.list();
  const rows: Row[] = [];
  if (roles.length === 0) {
    rows.push({ kind: "note", text: "No roles yet. `dwa init --roles` adds four to start from." });
  }
  for (const role of roles) {
    rows.push({
      kind: "button",
      label: role.name,
      hint: role.error ?? [scopeHint(role, "role"), role.description].filter(Boolean).join(" · "),
      tone: role.error ? "bad" : undefined,
      run: () => ({ to: roleScreen(api, store, { name: role.name, source: role.source }) }),
    });
  }
  rows.push(
    gap,
    {
      kind: "button",
      label: "New role…",
      tone: "good",
      run: () => ({
        to: {
          title: "New role",
          rows: [
            { kind: "input", key: "name", label: "Name", placeholder: "letters, digits, - and _" },
            { kind: "input", key: "description", label: "Description", placeholder: "one line" },
            scopeRow("role"),
            {
              kind: "button",
              label: "Create",
              tone: "good",
              run: (values) => {
                const name = values.name?.trim() ?? "";
                if (!name) throw new Error("Type a name first.");
                const where = scopeValue(values);
                store.create(name, values.description?.trim() ?? "", where);
                return { to: roleScreen(api, store, { name, source: where }) };
              },
            },
            back,
          ],
        },
      }),
    },
    close,
  );
  return { title: "Role settings", rows };
}
