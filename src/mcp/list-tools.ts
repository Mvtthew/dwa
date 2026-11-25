// Asks an MCP server which tools it has, so the tools dialog can show them one by one. dwa
// starts (or reaches) the server itself for a moment; the sessions are not involved.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import pkg from "../../package.json" with { type: "json" };
import { APP_NAME } from "../shared/constants.ts";

export interface ListToolsOptions {
  /** Directory a stdio server is started in: the project, as for a session. */
  cwd: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

function strings(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) if (typeof item === "string") out[key] = item;
  }
  return out;
}

/** The transport for a server definition in the form of Claude Code's MCP config. */
function transportFor(server: unknown, options: ListToolsOptions): Transport {
  const def = (server && typeof server === "object" ? server : {}) as Record<string, unknown>;
  if (typeof def.url === "string") {
    const requestInit = { headers: strings(def.headers) };
    return def.type === "sse"
      ? new SSEClientTransport(new URL(def.url), { requestInit })
      : new StreamableHTTPClientTransport(new URL(def.url), { requestInit });
  }
  if (typeof def.command !== "string") throw new Error("the server has no command and no url");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    ...(options.env ?? process.env),
    ...strings(def.env),
  })) {
    if (value !== undefined) env[key] = value;
  }
  return new StdioClientTransport({
    command: def.command,
    args: Array.isArray(def.args) ? def.args.filter((arg) => typeof arg === "string") : [],
    env,
    cwd: options.cwd,
    // What the server prints about itself is not the dialog's business.
    stderr: "ignore",
  });
}

/**
 * The names of a server's tools, sorted. Throws when the server cannot be started or reached,
 * or does not answer in time; it is always closed again.
 */
export async function listServerTools(
  server: unknown,
  options: ListToolsOptions,
): Promise<string[]> {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const transport = transportFor(server, options);
  const client = new Client({ name: APP_NAME, version: pkg.version });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${timeout} ms`)), timeout);
  });
  try {
    const work = (async () => {
      await client.connect(transport);
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        names.push(...page.tools.map((tool) => tool.name));
        cursor = page.nextCursor;
      } while (cursor);
      return names.sort();
    })();
    // The loser of the race must not surface as an unhandled rejection.
    work.catch(() => undefined);
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}
