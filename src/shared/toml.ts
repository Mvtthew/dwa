// Writing TOML: values as text, and changes to single keys or whole tables of an existing file
// that leave every other byte, comments included, as it was. Reading is Bun's own parser.

/** A value dwa writes into a config or role file. */
export type TomlValue = string | number | boolean | string[] | { [key: string]: string };

/** A file could not be changed without risking its other contents. */
export class TomlEditError extends Error {}

/** Longest `key = [ ... ]` that is still written on one line. */
const ONE_LINE = 100;

/** Escapes the control characters TOML does not allow raw in a string. Tab and newline stay. */
function escapeControl(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    const raw = code >= 0x20 ? code !== 0x7f : code === 0x09 || code === 0x0a;
    out += raw ? char : `\\u${code.toString(16).padStart(4, "0")}`;
  }
  return out;
}

export function tomlString(value: string): string {
  if (!value.includes("\n")) return escapeControl(JSON.stringify(value));
  // A quote is escaped only where it could be read as part of the closing delimiter.
  const body = value.replace(/\\/g, "\\\\").replace(/"(?="|$)/g, '\\"');
  return `"""\n${escapeControl(body)}"""`;
}

/** A value as it stands after `key = `. A long list goes on several lines, one item each. */
export function tomlValue(value: TomlValue, key = ""): string {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "object" && !Array.isArray(value)) return inlineTable(value);
  if (!Array.isArray(value)) return String(value);
  const items = value.map(tomlString);
  const oneLine = `[${items.join(", ")}]`;
  if (key.length + 3 + oneLine.length <= ONE_LINE && !oneLine.includes("\n")) return oneLine;
  return `[\n${items.map((item) => `  ${item},\n`).join("")}]`;
}

/** A flat record of strings as an inline table, such as an MCP server's `env`. */
function inlineTable(value: { [key: string]: string }): string {
  const parts = Object.entries(value).map(
    ([key, item]) =>
      `${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)} = ${tomlString(item)}`,
  );
  return parts.length > 0 ? `{ ${parts.join(", ")} }` : "{}";
}

/** One `key = value` statement of a file, by position. */
interface Entry {
  /** Table the key is in; null for the keys before the first table header. */
  table: string | null;
  key: string;
  /** Start of the line the statement begins on. */
  lineStart: number;
  keyStart: number;
  valueStart: number;
  /** Just past the last character of the value. */
  valueEnd: number;
  /** Just past the newline of the line the value ends on (or the end of the text). */
  lineEnd: number;
}

interface Header {
  /** The table's path joined with dots, quotes and spaces of the header removed. */
  table: string;
  /** `[[name]]`: one of a list of tables. */
  array: boolean;
  lineStart: number;
  lineEnd: number;
  /** The name as written between the brackets. */
  nameStart: number;
  nameEnd: number;
}

/** The parts of a table name as written in a header: `steps."my step"` is two parts. */
function tablePath(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of raw) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ".") {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current.trim());
  return parts;
}

/** A table path as a header names it; a part that is not a bare key is quoted. */
function headerName(table: string): string {
  return table
    .split(".")
    .map((part) => (/^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(".");
}

interface Layout {
  entries: Entry[];
  headers: Header[];
}

/** The line ending a text uses, so what is added to it ends its lines the same way. */
function lineEnd(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function lineEndAfter(text: string, from: number): number {
  const newline = text.indexOf("\n", from);
  return newline === -1 ? text.length : newline + 1;
}

/** Index just past a string that starts at `start`, for all four TOML string forms. */
function skipString(text: string, start: number): number {
  const quote = text[start] as string;
  if (text.startsWith(quote.repeat(3), start)) {
    let i = start + 3;
    while (i < text.length) {
      if (quote === '"' && text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text.startsWith(quote.repeat(3), i)) {
        i += 3;
        // Up to two more quotes may belong to the content, right before the delimiter.
        while (text[i] === quote) i += 1;
        return i;
      }
      i += 1;
    }
    throw new TomlEditError("a multi-line string is not closed");
  }
  let i = start + 1;
  while (i < text.length && text[i] !== "\n") {
    if (quote === '"' && text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i += 1;
  }
  throw new TomlEditError("a string is not closed");
}

/** Index just past the value that starts at `start`: the rest of the line, or a whole list. */
function skipValue(text: string, start: number): number {
  let depth = 0;
  let end = start;
  let i = start;
  while (i < text.length) {
    const char = text[i] as string;
    if (char === '"' || char === "'") {
      i = skipString(text, i);
      end = i;
      continue;
    }
    if (char === "#") {
      if (depth === 0) break;
      i = lineEndAfter(text, i);
      continue;
    }
    if (char === "\n") {
      if (depth === 0) break;
      i += 1;
      continue;
    }
    if (char === "[" || char === "{") depth += 1;
    if (char === "]" || char === "}") depth -= 1;
    i += 1;
    if (char !== " " && char !== "\t" && char !== "\r") end = i;
  }
  if (depth !== 0) throw new TomlEditError("a list is not closed");
  return end;
}

/** Where every statement and table header of a file is. */
function layout(text: string): Layout {
  const entries: Entry[] = [];
  const headers: Header[] = [];
  let table: string | null = null;
  let pos = 0;
  while (pos < text.length) {
    const lineStart = pos;
    let i = pos;
    while (text[i] === " " || text[i] === "\t") i += 1;
    const char = text[i];
    if (char === undefined || char === "\n" || char === "\r" || char === "#") {
      pos = lineEndAfter(text, i);
      continue;
    }
    if (char === "[") {
      const lineEnd = lineEndAfter(text, i);
      const match = /^(\[\[?\s*)([^\]]+?)\s*\]\]?/.exec(text.slice(i, lineEnd));
      if (!match) throw new TomlEditError("a table header could not be read");
      const [, open, name] = match as unknown as [string, string, string];
      table = tablePath(name).join(".");
      const nameStart = i + open.length;
      headers.push({
        table,
        array: open.startsWith("[["),
        lineStart,
        lineEnd,
        nameStart,
        nameEnd: nameStart + name.length,
      });
      pos = lineEnd;
      continue;
    }
    const equals = text.indexOf("=", i);
    const newline = text.indexOf("\n", i);
    if (equals === -1 || (newline !== -1 && newline < equals)) {
      throw new TomlEditError("a line is neither a key nor a table");
    }
    const key = text
      .slice(i, equals)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    let valueStart = equals + 1;
    while (text[valueStart] === " " || text[valueStart] === "\t") valueStart += 1;
    const valueEnd = skipValue(text, valueStart);
    const lineEnd = lineEndAfter(text, valueEnd);
    entries.push({ table, key, lineStart, keyStart: i, valueStart, valueEnd, lineEnd });
    pos = lineEnd;
  }
  return { entries, headers };
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

interface Item {
  value: string;
  start: number;
  end: number;
}

/** The strings of a list value with their positions, or null when it holds anything else. */
function listItems(text: string, start: number, end: number): Item[] | null {
  const items: Item[] = [];
  let i = start + 1;
  while (i < end - 1) {
    const char = text[i] as string;
    if (char === "#") {
      i = lineEndAfter(text, i);
    } else if (char === '"' || char === "'") {
      const itemEnd = skipString(text, i);
      let value: unknown;
      try {
        value = (Bun.TOML.parse(`v = ${text.slice(i, itemEnd)}`) as { v: unknown }).v;
      } catch {
        return null;
      }
      if (typeof value !== "string") return null;
      items.push({ value, start: i, end: itemEnd });
      i = itemEnd;
    } else if (/[\s,]/.test(char)) {
      i += 1;
    } else {
      return null;
    }
  }
  return items;
}

/**
 * Changes a list that is written over several lines item by item, so comments between the
 * items stay. Null when that is not possible (the order changed, or an item shares its line);
 * the caller then writes the list afresh.
 */
function editList(text: string, entry: Entry, wanted: string[]): Edit[] | null {
  const current = text.slice(entry.valueStart, entry.valueEnd);
  if (!current.startsWith("[") || !current.includes("\n")) return null;
  const items = listItems(text, entry.valueStart, entry.valueEnd);
  if (!items || new Set(items.map((item) => item.value)).size !== items.length) return null;
  const kept = items.filter((item) => wanted.includes(item.value));
  const added = wanted.filter((value) => !items.some((item) => item.value === value));
  // Only "some removed, some appended" keeps the layout; anything else is a new order.
  const expected = [...kept.map((item) => item.value), ...added];
  if (expected.length !== wanted.length || expected.some((value, i) => value !== wanted[i])) {
    return null;
  }

  const edits: Edit[] = [];
  const lineOf = (item: Item) => {
    const start = text.lastIndexOf("\n", item.start) + 1;
    const end = lineEndAfter(text, item.end);
    return { start, end, text: text.slice(start, end) };
  };
  const alone = (item: Item) => {
    const line = lineOf(item);
    const before = text.slice(line.start, item.start);
    const after = text.slice(item.end, line.end);
    return /^\s*$/.test(before) && /^\s*,?\s*(#.*)?\r?\n?$/.test(after);
  };
  for (const item of items) {
    if (wanted.includes(item.value)) continue;
    if (!alone(item)) return null;
    const line = lineOf(item);
    edits.push({ start: line.start, end: line.end, text: "" });
  }
  if (added.length > 0) {
    const last = kept.at(-1);
    if (last && !alone(last)) return null;
    const indent = last ? (/^\s*/.exec(lineOf(last).text)?.[0] ?? "  ") : "  ";
    const lines = added.map((value) => `${indent}${tomlString(value)},\n`).join("");
    if (last) {
      const line = lineOf(last);
      // The item that was last may have no comma yet.
      const comma = /^\s*,/.test(text.slice(last.end, line.end)) ? "" : ",";
      if (comma) edits.push({ start: last.end, end: last.end, text: comma });
      edits.push({ start: line.end, end: line.end, text: lines });
    } else {
      // Nothing is kept: the new items go right after the opening bracket's line.
      const at = lineEndAfter(text, entry.valueStart);
      edits.push({ start: at, end: at, text: lines });
    }
  }
  return edits;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The object at a path of a parsed file; with `create`, missing tables on the way are added. */
function dig(
  root: Record<string, unknown>,
  path: string[],
  create = false,
): Record<string, unknown> | undefined {
  let at = root;
  for (const part of path) {
    if (at[part] === undefined) {
      if (!create) return undefined;
      at[part] = {};
    }
    const next = at[part];
    if (next === null || typeof next !== "object" || Array.isArray(next)) return undefined;
    at = next as Record<string, unknown>;
  }
  return at;
}

/** Removes the empty tables along a path that `before` did not have: nothing wrote them. */
function pruneNew(
  expected: Record<string, unknown>,
  before: Record<string, unknown>,
  path: string[],
): void {
  for (let depth = path.length; depth > 0; depth--) {
    const here = dig(expected, path.slice(0, depth));
    if (!here || Object.keys(here).length > 0 || dig(before, path.slice(0, depth))) return;
    const parent = dig(expected, path.slice(0, depth - 1));
    if (parent) delete parent[path[depth - 1] as string];
  }
}

function parseOrThrow(text: string): Record<string, unknown> {
  try {
    return Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new TomlEditError(`the change would break the file: ${(error as Error).message}`);
  }
}

/**
 * Sets, adds or removes (value `undefined`) keys of one table of a TOML text; `table` null
 * means the keys before the first table header, and a nested table is named with dots
 * (`steps.build`). Everything else in the text stays as it is.
 * New root keys go after the last existing one and before any key named in `last` (a role's
 * prompt reads best at the end). The result is parsed and compared with what was asked for;
 * when it does not match, nothing is returned and a `TomlEditError` is thrown.
 */
export function setKeys(
  text: string,
  table: string | null,
  changes: Record<string, TomlValue | undefined>,
  last: string[] = [],
): string {
  return setKeysIn(text, table, changes, last);
}

/**
 * The same for one table of a list of tables (`[[agents]]`): the one at `index`, counted from 0
 * in the order they are written.
 */
export function setKeysAt(
  text: string,
  table: string,
  index: number,
  changes: Record<string, TomlValue | undefined>,
): string {
  return setKeysIn(text, table, changes, [], index);
}

function setKeysIn(
  text: string,
  table: string | null,
  changes: Record<string, TomlValue | undefined>,
  last: string[],
  index?: number,
): string {
  const before = Bun.TOML.parse(text) as Record<string, unknown>;
  const { entries, headers } = layout(text);
  const listed = headers.some((header) => header.table === table && header.array);
  if (listed !== (index !== undefined)) {
    throw new TomlEditError(
      listed ? `"${table}" is a list of tables` : `"${table}" is not a list of tables`,
    );
  }
  // One of a list of tables is the run of lines from its header to the next table's.
  const own = index === undefined ? undefined : listBlocks(text, table as string)[index];
  if (index !== undefined && !own) {
    throw new TomlEditError(`there is no [[${table}]] number ${index + 1}`);
  }
  const inTable = entries.filter(
    (entry) =>
      entry.table === table &&
      (!own || (entry.lineStart >= own.header.lineEnd && entry.lineEnd <= own.end)),
  );
  const edits: Edit[] = [];
  const inserts: string[] = [];
  const nl = lineEnd(text);

  for (const [key, value] of Object.entries(changes)) {
    const found = inTable.filter((entry) => entry.key === key);
    if (found.length > 1) throw new TomlEditError(`"${key}" is set more than once`);
    const entry = found[0];
    if (!entry) {
      if (value !== undefined) inserts.push(`${key} = ${tomlValue(value, key)}${nl}`);
    } else if (value === undefined) {
      edits.push({ start: entry.lineStart, end: entry.lineEnd, text: "" });
    } else {
      const items = Array.isArray(value) ? editList(text, entry, value) : null;
      if (items) edits.push(...items);
      else {
        edits.push({ start: entry.valueStart, end: entry.valueEnd, text: tomlValue(value, key) });
      }
    }
  }

  if (inserts.length > 0) {
    const block = inserts.join("");
    const anchor = inTable.filter((entry) => !last.includes(entry.key)).at(-1);
    const tail = inTable.find((entry) => last.includes(entry.key));
    const header = own ? own.header : headers.find((candidate) => candidate.table === table);
    const firstHeader = headers[0];
    if (anchor) {
      const newline = text.endsWith("\n") || anchor.lineEnd < text.length ? "" : nl;
      edits.push({ start: anchor.lineEnd, end: anchor.lineEnd, text: `${newline}${block}` });
    } else if (tail) {
      // A root file keeps an empty line before its long last key; a table's keys stay together.
      const gap = table === null ? nl : "";
      edits.push({ start: tail.lineStart, end: tail.lineStart, text: `${block}${gap}` });
    } else if (table !== null && header) {
      edits.push({ start: header.lineEnd, end: header.lineEnd, text: block });
    } else if (table === null && firstHeader) {
      // Before the first table and the comment that belongs to it. A comment that opens the
      // file is the file's own, so there the key goes under it.
      const start = blocks(text)[0]?.start ?? firstHeader.lineStart;
      const at = start === 0 ? firstHeader.lineStart : start;
      edits.push({ start: at, end: at, text: `${block}${nl}` });
    } else {
      // Nothing to hang it on: the end of the file, under a new table header when needed.
      const newline = text === "" || text.endsWith("\n") ? "" : nl;
      const heading = table === null ? "" : `${text === "" ? "" : nl}[${headerName(table)}]${nl}`;
      edits.push({ start: text.length, end: text.length, text: `${newline}${heading}${block}` });
    }
  }

  // From the end, so earlier positions stay valid; insertions at one position keep their order.
  let result = text;
  const ordered = edits.map((edit, index) => ({ ...edit, index }));
  ordered.sort(
    (a, b) =>
      b.start - a.start ||
      // A removal goes before an insertion at its start, or it would take the new text along.
      Number(b.end > b.start) - Number(a.end > a.start) ||
      b.index - a.index,
  );
  for (const edit of ordered) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }

  const after = parseOrThrow(result);
  const expected = structuredClone(before);
  const path = table === null ? [] : table.split(".");
  let target: Record<string, unknown> | undefined;
  if (index === undefined) target = dig(expected, path, true);
  else {
    const holder = dig(expected, path.slice(0, -1));
    const all = holder?.[path.at(-1) as string];
    target = Array.isArray(all) ? (all[index] as Record<string, unknown>) : undefined;
  }
  if (!target) throw new TomlEditError(`"${table}" is not a table`);
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete target[key];
    else target[key] = value;
  }
  if (index === undefined) pruneNew(expected, before, path);
  if (!same(sortKeys(after), sortKeys(expected))) {
    throw new TomlEditError("the change could not be made without touching other settings");
  }
  return result;
}

/**
 * Replaces single values wherever they are, tables of any depth included: `change` sees every
 * `key = value` of the text and returns a new value or `undefined` to leave it. Used to follow
 * a renamed role through the files that name it.
 */
export function mapValues(
  text: string,
  change: (table: string | null, key: string, value: unknown) => TomlValue | undefined,
): string {
  const edits: Edit[] = [];
  for (const entry of layout(text).entries) {
    let value: unknown;
    try {
      const source = text.slice(entry.valueStart, entry.valueEnd);
      value = (Bun.TOML.parse(`v = ${source}`) as { v: unknown }).v;
    } catch {
      continue;
    }
    const next = change(entry.table, entry.key, value);
    if (next === undefined) continue;
    edits.push({ start: entry.valueStart, end: entry.valueEnd, text: tomlValue(next, entry.key) });
  }
  let result = text;
  for (const edit of edits.reverse()) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  try {
    Bun.TOML.parse(result);
  } catch (error) {
    throw new TomlEditError(`the change would break the file: ${(error as Error).message}`);
  }
  return result;
}

/** Key order does not matter when two parsed files are compared. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/** One table of a file as a run of lines: its header, the comment lines right above it, and
 * everything up to the next table. */
interface Block {
  table: string;
  array: boolean;
  start: number;
  end: number;
  header: Header;
}

function blocks(text: string): Block[] {
  const { entries, headers } = layout(text);
  const starts = headers.map((header) => {
    // Comment lines directly above the header belong to it; a blank line ends them, and so
    // does the statement before (whose last line may look like a comment inside a string).
    const floor = entries.findLast((entry) => entry.lineEnd <= header.lineStart)?.lineEnd ?? 0;
    let start = header.lineStart;
    while (start > floor) {
      const previous = text.lastIndexOf("\n", start - 2) + 1;
      if (previous < floor || !text.slice(previous, start).trimStart().startsWith("#")) break;
      start = previous;
    }
    return start;
  });
  return headers.map((header, index) => ({
    table: header.table,
    array: header.array,
    start: starts[index] as number,
    end: starts[index + 1] ?? text.length,
    header,
  }));
}

function parentOf(table: string): string {
  return table.includes(".") ? table.slice(0, table.lastIndexOf(".")) : "";
}

/** The table's block. Refused for a missing table, a list of tables, or one with tables inside. */
function wholeTable(text: string, table: string): Block {
  const all = blocks(text);
  const found = all.filter((block) => block.table === table);
  if (found.length === 0) throw new TomlEditError(`there is no table [${table}]`);
  if (found.length > 1 || found[0]?.array) {
    throw new TomlEditError(`[${table}] is written more than once`);
  }
  if (all.some((block) => block.table.startsWith(`${table}.`))) {
    throw new TomlEditError(`[${table}] has tables inside it`);
  }
  return found[0] as Block;
}

/** Puts a block in at a block boundary, one empty line away from its neighbours. */
function insertBlock(text: string, at: number, block: string): string {
  const nl = lineEnd(text);
  const head = text.slice(0, at);
  const tail = text.slice(at);
  const piece = `${block.replace(/\s+$/, "")}${nl}`;
  const lead = head === "" || head.endsWith(nl + nl) ? "" : head.endsWith("\n") ? nl : nl + nl;
  return head + lead + piece + (tail === "" ? "" : nl) + tail;
}

/** Takes a block out. What was the last table leaves no empty lines behind at the end. */
function cutBlock(text: string, block: Block): string {
  const rest = text.slice(0, block.start) + text.slice(block.end);
  return block.end === text.length ? rest.replace(/(\r?\n)\s*$/, "$1") : rest;
}

/** Where a table goes: before the named one, otherwise after the last table next to it. */
function slot(text: string, table: string, before: string | null | undefined): number {
  const all = blocks(text);
  if (before != null) {
    const target = all.find((block) => block.table === before);
    if (!target) throw new TomlEditError(`there is no table [${before}]`);
    return target.start;
  }
  const parent = parentOf(table);
  const last = all.findLast((block) => parentOf(block.table) === parent);
  if (!last) return text.length;
  // After the tables inside the last one too: they belong to it.
  let at = all.indexOf(last);
  while (all[at + 1]?.table.startsWith(`${last.table}.`)) at += 1;
  return (all[at] as Block).end;
}

/**
 * The tables directly under `parent` in the order they are written: for "steps", the names
 * after `steps.` of every `[steps.<name>]`.
 */
export function tableOrder(text: string, parent: string): string[] {
  return layout(text)
    .headers.filter((header) => header.table !== "" && parentOf(header.table) === parent)
    .map((header) => header.table.slice(parent === "" ? 0 : parent.length + 1));
}

function sameOrder(text: string, parent: string, wanted: string[]): void {
  if (!same(tableOrder(text, parent), wanted)) {
    throw new TomlEditError("the tables did not end up in the order asked for");
  }
}

/**
 * Adds a table with its keys: before the table `before`, otherwise after the last table next
 * to it. Keys named in `last` are written at the end. The rest of the text stays as it is.
 */
export function addTable(
  text: string,
  table: string,
  body: Record<string, TomlValue>,
  options: { before?: string | null; last?: string[] } = {},
): string {
  const before = Bun.TOML.parse(text) as Record<string, unknown>;
  const path = table.split(".");
  if (dig(before, path)) throw new TomlEditError(`there is already a table [${table}]`);
  const last = options.last ?? [];
  const keys = [
    ...Object.keys(body).filter((key) => !last.includes(key)),
    ...Object.keys(body).filter((key) => last.includes(key)),
  ];
  const nl = lineEnd(text);
  const lines = keys.map((key) => `${key} = ${tomlValue(body[key] as TomlValue, key)}${nl}`);
  const parent = parentOf(table);
  const order = tableOrder(text, parent);
  const name = table.slice(parent === "" ? 0 : parent.length + 1);
  const index =
    options.before != null
      ? order.indexOf(options.before.slice(parent === "" ? 0 : parent.length + 1))
      : -1;
  const result = insertBlock(
    text,
    slot(text, table, options.before),
    `[${headerName(table)}]${nl}${lines.join("")}`,
  );

  const expected = structuredClone(before);
  const holder = dig(expected, path.slice(0, -1), true);
  if (!holder) throw new TomlEditError(`[${table}] cannot be added here`);
  holder[path.at(-1) as string] = { ...body };
  if (!same(sortKeys(parseOrThrow(result)), sortKeys(expected))) {
    throw new TomlEditError("the table could not be added without touching other settings");
  }
  sameOrder(result, parent, index === -1 ? [...order, name] : order.toSpliced(index, 0, name));
  return result;
}

/** Removes a table with the comment lines right above it. */
export function removeTable(text: string, table: string): string {
  const before = Bun.TOML.parse(text) as Record<string, unknown>;
  const result = cutBlock(text, wholeTable(text, table));
  const expected = structuredClone(before);
  const path = table.split(".");
  const holder = dig(expected, path.slice(0, -1));
  if (holder) delete holder[path.at(-1) as string];
  // A parent that only existed through this header is gone with it.
  const after = parseOrThrow(result);
  for (let depth = path.length - 1; depth > 0; depth--) {
    const here = dig(expected, path.slice(0, depth));
    if (!here || Object.keys(here).length > 0 || dig(after, path.slice(0, depth))) break;
    const parent = dig(expected, path.slice(0, depth - 1));
    if (parent) delete parent[path[depth - 1] as string];
  }
  if (!same(sortKeys(after), sortKeys(expected))) {
    throw new TomlEditError("the table could not be removed without touching other settings");
  }
  return result;
}

/** Gives a table another name in its header. Its keys, comments and place stay. */
export function renameTable(text: string, from: string, to: string): string {
  const before = Bun.TOML.parse(text) as Record<string, unknown>;
  const { header } = wholeTable(text, from);
  if (dig(before, to.split("."))) throw new TomlEditError(`there is already a table [${to}]`);
  if (parentOf(from) !== parentOf(to)) {
    throw new TomlEditError("a table can only be renamed where it is");
  }
  const result = text.slice(0, header.nameStart) + headerName(to) + text.slice(header.nameEnd);
  const expected = structuredClone(before);
  const holder = dig(expected, from.split(".").slice(0, -1)) as Record<string, unknown>;
  holder[to.split(".").at(-1) as string] = holder[from.split(".").at(-1) as string];
  delete holder[from.split(".").at(-1) as string];
  if (!same(sortKeys(parseOrThrow(result)), sortKeys(expected))) {
    throw new TomlEditError("the table could not be renamed without touching other settings");
  }
  return result;
}

/**
 * Moves a table, with the comment lines right above it, before the table `before`, or with
 * null after the last table next to it. Nothing but the order changes.
 */
export function moveTable(text: string, table: string, before: string | null): string {
  if (before === table) return text;
  const parsed = Bun.TOML.parse(text) as Record<string, unknown>;
  const block = wholeTable(text, table);
  const parent = parentOf(table);
  const short = (name: string) => name.slice(parent === "" ? 0 : parent.length + 1);
  const order = tableOrder(text, parent).filter((name) => name !== short(table));
  const index = before === null ? order.length : order.indexOf(short(before));
  if (index === -1) throw new TomlEditError(`there is no table [${before}] next to [${table}]`);
  const without = cutBlock(text, block);
  let result = insertBlock(
    without,
    slot(without, table, before),
    text.slice(block.start, block.end),
  );
  // The file ends as it did: with or without a last newline, and without empty lines added.
  if (!text.endsWith("\n")) result = result.replace(/\n$/, "");
  if (!same(sortKeys(parseOrThrow(result)), sortKeys(parsed))) {
    throw new TomlEditError("the table could not be moved without touching other settings");
  }
  sameOrder(result, parent, order.toSpliced(index, 0, short(table)));
  return result;
}

/**
 * Changes one value as it is written, quotes included, so a long text keeps its form (which
 * kind of string, its line breaks). `change` gets the raw text of the value and returns the
 * new one; returning it unchanged changes nothing. The result has to parse.
 */
export function replaceInValue(
  text: string,
  table: string | null,
  key: string,
  change: (raw: string) => string,
): string {
  const found = layout(text).entries.filter((entry) => entry.table === table && entry.key === key);
  if (found.length > 1) throw new TomlEditError(`"${key}" is set more than once`);
  const entry = found[0];
  if (!entry) return text;
  const raw = text.slice(entry.valueStart, entry.valueEnd);
  const next = change(raw);
  if (next === raw) return text;
  const result = text.slice(0, entry.valueStart) + next + text.slice(entry.valueEnd);
  parseOrThrow(result);
  return result;
}

/** The tables of a list of tables (`[[name]]`), in the order they are written. */
function listBlocks(text: string, table: string): Block[] {
  return blocks(text).filter((block) => block.table === table && block.array);
}

/**
 * Adds one more table to a list of tables (`[[agents]]`), after the last one of the list or at
 * the end of the text. The rest of the text stays as it is.
 */
export function addArrayTable(
  text: string,
  table: string,
  body: Record<string, TomlValue>,
): string {
  const before = Bun.TOML.parse(text) as Record<string, unknown>;
  const path = table.split(".");
  const holder = dig(before, path.slice(0, -1));
  const existing = holder?.[path.at(-1) as string];
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new TomlEditError(`"${table}" is not a list of tables`);
  }
  const nl = lineEnd(text);
  const lines = Object.keys(body).map(
    (key) => `${key} = ${tomlValue(body[key] as TomlValue, key)}${nl}`,
  );
  const at = listBlocks(text, table).at(-1)?.end ?? text.length;
  const result = insertBlock(text, at, `[[${headerName(table)}]]${nl}${lines.join("")}`);
  const expected = structuredClone(before);
  const target = dig(expected, path.slice(0, -1), true);
  if (!target) throw new TomlEditError(`[[${table}]] cannot be added here`);
  target[path.at(-1) as string] = [...((existing as unknown[] | undefined) ?? []), { ...body }];
  if (!same(sortKeys(parseOrThrow(result)), sortKeys(expected))) {
    throw new TomlEditError("the table could not be added without touching other settings");
  }
  return result;
}

/** Removes the table at `index` of a list of tables, with the comment lines right above it. */
export function removeArrayTable(text: string, table: string, index: number): string {
  const before = Bun.TOML.parse(text) as Record<string, unknown>;
  const block = listBlocks(text, table)[index];
  if (!block) throw new TomlEditError(`there is no [[${table}]] number ${index + 1}`);
  if (blocks(text).some((other) => other.table.startsWith(`${table}.`))) {
    throw new TomlEditError(`[[${table}]] has tables inside it`);
  }
  const result = cutBlock(text, block);
  const expected = structuredClone(before);
  const path = table.split(".");
  const holder = dig(expected, path.slice(0, -1));
  const all = holder?.[path.at(-1) as string];
  if (holder && Array.isArray(all)) {
    all.splice(index, 1);
    if (all.length === 0) delete holder[path.at(-1) as string];
  }
  if (!same(sortKeys(parseOrThrow(result)), sortKeys(expected))) {
    throw new TomlEditError("the table could not be removed without touching other settings");
  }
  return result;
}

/**
 * Removes a table together with the tables inside it (`[mcp.github]` and `[mcp.github.env]`),
 * which `removeTable` refuses. A table written only through its inner tables goes the same way.
 */
export function removeTableTree(text: string, table: string): string {
  const before = Bun.TOML.parse(text) as Record<string, unknown>;
  const inside = blocks(text).filter(
    (block) => block.table === table || block.table.startsWith(`${table}.`),
  );
  if (inside.length === 0) throw new TomlEditError(`there is no table [${table}]`);
  if (inside.some((block) => block.array)) {
    throw new TomlEditError(`[${table}] holds a list of tables`);
  }
  let result = text;
  // From the end, so the earlier blocks keep their place.
  for (const block of [...inside].reverse()) result = cutBlock(result, block);
  const expected = structuredClone(before);
  const path = table.split(".");
  const holder = dig(expected, path.slice(0, -1));
  if (holder) delete holder[path.at(-1) as string];
  const after = parseOrThrow(result);
  for (let depth = path.length - 1; depth > 0; depth--) {
    const here = dig(expected, path.slice(0, depth));
    if (!here || Object.keys(here).length > 0 || dig(after, path.slice(0, depth))) break;
    const parent = dig(expected, path.slice(0, depth - 1));
    if (parent) delete parent[path[depth - 1] as string];
  }
  if (!same(sortKeys(after), sortKeys(expected))) {
    throw new TomlEditError("the table could not be removed without touching other settings");
  }
  return result;
}
