/** Runs one tmux command against the private server and returns its trimmed stdout. */
export type TmuxRunner = (args: string[]) => Promise<string>;

export class TmuxError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(`tmux ${args[0] ?? ""} failed: ${stderr.trim() || "unknown error"}`);
  }
}

export interface TmuxOptions {
  /** Private server socket name (`tmux -L`), so the user's own tmux server is never touched. */
  socketName: string;
  /** Generated config file (`tmux -f`), so the user's own tmux config is never read. */
  confPath: string;
  /** Environment for the tmux server and, through it, every pane. */
  env: Record<string, string>;
}

export function tmuxArgv(options: Pick<TmuxOptions, "socketName" | "confPath">, args: string[]) {
  return ["tmux", "-L", options.socketName, "-f", options.confPath, ...args];
}

export function createTmux(options: TmuxOptions): TmuxRunner {
  return async (args) => {
    const proc = Bun.spawn(tmuxArgv(options, args), {
      env: options.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new TmuxError(args, stderr);
    return stdout.trim();
  };
}
