// Spike S13: can one generated layout string, applied with select-layout, set the whole
// workspace window? Run with `bun spikes/s13/run.ts`. Uses the private spike server only.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dir;
const T = join(DIR, "../t.sh");
const OUT = join(DIR, "../out/s13");
mkdirSync(OUT, { recursive: true });
const WINCH = join(OUT, "winch.log");
const HOOK = join(OUT, "hook.log");
const W = "s13:workspace";

function tmux(...args: string[]): { ok: boolean; out: string; err: string } {
  const p = Bun.spawnSync([T, ...args]);
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}
function t(...args: string[]): string {
  const r = tmux(...args);
  if (!r.ok) throw new Error(`tmux ${args.join(" ")}: ${r.err}`);
  return r.out;
}
const say = (s: string) => console.log(s);
const head = (s: string) => console.log(`\n== ${s}`);
const lines = (file: string) => {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const pane = (name: string) => ["--", "sh", join(DIR, "pane.sh"), name, WINCH];
const P = ["-P", "-F", "#{pane_id}"];

// --- layout strings ---------------------------------------------------------------------
type Node = { size?: number; id?: string; dir?: "h" | "v"; kids?: Node[] };
export function checksum(body: string): string {
  let csum = 0;
  for (const ch of body) {
    csum = (csum >> 1) | ((csum & 1) << 15);
    csum = (csum + ch.charCodeAt(0)) & 0xffff;
  }
  return csum.toString(16).padStart(4, "0");
}
/** Children take `size` cells along the parent's direction; the one without takes the rest. */
function print(
  n: Node,
  x: number,
  y: number,
  w: number,
  h: number,
  geo: Map<string, string>,
): string {
  const base = `${w}x${h},${x},${y}`;
  if (n.id !== undefined) {
    geo.set(n.id, y === 0 ? `${x} 1 ${w} ${h - 1}` : `${x} ${y} ${w} ${h}`);
    return `${base},${n.id.replace("%", "")}`;
  }
  const kids = n.kids ?? [];
  const total = n.dir === "h" ? w : h;
  const fixed = kids.reduce((sum, k) => sum + (k.size ?? 0), 0);
  const rest = total - fixed - (kids.length - 1);
  let at = n.dir === "h" ? x : y;
  const parts = kids.map((k) => {
    const s = k.size ?? rest;
    const part = n.dir === "h" ? print(k, at, y, s, h, geo) : print(k, x, at, w, s, geo);
    at += s + 1;
    return part;
  });
  return n.dir === "h" ? `${base}{${parts.join(",")}}` : `${base}[${parts.join(",")}]`;
}
function layout(root: Node, w: number, h: number): { text: string; geo: Map<string, string> } {
  const geo = new Map<string, string>();
  const body = print(root, 0, 0, w, h, geo);
  return { text: `${checksum(body)},${body}`, geo };
}
const real = () =>
  new Map(
    t(
      "list-panes",
      "-t",
      W,
      "-F",
      "#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height}",
    )
      .split("\n")
      .map((l) => {
        const [id = "", ...rest] = l.split(" ");
        return [id, rest.join(" ")] as const;
      }),
  );
const order = () =>
  t("list-panes", "-t", W, "-F", "#{pane_id}:#{pane_title}").split("\n").join(" ");
function compare(label: string, want: Map<string, string>): boolean {
  const got = real();
  let same = true;
  for (const [id, g] of want) if (got.get(id) !== g) same = false;
  say(`${label}: ${same ? "geometry as planned" : "DIFFERENT"}`);
  if (!same) for (const [id, g] of want) say(`  ${id} want ${g} got ${got.get(id)}`);
  return same;
}
const size = () =>
  t(
    "display-message",
    "-p",
    "-t",
    W,
    "#{window_width}x#{window_height} zoom=#{window_zoomed_flag}",
  );
const current = () => t("display-message", "-p", "-t", W, "#{window_layout}");
const sleep = (ms: number) => Bun.sleep(ms);
function winchSince(mark: number): string {
  const counts = new Map<string, number>();
  for (const l of lines(WINCH).slice(mark)) {
    const name = l.split(" ")[0] ?? "";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([k, v]) => `${k}=${v}`).join(" ") || "none";
}

// --- 1. today's layout ------------------------------------------------------------------
tmux("kill-server");
writeFileSync(WINCH, "");
writeFileSync(HOOK, "");
head("1. today's layout at 200x50");
const left = t(
  "new-session",
  "-d",
  "-s",
  "s13",
  "-n",
  "workspace",
  "-x",
  "200",
  "-y",
  "50",
  ...P,
  ...pane("status"),
);
t("set", "-g", "pane-border-status", "top");
t("set", "-g", "pane-border-format", " #{pane_title} ");
const main = t("split-window", "-h", "-t", left, ...P, ...pane("main"));
const right = t("split-window", "-d", "-h", "-t", main, ...P, ...pane("list"));
const feed = t("split-window", "-d", "-h", "-l", "40", "-t", right, ...P, ...pane("feed"));
const top = t("split-window", "-d", "-f", "-v", "-b", "-l", "1", "-t", left, ...P, ...pane("top"));
for (const [id, title] of [
  [left, "status"],
  [main, "main"],
  [right, "list"],
  [feed, "feed"],
  [top, "top"],
] as const)
  t("select-pane", "-t", id, "-T", title);
t("resize-pane", "-t", top, "-y", "1");
t("resize-pane", "-t", left, "-x", "30");
t("resize-pane", "-t", feed, "-x", "40");
t("run-shell", "-C", `resize-pane -t ${main} -x #{e|-:#{window_width},107}`);
const today = current();
say(`order: ${order()}`);
say(`layout: ${today}`);
say(`panes: ${[...real()].map(([k, v]) => `${k}(${v})`).join(" ")}`);
const topCell = Number(/"t":"p","w":\d+,"h":(\d+),"x":0,"y":0/.exec(today)?.[1] ?? "1");
say(`top bar cell height: ${topCell}`);

// --- 2. wide string with 4 agents and a shell -------------------------------------------
head("2. wide layout at 420x70: 4 agents and the shell");
const agents: string[] = [];
for (const name of ["a1", "a2", "a3", "a4"]) {
  const id = t("new-window", "-d", "-t", "s13:", "-n", name, ...P, ...pane(name));
  t("select-pane", "-t", id, "-T", name);
  agents.push(id);
}
const shell = t("new-window", "-d", "-t", "s13:", "-n", "shell", ...P, ...pane("shell"));
t("select-pane", "-t", shell, "-T", "shell");
const [a1 = "", a2 = "", a3 = "", a4 = ""] = agents;
t("resize-window", "-t", W, "-x", "420", "-y", "70");
let after = main;
for (const id of [...agents, shell]) {
  const j = tmux("join-pane", "-d", "-v", "-s", id, "-t", after);
  if (!j.ok) say(`join after ${after} (height ${real().get(after)?.split(" ")[3]}): ${j.err}`);
  t("select-layout", "-t", after, "-E");
  if (!j.ok) t("join-pane", "-d", "-v", "-s", id, "-t", after);
  after = id;
}
say(`order after joins: ${order()}`);
say(`window: ${size()}`);
const wide = (ids: (s: string) => string = (s) => s): Node => ({
  dir: "v",
  kids: [
    { size: topCell, id: ids(top) },
    {
      dir: "h",
      kids: [
        { size: 42, id: ids(left) },
        {
          dir: "v",
          kids: [
            {
              dir: "h",
              kids: [
                { id: ids(main) },
                { size: 84, dir: "v", kids: [{ id: ids(a1) }, { size: 25, id: ids(a2) }] },
                { size: 84, dir: "v", kids: [{ id: ids(a3) }, { size: 25, id: ids(a4) }] },
              ],
            },
            { size: 15, id: ids(shell) },
          ],
        },
        { size: 48, id: ids(right) },
        { size: 56, id: ids(feed) },
      ],
    },
  ],
});
let mark = lines(WINCH).length;
const w1 = layout(wide(), 420, 70);
say(`string: ${w1.text}`);
const r1 = tmux("select-layout", "-t", W, w1.text);
say(`select-layout: ${r1.ok ? "ok" : r1.err}`);
compare("wide", w1.geo);
await sleep(600);
say(`WINCH per pane: ${winchSince(mark)}`);
mark = lines(WINCH).length;
t("select-layout", "-t", W, w1.text);
await sleep(600);
say(`WINCH per pane when the same string is applied again: ${winchSince(mark)}`);

// --- 3. cells go by pane order, not by the ids in the string ---------------------------
head("3. ids in the string");
t("select-layout", "-t", W, "even-horizontal");
const fake = new Map<string, string>();
let n = 900;
const w3 = layout(
  wide((s) => {
    if (!fake.has(s)) fake.set(s, `%${n++}`);
    return fake.get(s) ?? "";
  }),
  420,
  70,
);
const r3 = tmux("select-layout", "-t", W, w3.text);
say(`string with ids 900.. : ${r3.ok ? "ok" : r3.err}`);
compare("by order", w1.geo);
const extra = t("new-window", "-d", "-t", "s13:", "-n", "x", ...P, ...pane("x"));
t("join-pane", "-d", "-v", "-b", "-s", extra, "-t", a1);
say(`join -b before a1: ${order()}`);
t("break-pane", "-d", "-s", extra, "-n", "x");
t("join-pane", "-d", "-h", "-s", extra, "-t", a2);
say(`join -h after a2:  ${order()}`);
t("kill-pane", "-t", extra);
t("select-layout", "-t", W, w1.text);

// --- 4. replace, narrow, wide again ------------------------------------------------------
head("4. transitions and redraws");
const a5 = t("new-window", "-d", "-t", "s13:", "-n", "a5", ...P, ...pane("a5"));
t("select-pane", "-t", a5, "-T", "a5");
await sleep(300);
mark = lines(WINCH).length;
t("join-pane", "-d", "-v", "-s", a5, "-t", a1);
t("break-pane", "-d", "-s", a1, "-n", "a1");
say(`a5 replaces a1: ${order()}`);
const w4 = layout(
  wide((s) => (s === a1 ? a5 : s)),
  420,
  70,
);
say(`select-layout: ${tmux("select-layout", "-t", W, w4.text).ok}`);
compare("replace", w4.geo);
await sleep(600);
say(`WINCH per pane (join, break, select-layout as three commands): ${winchSince(mark)}`);
// The same again as one tmux invocation.
mark = lines(WINCH).length;
const w4b = layout(wide(), 420, 70);
const one = tmux(
  "join-pane",
  "-d",
  "-v",
  "-s",
  a1,
  "-t",
  a5,
  ";",
  "break-pane",
  "-d",
  "-s",
  a5,
  "-n",
  "a5",
  ";",
  "select-layout",
  "-t",
  W,
  w4b.text,
);
say(`one invocation: ${one.ok ? "ok" : one.err}`);
compare("replace back", w4b.geo);
await sleep(600);
say(`WINCH per pane (one invocation): ${winchSince(mark)}`);

const narrow = (): Node => ({
  dir: "v",
  kids: [
    { size: topCell, id: top },
    {
      dir: "h",
      kids: [
        { size: 30, id: left },
        { dir: "v", kids: [{ id: main }, { size: 14, id: a4 }, { size: 11, id: shell }] },
        { size: 34, id: right },
        { size: 40, id: feed },
      ],
    },
  ],
});
for (const id of [a1, a2, a3]) t("break-pane", "-d", "-s", id, "-n", "pool");
t("resize-window", "-t", W, "-x", "200", "-y", "50");
await sleep(300);
mark = lines(WINCH).length;
const n4 = layout(narrow(), 200, 50);
say(`narrow string: ${n4.text}`);
say(`select-layout narrow: ${tmux("select-layout", "-t", W, n4.text).ok}`);
compare("narrow", n4.geo);
const wideOne = (shellOn: boolean): Node => {
  const upper: Node = { dir: "h", kids: [{ id: main }, { size: 125, id: a4 }] };
  return {
    dir: "v",
    kids: [
      { size: topCell, id: top },
      {
        dir: "h",
        kids: [
          { size: 42, id: left },
          shellOn ? { dir: "v", kids: [upper, { size: 15, id: shell }] } : { id: main },
          ...(shellOn ? [] : [{ size: 125, id: a4 }]),
          { size: 48, id: right },
          { size: 56, id: feed },
        ],
      },
    ],
  };
};
t("resize-window", "-t", W, "-x", "400", "-y", "70");
const o4 = layout(wideOne(true), 400, 70);
say(`same panes, wide string: ${tmux("select-layout", "-t", W, o4.text).ok}`);
compare("narrow to wide, no pane moved", o4.geo);
t("break-pane", "-d", "-s", shell, "-n", "shell");
const o5 = layout(wideOne(false), 400, 70);
say(`no shell (main and agent straight in the row): ${tmux("select-layout", "-t", W, o5.text).ok}`);
compare("flat row", o5.geo);
// A nested same-direction container: does tmux take it, and what does it read back?
const nested: Node = {
  dir: "v",
  kids: [
    { size: topCell, id: top },
    {
      dir: "h",
      kids: [
        { size: 42, id: left },
        { dir: "h", kids: [{ id: main }, { size: 125, id: a4 }] },
        { size: 48, id: right },
        { size: 56, id: feed },
      ],
    },
  ],
};
const o6 = layout(nested, 400, 70);
const r6 = tmux("select-layout", "-t", W, o6.text);
say(
  `nested row in a row: ${r6.ok ? "ok" : r6.err}; geometry ${[...o6.geo].every(([id, g]) => real().get(id) === g) ? "same" : "different"}`,
);
say(
  `  tmux keeps it as: ${current().includes(`"t":"h","w":${400 - 42 - 48 - 56 - 3}`) ? "nested" : "flattened"}`,
);

// --- 5. errors ---------------------------------------------------------------------------
head("5. errors");
const good = o5.text;
const bad = `0000,${good.slice(5)}`;
say(`bad checksum: ${tmux("select-layout", "-t", W, bad).err || "accepted"}`);
const five = layout(wideOne(true), 400, 70).text; // 7 cells, 6 panes in the window
say(
  `more cells than panes: ${tmux("select-layout", "-t", W, five).err || "accepted"} -> ${order()}`,
);
t("join-pane", "-d", "-v", "-s", shell, "-t", a4);
say(`fewer cells than panes: ${tmux("select-layout", "-t", W, good).err || "accepted"}`);
say(`  panes: ${[...real()].map(([k, v]) => `${k}(${v})`).join(" ")}`);
const other = layout(wideOne(true), 300, 60).text;
const r5 = tmux("select-layout", "-t", W, other);
say(`string for 300x60 on a 400x70 window: ${r5.ok ? "accepted" : r5.err}; window ${size()}`);
say(`  panes: ${[...real()].map(([k, v]) => `${k}(${v})`).join(" ")}`);
t("select-layout", "-t", W, o4.text);

// --- 6. the resize hook ------------------------------------------------------------------
head("6. window-resized hook");
const hookCmd = `run-shell -b 'echo "#{window_name} #{window_width}x#{window_height}" >> ${HOOK}'`;
t("set-hook", "-w", "-t", W, "window-resized", hookCmd);
const fired = async (label: string, from: number) => {
  await sleep(500);
  const now = lines(HOOK);
  say(`${label}: ${now.length - from} firing(s) ${now.slice(from).slice(-3).join(" | ")}`);
  return now.length;
};
let h = 0;
t("resize-window", "-t", W, "-x", "330", "-y", "60");
h = await fired("resize-window of the workspace", h);
t("resize-window", "-t", "s13:a5", "-x", "100", "-y", "30");
h = await fired("resize-window of a pool window", h);
t("select-layout", "-t", W, layout(wideOne(true), 330, 60).text);
h = await fired("select-layout", h);
t("break-pane", "-d", "-s", shell, "-n", "shell");
t("join-pane", "-d", "-v", "-s", shell, "-t", a4);
h = await fired("break and join", h);
// A real client: control mode, sized by refresh-client.
t("set", "-wu", "-t", W, "window-size");
for (const w of t("list-windows", "-t", "s13", "-F", "#{window_id}").split("\n"))
  tmux("set", "-wu", "-t", w, "window-size");
const client = (sizeArg: string) => {
  const p = Bun.spawn([T, "-C", "attach", "-t", "s13"], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  p.stdin.write(`refresh-client -C ${sizeArg}\n`);
  p.stdin.flush();
  return p;
};
const c1 = client("280x60");
h = await fired("first client attaches at 280x60", h);
say(`  window ${size()}`);
for (let i = 1; i <= 30; i++) {
  c1.stdin.write(`refresh-client -C ${280 + i * 4}x60\n`);
  c1.stdin.flush();
  await sleep(15);
}
h = await fired("30 size steps in about half a second", h);
say(`  window ${size()}`);
const c2 = client("200x50");
h = await fired("second, smaller client attaches", h);
say(`  window ${size()} (window-size option: ${t("show", "-gv", "window-size")})`);
c2.stdin.write("refresh-client -C 500x80\n");
c2.stdin.flush();
h = await fired("second client grows to 500x80", h);
say(`  window ${size()}`);
c2.stdin.end();
await sleep(300);
h = await fired("second client detaches", h);
say(`  window ${size()}`);

// --- 7. zoom -----------------------------------------------------------------------------
head("7. zoom");
t("resize-pane", "-Z", "-t", main);
say(`zoomed: ${size()}`);
c1.stdin.write("refresh-client -C 420x70\n");
c1.stdin.flush();
h = await fired("resize while zoomed", h);
say(`  ${size()}`);
const z = layout(
  wide((s) => s),
  420,
  70,
);
t("resize-pane", "-Z", "-t", main);
say(`unzoomed: ${size()}; panes ${real().size}`);
t("resize-pane", "-Z", "-t", main);
for (const id of [a1, a2, a3]) tmux("break-pane", "-d", "-s", id);
const zl = layout(wideOne(true), 420, 70);
const rz = tmux("select-layout", "-t", W, zl.text);
say(`select-layout while zoomed: ${rz.ok ? "ok" : rz.err}; after: ${size()}`);
void z;
c1.stdin.end();
await sleep(200);
tmux("kill-server");
say("\ndone");
