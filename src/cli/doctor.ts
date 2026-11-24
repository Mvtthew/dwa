import { allProfiles, loadConfig } from "../shared/config.ts";
import {
  CLAUDE_COMMAND_ENV,
  DEFAULT_CLAUDE_COMMAND,
  MIN_BUN_VERSION,
  MIN_CLAUDE_VERSION,
  MIN_TMUX_VERSION,
} from "../shared/constants.ts";
import { expandPath, findProjectRoot } from "../shared/paths.ts";
import { satisfiesMinimum } from "../shared/version.ts";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** Runs a command and returns its trimmed stdout, or null when it is missing or fails. */
export type RunCommand = (argv: string[]) => Promise<string | null>;

const runCommand: RunCommand = async (argv) => {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const [output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return exitCode === 0 ? output.trim() : null;
  } catch {
    return null;
  }
};

async function checkCommand(
  name: string,
  argv: string[],
  minimum: string,
  run: RunCommand,
): Promise<CheckResult> {
  const output = await run(argv);
  if (output === null) {
    return { name, ok: false, detail: `\`${argv[0]}\` not found or failed to run` };
  }
  const firstLine = output.split("\n")[0] ?? "";
  if (!satisfiesMinimum(firstLine, minimum)) {
    return { name, ok: false, detail: `${firstLine} (need ${minimum} or newer)` };
  }
  return { name, ok: true, detail: firstLine };
}

export interface DoctorOptions {
  /** Claude commands to check. Defaults to `$DWA_CLAUDE_COMMAND` or `claude`. */
  claudeCommands?: string[];
  bunVersion?: string;
  run?: RunCommand;
}

export async function runChecks(options: DoctorOptions = {}): Promise<CheckResult[]> {
  const run = options.run ?? runCommand;
  const bunVersion = options.bunVersion ?? Bun.version;
  const claudeCommands = options.claudeCommands ?? [
    process.env[CLAUDE_COMMAND_ENV] || DEFAULT_CLAUDE_COMMAND,
  ];

  const bun: CheckResult = satisfiesMinimum(bunVersion, MIN_BUN_VERSION)
    ? { name: "bun", ok: true, detail: bunVersion }
    : { name: "bun", ok: false, detail: `${bunVersion} (need ${MIN_BUN_VERSION} or newer)` };

  const others = await Promise.all([
    checkCommand("tmux", ["tmux", "-V"], MIN_TMUX_VERSION, run),
    ...claudeCommands.map((command) =>
      checkCommand(
        `claude (${command})`,
        [expandPath(command), "--version"],
        MIN_CLAUDE_VERSION,
        run,
      ),
    ),
  ]);

  return [bun, ...others];
}

/** Prints the checks and returns the process exit code. */
export async function doctor(projectRoot: string = findProjectRoot()): Promise<number> {
  const config = await loadConfig(projectRoot);
  const commands = [...new Set(allProfiles(config).map((profile) => profile.command))];
  const results = await runChecks({ claudeCommands: commands });
  for (const result of results) {
    console.log(`${result.ok ? "ok  " : "FAIL"}  ${result.name}: ${result.detail}`);
  }
  return results.every((result) => result.ok) ? 0 : 1;
}
