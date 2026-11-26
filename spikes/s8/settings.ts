// Spike S8: writes a session's settings and MCP config.
// Usage: bun settings.ts <tag> <delay-ms> [mail]   ("mail" arms the S3 asyncRewake waiter)
// S8_PROBE2=<delay-ms> adds a second server, `probe2`. S8_ALWAYS=1 adds `alwaysLoad: true` to the server; S8_SETTINGS_ENV='{"A":"1"}' adds an `env` block.
import { join } from "node:path";

const [tag, delay, mail] = process.argv.slice(2);
const out = join(import.meta.dir, "..", "out", "s8");
const bun = process.execPath;
const entry = () => [
  {
    hooks: [
      { type: "command", command: `${bun} ${join(import.meta.dir, "hook.ts")} ${tag}` },
    ] as object[],
  },
];
const hooks = {
  SessionStart: entry(),
  UserPromptSubmit: entry(),
  Stop: entry(),
  SessionEnd: entry(),
};
if (mail === "mail") {
  const waiter = {
    type: "command",
    command: `DWA_SPIKE_OUT=${out} DWA_AGENT_ID=${tag} ${bun} ${join(import.meta.dir, "..", "wait-mail.ts")}`,
    asyncRewake: true,
    timeout: 86400,
  };
  hooks.SessionStart[0]?.hooks.push(waiter);
  hooks.Stop[0]?.hooks.push(waiter);
}
const settings = {
  hooks,
  claudeMdExcludes: [`${process.env.HOME}/.claude/CLAUDE.md`],
  autoMemoryEnabled: false,
  permissions: { allow: ["mcp__probe", "mcp__probe2", "Bash(echo *)"] },
  ...(process.env.S8_SETTINGS_ENV ? { env: JSON.parse(process.env.S8_SETTINGS_ENV) } : {}),
};
await Bun.write(join(out, `${tag}.settings.json`), `${JSON.stringify(settings, null, 2)}\n`);
const second = process.env.S8_PROBE2;
const mcp = {
  mcpServers: {
    ...(second
      ? {
          probe2: {
            type: "stdio",
            command: bun,
            args: [join(import.meta.dir, "probe-mcp.ts"), second, "probe2"],
          },
        }
      : {}),
    probe: {
      type: "stdio",
      command: bun,
      args: [
        join(import.meta.dir, "probe-mcp.ts"),
        delay ?? "0",
        "probe",
        join(out, `${tag}.connected`),
      ],
      ...(process.env.S8_ALWAYS ? { alwaysLoad: true } : {}),
    },
  },
};
await Bun.write(join(out, `${tag}.mcp.json`), `${JSON.stringify(mcp)}\n`);
