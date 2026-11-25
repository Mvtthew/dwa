// Writing TOML: values as text, and changes to single keys of an existing file that leave
// every other byte, comments included, as it was. Reading is Bun's own parser.

/** A value dwa writes into a config or role file. */
export type TomlValue = string | number | boolean | string[];

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
  if (!Array.isArray(value)) return String(value);
  const items = value.map(tomlString);
  const oneLine = `[${items.join(", ")}]`;
  if (key.length + 3 + oneLine.length <= ONE_LINE && !oneLine.includes("\n")) return oneLine;
  return `[\n${items.map((item) => `  ${item},\n`).join("")}]`;
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
  table: string;
  lineStart: number;
  lineEnd: number;
}

interface Layout {
  entries: Entry[];
  headers: Header[];
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
      const match = /^\[\[?\s*([^\]]+?)\s*\]\]?/.exec(text.slice(i, lineEnd));
      if (!match) throw new TomlEditError("a table header could not be read");
      table = match[1] as string;
      headers.push({ table, lineStart, lineEnd });
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

/**
 * Sets, adds or removes (value `undefined`) keys of one table of a TOML text; `table` null
 * means the keys before the first table header. Everything else in the text stays as it is.
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
  if (table?.includes(".")) throw new TomlEditError("nested tables cannot be changed");
  const before = Bun.TOML.parse(text) as Record<string, unknown>;
  const { entries, headers } = layout(text);
  const inTable = entries.filter((entry) => entry.table === table);
  const edits: Edit[] = [];
  const inserts: string[] = [];

  for (const [key, value] of Object.entries(changes)) {
    const found = inTable.filter((entry) => entry.key === key);
    if (found.length > 1) throw new TomlEditError(`"${key}" is set more than once`);
    const entry = found[0];
    if (!entry) {
      if (value !== undefined) inserts.push(`${key} = ${tomlValue(value, key)}\n`);
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
    const header = headers.find((candidate) => candidate.table === table);
    const firstHeader = headers[0];
    if (anchor) {
      const newline = text.endsWith("\n") || anchor.lineEnd < text.length ? "" : "\n";
      edits.push({ start: anchor.lineEnd, end: anchor.lineEnd, text: `${newline}${block}` });
    } else if (tail) {
      edits.push({ start: tail.lineStart, end: tail.lineStart, text: `${block}\n` });
    } else if (table !== null && header) {
      edits.push({ start: header.lineEnd, end: header.lineEnd, text: block });
    } else if (table === null && firstHeader) {
      edits.push({ start: firstHeader.lineStart, end: firstHeader.lineStart, text: `${block}\n` });
    } else {
      // Nothing to hang it on: the end of the file, under a new table header when needed.
      const newline = text === "" || text.endsWith("\n") ? "" : "\n";
      const heading = table === null ? "" : `${text === "" ? "" : "\n"}[${table}]\n`;
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

  let after: Record<string, unknown>;
  try {
    after = Bun.TOML.parse(result) as Record<string, unknown>;
  } catch (error) {
    throw new TomlEditError(`the change would break the file: ${(error as Error).message}`);
  }
  const expected = structuredClone(before);
  if (table !== null && expected[table] === undefined) expected[table] = {};
  const target = (table === null ? expected : expected[table]) as Record<string, unknown>;
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete target[key];
    else target[key] = value;
  }
  if (table !== null && Object.keys(target).length === 0 && !(table in before)) {
    delete expected[table];
  }
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
