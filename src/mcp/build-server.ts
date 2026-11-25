import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { selectTools } from "../tools/registry.js";
import type { ToolContext, ToolHandler } from "../tools/context.js";
import type { ToolKind } from "../tools/kinds.js";
import type { ToolDefinition } from "../tools/types.js";
import { REFUSAL_META_KEY } from "../tools/refusal.js";
import { SERVER_VERSION } from "../version.js";

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
  /**
   * Told once per tool call, after the handler settles. The server writes one
   * log line per call through it; absent, nothing is recorded.
   */
  onToolCall?: (record: ToolCallRecord) => void;
}

/**
 * What one tool call was, for an operator's log: which tool, for which
 * profile and assessment, how it ended and what it cost. It is deliberately
 * not what the caller sent or what the tool answered. An artifact's content,
 * a vendor's name and a finding's text are the customer's, and a log is read
 * by people the customer's site permissions never admitted.
 *
 * Two identifiers are carried, and each only in the form the server itself
 * knows. The profile id is recorded when it names a configured profile, and
 * the assessment id when the tool's answer carries it, which is the id as the
 * list stores it. Neither is repeated from the input otherwise: both input
 * fields accept any text, and an agent that put a vendor's name in one would
 * have it written to the log.
 */
export interface ToolCallRecord {
  /** When the call settled. */
  at: string;
  tool: string;
  kind: ToolKind;
  /**
   * "refused" is a lifecycle precondition that did not hold, which is the
   * tool working. "error" is any other error result: one the tool composed,
   * whose words went to the caller and are not logged, or a failure it caught,
   * which it also wrote to stderr. "threw" is a handler that raised, which no
   * handler is meant to do.
   */
  outcome: "ok" | "refused" | "error" | "threw";
  ms: number;
  profileId?: string;
  assessmentId?: string;
  correlationId?: string;
  graphRequests?: number;
}

/** One line of JSON, so a log can be filtered on the event and its fields. */
export function formatToolCallRecord(record: ToolCallRecord): string {
  return JSON.stringify({ event: "tool_call", ...record });
}

function textField(source: unknown, key: string): string | undefined {
  const value = typeof source === "object" && source !== null ? (source as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordOf(tool: ToolDefinition, input: unknown, result: CallToolResult | undefined, startedAt: number, context: ToolContext): ToolCallRecord {
  const requests = (result?.structuredContent as Record<string, unknown> | undefined)?.graphRequests;
  const refused = (result?._meta as Record<string, unknown> | undefined)?.[REFUSAL_META_KEY] !== undefined;
  const sentProfileId = textField(input, "profileId");
  const profileId = sentProfileId !== undefined && context.profiles.ids().includes(sentProfileId) ? sentProfileId : undefined;
  // Only the id the tool answered with, which is the one the list stores. A refusal for an id no
  // item carries has nothing to record here, and the caller's text is not a substitute.
  const assessmentId = textField(result?.structuredContent, "assessmentId");
  const correlationId = textField(result?.structuredContent, "correlationId");
  return {
    at: new Date().toISOString(),
    tool: tool.name,
    kind: tool.kind,
    outcome: result === undefined ? "threw" : result.isError !== true ? "ok" : refused ? "refused" : "error",
    ms: Date.now() - startedAt,
    ...(profileId === undefined ? {} : { profileId }),
    ...(assessmentId === undefined ? {} : { assessmentId }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(typeof requests === "number" ? { graphRequests: requests } : {}),
  };
}

/** Runs the handler and reports the call, whatever the handler did. The report never changes the answer. */
function recorded(tool: ToolDefinition, handler: ToolHandler, context: ToolContext, onToolCall: (record: ToolCallRecord) => void): (input: unknown) => Promise<CallToolResult> {
  return async (input: unknown) => {
    const startedAt = Date.now();
    let result: CallToolResult | undefined;
    try {
      result = await handler(input, context);
      return result;
    } finally {
      try {
        onToolCall(recordOf(tool, input, result, startedAt, context));
      } catch {
        // A log that cannot be written must not turn a call that worked into one that failed.
      }
    }
  };
}

export const SERVER_NAME = "ironwright-mcp";

/**
 * Builds a fresh server. Callers must build one per HTTP request: SDK versions
 * from 1.26 onward treat a reused instance as a cross-request data leak risk,
 * and stateless mode has no session to scope state to. The context handed in is
 * deliberately not per request; see `src/tools/context.ts`.
 */
export function buildServer(opts: BuildServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // Both branches go through `selectTools`, so the write gate has exactly one
  // definition. A caller-supplied list chooses which tools exist, never whether
  // the gate applies to them, and repeating the predicate here would give a
  // security boundary a second copy to drift from.
  const tools = selectTools(opts.allowWrites, opts.tools);

  for (const tool of tools) {
    const message = `${tool.name} is registered but not implemented yet. Nothing was done.`;
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
        ? // An error, not a success-shaped answer: an agent relays a success as
          // "done", and this tool did nothing.
          () => ({ isError: true, content: [{ type: "text" as const, text: message }] })
        : opts.onToolCall === undefined
          ? (input: unknown) => handler(input, opts.context)
          : recorded(tool, handler, opts.context, opts.onToolCall),
    );
  }

  return server;
}
