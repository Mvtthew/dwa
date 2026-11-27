import type { TmuxRunner } from "../src/tmux/driver.ts";
import { WORKSPACE_WINDOW } from "../src/tmux/layout.ts";

interface FakePane {
  window: string;
  dead: boolean;
  argv: string[];
  env: Record<string, string>;
}

function option(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function command(args: string[]): { argv: string[]; env: Record<string, string> } {
  const separator = args.indexOf("--");
  const env: Record<string, string> = {};
  const head = separator === -1 ? args : args.slice(0, separator);
  head.forEach((arg, index) => {
    if (arg !== "-e") return;
    const pair = head[index + 1] ?? "";
    const eq = pair.indexOf("=");
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
  });
  return { argv: separator === -1 ? [] : args.slice(separator + 1), env };
}

/**
 * An in-memory stand-in for the private tmux server: enough of tmux to test the workspace. It
 * keeps which window each pane is in and the order of the panes, but no sizes: a layout is only
 * checked to name the workspace window's panes in their order, as tmux needs it.
 */
export class FakeTmux {
  readonly calls: string[][] = [];
  readonly panes = new Map<string, FakePane>();
  session = false;
  /** The workspace window's size, as `display-message` reports it. Set by a test. */
  size = { width: 200, height: 50 };
  zoomed = false;
  /** The layout string last applied to the workspace window. */
  layout: string | null = null;
  private next = 0;
  /** Every pane, those of one window in that window's pane order. */
  private order: string[] = [];
  private focus = new Map<string, string>();

  readonly run: TmuxRunner = async (args) => {
    this.calls.push(args);
    const [name] = args;
    switch (name) {
      case "has-session":
        if (!this.session) throw new Error("no session");
        return "";
      case "new-session": {
        this.session = true;
        const id = this.add(option(args, "-n") ?? "0", args);
        this.focus.set(option(args, "-n") ?? "0", id);
        return id;
      }
      case "split-window": {
        const at = option(args, "-t") ?? "";
        const window = this.panes.get(at)?.window ?? WORKSPACE_WINDOW;
        const head = args.slice(0, args.includes("--") ? args.indexOf("--") : undefined);
        const id = this.add(window, args);
        // -f -b: before every pane of the window; -b: before the target; else after it.
        const first = head.includes("-f") ? (this.paneOrder(window)[0] ?? at) : at;
        this.place(id, first, head.includes("-b"));
        if (!head.includes("-d")) this.focus.set(window, id);
        return id;
      }
      case "new-window":
        return this.add(option(args, "-n") ?? "window", args);
      case "join-pane": {
        const id = option(args, "-s") ?? "";
        const at = option(args, "-t") ?? "";
        const pane = this.require(id);
        pane.window = this.require(at).window;
        this.place(id, at, args.includes("-b"));
        if (!args.includes("-d")) this.focus.set(pane.window, id);
        this.zoomed = false;
        return "";
      }
      case "break-pane": {
        const id = option(args, "-s") ?? "";
        this.require(id).window = option(args, "-n") ?? "window";
        this.order = [...this.order.filter((other) => other !== id), id];
        this.zoomed = false;
        return "";
      }
      case "swap-pane": {
        const a = option(args, "-s") ?? "";
        const b = option(args, "-t") ?? "";
        const [one, two] = [this.require(a), this.require(b)];
        [one.window, two.window] = [two.window, one.window];
        this.order = this.order.map((id) => (id === a ? b : id === b ? a : id));
        return "";
      }
      case "respawn-pane":
        // The pane stays what and where it is; only its command is new.
        Object.assign(this.require(option(args, "-t")), command(args));
        return "";
      case "kill-pane":
        this.panes.delete(option(args, "-t") ?? "");
        this.order = this.order.filter((id) => id !== option(args, "-t"));
        this.zoomed = false;
        return "";
      case "kill-server":
        if (!this.session) throw new Error("no server");
        this.session = false;
        this.panes.clear();
        this.order = [];
        this.focus.clear();
        this.zoomed = false;
        this.layout = null;
        return "";
      case "list-panes":
        return this.order
          .map((id) => {
            const pane = this.require(id);
            const active = this.activeOf(pane.window) === id ? 1 : 0;
            return `${id} ${pane.dead ? 1 : 0} ${active} ${pane.window}`;
          })
          .join("\n");
      case "select-pane": {
        const pane = this.require(option(args, "-t"));
        // With -T tmux only sets the title.
        if (!args.includes("-T")) this.focus.set(pane.window, option(args, "-t") ?? "");
        return "";
      }
      case "resize-pane":
        if (!args.includes("-Z")) throw new Error("FakeTmux: panes are sized by a layout only");
        this.zoomed = !this.zoomed;
        return "";
      case "select-layout": {
        const text = args[args.length - 1] ?? "";
        const named = [...text.matchAll(/\d+x\d+,\d+,\d+,(\d+)/g)].map((match) => `%${match[1]}`);
        const have = this.paneOrder(WORKSPACE_WINDOW);
        if (named.join(" ") !== have.join(" ")) {
          throw new Error(
            `layout for panes ${named.join(" ")}, but the window has ${have.join(" ")}`,
          );
        }
        if (!text.includes(`,${this.size.width}x${this.size.height},0,0`)) {
          throw new Error(
            `layout ${text} is not for a ${this.size.width}x${this.size.height} window`,
          );
        }
        this.layout = text;
        this.zoomed = false;
        return "";
      }
      case "display-message":
        return args.includes("-p") && args.some((arg) => arg.includes("window_width"))
          ? `${this.size.width} ${this.size.height} ${this.zoomed ? 1 : 0}`
          : "";
      case "set":
      case "set-hook":
      case "run-shell":
      case "display-popup":
      case "detach-client":
      case "set-buffer":
      case "paste-buffer":
      case "send-keys":
        return "";
      default:
        throw new Error(`FakeTmux: unsupported command ${name}`);
    }
  };

  /** Commands of one kind that were run, for assertions. */
  commands(name: string): string[][] {
    return this.calls.filter((call) => call[0] === name);
  }

  windowOf(paneId: string): string | undefined {
    return this.panes.get(paneId)?.window;
  }

  /** The panes of a window, in its pane order. */
  paneOrder(window: string): string[] {
    return this.order.filter((id) => this.panes.get(id)?.window === window);
  }

  /** The pane of a window that has the focus: the one last selected, else its first. */
  activeOf(window: string): string | undefined {
    const panes = this.paneOrder(window);
    const focused = this.focus.get(window);
    return focused && panes.includes(focused) ? focused : panes[0];
  }

  private add(window: string, args: string[]): string {
    const id = `%${this.next++}`;
    this.panes.set(id, { window, dead: false, ...command(args) });
    this.order.push(id);
    return id;
  }

  /** Moves a pane right after another in the order, or right before it. */
  private place(id: string, at: string, before: boolean): void {
    const rest = this.order.filter((other) => other !== id);
    const index = rest.indexOf(at);
    if (index === -1) return;
    rest.splice(before ? index : index + 1, 0, id);
    this.order = rest;
  }

  private require(id: string | undefined): FakePane {
    const pane = this.panes.get(id ?? "");
    if (!pane) throw new Error(`can't find pane: ${id}`);
    return pane;
  }
}
