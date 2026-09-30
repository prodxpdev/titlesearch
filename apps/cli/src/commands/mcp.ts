import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTitlesearchMcpServer, type TitlesearchServices } from "@titlesearch/mcp";

/** Serves MCP over stdio until the client disconnects. */
export async function runMcp(services: TitlesearchServices, version: string): Promise<void> {
  const server = createTitlesearchMcpServer(services, version);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  await server.connect(transport);
  const stop = () => void server.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await closed;
}
