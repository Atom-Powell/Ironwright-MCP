import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { selectTools } from "../tools/registry.js";
import type { ToolContext } from "../tools/context.js";
import type { ToolDefinition } from "../tools/types.js";

export interface BuildServerOptions {
  allowWrites: boolean;
  /**
   * Required rather than optional. A server built without dependencies would
   * silently serve a stub for a tool that does have a handler, and a stub
   * answer to a compliance question is a confident wrong answer with no signal
   * attached. Required means a deployment that cannot reconcile fails to start.
   */
  context: ToolContext;
  /** Overridden only by tests, which need definitions they control. */
  tools?: ToolDefinition[];
}

export const SERVER_NAME = "ironwright-repo-reconciliation";
export const SERVER_VERSION = "0.1.0";

/**
 * Builds a fresh server. Callers must build one per HTTP request: SDK versions
 * from 1.26 onward treat a reused instance as a cross-request data leak risk,
 * and stateless mode has no session to scope state to. The context handed in is
 * deliberately not per request; see `src/tools/context.ts`.
 */
export function buildServer(opts: BuildServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // The write gate applies to a caller-supplied list as well as to the
  // registry's own. A test list is still a list of tools this server would
  // serve, and a gate that only held for the default source would leave the one
  // code path that hides write tools untested by every suite that supplies its
  // own definitions.
  const tools =
    opts.tools === undefined
      ? selectTools(opts.allowWrites)
      : opts.tools.filter((tool) => opts.allowWrites || tool.kind !== "write");

  for (const tool of tools) {
    const message = `${tool.name} is registered but not implemented yet.`;
    const handler = tool.handler;

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      handler === undefined
        ? () => ({
            structuredContent: { stub: true as const, message },
            content: [{ type: "text" as const, text: message }],
          })
        : (input: unknown) => handler(input, opts.context),
    );
  }

  return server;
}
