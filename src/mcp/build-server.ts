import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { selectTools } from "../tools/registry.js";

export interface BuildServerOptions {
  allowWrites: boolean;
}

export const SERVER_NAME = "ironwright-repo-reconciliation";
export const SERVER_VERSION = "0.1.0";

/**
 * Builds a fresh server. Callers must build one per HTTP request: SDK versions
 * from 1.26 onward treat a reused instance as a cross-request data leak risk,
 * and stateless mode has no session to scope state to.
 */
export function buildServer(opts: BuildServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const tool of selectTools(opts.allowWrites)) {
    const message = `${tool.name} is registered but not implemented yet.`;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      () => ({
        structuredContent: { stub: true as const, message },
        content: [{ type: "text" as const, text: message }],
      }),
    );
  }

  return server;
}
