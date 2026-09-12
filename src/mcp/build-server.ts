import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
export function buildServer(_opts: BuildServerOptions): McpServer {
  return new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
}
