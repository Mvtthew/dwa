// Spike S5: a minimal stdio MCP server with one `ping` tool. Usage: bun echo-mcp.ts <server-name>
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const name = process.argv[2] ?? "echo";
const server = new McpServer({ name, version: "0.0.0" });
server.registerTool(
  "ping",
  { description: `Returns the marker of the ${name} server.`, inputSchema: {} },
  async () => ({ content: [{ type: "text", text: `pong from ${name}` }] }),
);
await server.connect(new StdioServerTransport());
