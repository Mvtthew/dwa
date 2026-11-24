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

/** An in-memory stand-in for the private tmux server: enough of tmux to test the workspace. */
export class FakeTmux {
  readonly calls: string[][] = [];
  readonly panes = new Map<string, FakePane>();
  session = false;
  private next = 0;

  readonly run: TmuxRunner = async (args) => {
    this.calls.push(args);
    const [name] = args;
    switch (name) {
      case "has-session":
        if (!this.session) throw new Error("no session");
        return "";
      case "new-session":
        this.session = true;
        return this.add(option(args, "-n") ?? "0", args);
      case "split-window": {
        const target = this.panes.get(option(args, "-t") ?? "");
        return this.add(target?.window ?? WORKSPACE_WINDOW, args);
      }
      case "new-window":
        return this.add(option(args, "-n") ?? "window", args);
      case "join-pane": {
        const pane = this.require(option(args, "-s"));
        pane.window = this.require(option(args, "-t")).window;
        return "";
      }
      case "break-pane":
        this.require(option(args, "-s")).window = option(args, "-n") ?? "window";
        return "";
      case "kill-pane":
        this.panes.delete(option(args, "-t") ?? "");
        return "";
      case "kill-server":
        if (!this.session) throw new Error("no server");
        this.session = false;
        this.panes.clear();
        return "";
      case "list-panes":
        return [...this.panes]
          .map(([id, pane]) => `${id} ${pane.dead ? 1 : 0} ${pane.window}`)
          .join("\n");
      case "select-pane":
      case "resize-pane":
        this.require(option(args, "-t"));
        return "";
      case "set-hook":
      case "display-message":
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

  private add(window: string, args: string[]): string {
    const id = `%${this.next++}`;
    this.panes.set(id, { window, dead: false, ...command(args) });
    return id;
  }

  private require(id: string | undefined): FakePane {
    const pane = this.panes.get(id ?? "");
    if (!pane) throw new Error(`can't find pane: ${id}`);
    return pane;
  }
}
