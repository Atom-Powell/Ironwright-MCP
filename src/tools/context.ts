import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GraphClient } from "../graph/client.js";
import type { StateStore } from "../store/types.js";
import type { ProfileRegistry } from "../profiles/registry.js";
import type { ScanCoordinator } from "../scan/coordinator.js";

/**
 * The dependencies a tool handler may use, built once per process and shared by
 * every per-request server.
 *
 * Shared rather than rebuilt per request, and that does not contradict the
 * locked decision that a fresh `McpServer` is built per request. That decision
 * is about MCP protocol state, which stateless mode has no session to scope.
 * A Graph client and a table client are not protocol state, and rebuilding them
 * per request would discard the token provider's cache and mint a new
 * client-credentials token on every tool call.
 */
export interface ToolContext {
  profiles: ProfileRegistry;
  graph: GraphClient;
  store: StateStore;
  scans: ScanCoordinator;
  now: () => Date;
}

/**
 * Takes `unknown` rather than the type the tool's own input schema implies.
 * The SDK validates against that schema before calling, but a handler is also
 * a plain function this repo tests directly, without the SDK in the way, so it
 * validates its own input with its own schema. The duplicate parse is cheap
 * and it is what lets the handler be tested as a function.
 *
 * A handler that declares an outputSchema may return `{ isError: true }` with
 * no `structuredContent` at all. That was an open question the spec left
 * unanswered, and `tests/mcp/build-server.errors.test.ts` settles it by
 * observation against @modelcontextprotocol/sdk 1.30.0: output validation
 * returns early on an error result, so the failure reaches the caller as its
 * own prose rather than being replaced by a schema complaint. This matters
 * because the alternative was to widen every output schema until nothing in it
 * was required, which would have cost the schema its ability to say what a
 * successful result contains. The exemption is behavior of an installed
 * version rather than a documented guarantee, so an SDK upgrade re-runs that
 * test before anything else.
 */
export type ToolHandler = (input: unknown, context: ToolContext) => Promise<CallToolResult>;
