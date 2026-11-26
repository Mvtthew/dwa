// Spike S8: the S5 echo server with a start-up delay. Usage: bun probe-mcp.ts <delay-ms> [name] [marker-file]
// It sleeps before connecting, so the session's first request can go out before its tools are known.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const delay = Number(process.argv[2] ?? 0);
const name = process.argv[3] ?? "probe";
const server = new McpServer({ name, version: "0.0.0" });
server.registerTool(
  "ping",
  { description: `Returns the marker of the ${name} server.`, inputSchema: {} },
  async () => ({ content: [{ type: "text", text: `pong from ${name}` }] }),
);
// Claude Code writes its MCP log about a second late, so the server says itself when the client
// has finished the handshake: the time of the `initialized` notification goes into the marker file.
const marker = process.argv[4];
if (marker) server.server.oninitialized = () => void Bun.write(marker, String(Date.now()));
if (delay > 0) await Bun.sleep(delay);
await server.connect(new StdioServerTransport());
