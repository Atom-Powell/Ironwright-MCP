import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createApp } from "../../src/server/app.js";
import { credentialPresent, inboundAuthMiddleware, type InboundAuthConfig } from "../../src/server/auth.js";

/**
 * A throwaway MCP server for learning what Copilot Studio accepts, built so
 * that a dev tunnel never fronts anything real. It reads no tenant data and
 * holds no Graph credentials. It lives under scripts/ because the production
 * build compiles only src/, so nothing here can reach a deployed image.
 *
 * It reuses the production transport (createApp) on purpose: a probe running a
 * different transport would answer questions about itself, not about the
 * server Copilot Studio will eventually call.
 */

export type ProbeAuthMode = "apikey" | "bearer" | "none";

export interface ProbeOptions {
  authMode: ProbeAuthMode;
  /** Required unless authMode is "none". Never written to the trace. */
  apiKey?: string;
  /** Header carrying the key in apikey mode. Copilot Studio lets the maker pick the name. */
  apiKeyHeader: string;
  trace: (record: TraceRecord) => void;
}

export interface TraceRecord {
  ts: string;
  event: "http" | "tool_call";
  [field: string]: unknown;
}

const FRUIT = ["apple", "banana", "cherry"] as const;

// Fixed so a wrong answer from the agent is detectable by eye in the test pane.
const STOCK: Record<(typeof FRUIT)[number], number> = { apple: 42, banana: 7, cherry: 0 };

/**
 * Describes arguments by key and JSON type only. Values are never recorded: a
 * probe that logged values would teach the habit of logging them in the real
 * server, where they can be sensitive.
 */
export function argumentShape(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null) return {};
  const shape: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    shape[key] = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  }
  return shape;
}

export function buildProbeServer(trace: ProbeOptions["trace"]): McpServer {
  const server = new McpServer({ name: "ironwright-copilot-probe", version: "0.0.1" });

  // Wraps each handler so the trace cannot be forgotten by a tool added later.
  function traced<I, O extends Record<string, unknown>>(
    name: string,
    run: (input: I) => O,
  ): (
    input: I,
    extra: { requestId: string | number },
  ) => { structuredContent: O; content: { type: "text"; text: string }[] } {
    // Joined to the http record by the JSON-RPC request id, which the SDK hands
    // every handler. A module-level "current request" variable would attribute
    // one request's tool call to another under concurrency.
    return (input, extra) => {
      const started = performance.now();
      const finish = (outcome: "ok" | "error"): void =>
        trace({
          ts: new Date().toISOString(),
          event: "tool_call",
          rpcId: extra.requestId,
          tool: name,
          // Post-validation: defaults the SDK filled in are included. What the
          // caller actually sent is on the http record as argShapeSent.
          argShapeValidated: argumentShape(input),
          durationMs: Math.round(performance.now() - started),
          outcome,
        });
      try {
        const result = run(input);
        finish("ok");
        return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        finish("error");
        throw error;
      }
    };
  }

  // The description is deliberately long and carries a worked example, so probe
  // B2 can show whether Copilot Studio truncates or rewrites what it receives.
  server.registerTool(
    "get_fruit_stock",
    {
      title: "Get fruit stock",
      description:
        "Returns how many units of a named fruit are in stock, from a small fixed inventory used only for " +
        "testing. Use this when the user asks how many apples, bananas or cherries are available, in stock, " +
        "or left. It answers only for apple, banana and cherry and reports 0 when a fruit is sold out. " +
        "It does not place orders and changes nothing. Example: for 'how many bananas do we have', call " +
        "with fruit set to banana and read the units field of the result. This text is intentionally " +
        "verbose; if you can read this final sentence in full, the description arrived untruncated.",
      inputSchema: {
        fruit: z.enum(FRUIT).describe("Which fruit to look up. One of apple, banana, cherry."),
        warehouse: z
          .string()
          .max(40)
          .default("main")
          .describe("Warehouse name. Optional; defaults to main and does not change the answer."),
      },
      outputSchema: { fruit: z.enum(FRUIT), warehouse: z.string(), units: z.number().int() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    traced("get_fruit_stock", (input: { fruit: (typeof FRUIT)[number]; warehouse: string }) => ({
      fruit: input.fruit,
      warehouse: input.warehouse,
      units: STOCK[input.fruit],
    })),
  );

  server.registerTool(
    "celsius_to_fahrenheit",
    {
      title: "Convert Celsius to Fahrenheit",
      description:
        "Converts a temperature in degrees Celsius to degrees Fahrenheit. Use this when the user gives a " +
        "temperature in Celsius and wants it in Fahrenheit. Example: 100 Celsius returns 212 Fahrenheit.",
      inputSchema: {
        celsius: z.number().min(-273.15).max(1000).describe("Temperature in degrees Celsius."),
      },
      outputSchema: { celsius: z.number(), fahrenheit: z.number() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    traced("celsius_to_fahrenheit", (input: { celsius: number }) => ({
      celsius: input.celsius,
      fahrenheit: Math.round((input.celsius * 9) / 5 + 32),
    })),
  );

  return server;
}

export function createProbeApp(opts: ProbeOptions): express.Express {
  if (opts.authMode !== "none" && (opts.apiKey === undefined || opts.apiKey.length < 16)) {
    throw new Error("An API key of at least 16 characters is required unless the auth mode is none.");
  }

  const auth: InboundAuthConfig = {
    mode: opts.authMode,
    header: opts.apiKeyHeader,
    ...(opts.apiKey === undefined ? {} : { key: opts.apiKey }),
  };

  const app = express();
  app.use((req, res, next) => {
    const correlationId = randomUUID();
    const started = performance.now();
    res.on("finish", () =>
      opts.trace({
        ts: new Date().toISOString(),
        event: "http",
        correlationId,
        httpMethod: req.method,
        path: req.path,
        rpcMethod: (req as { rpcMethod?: string }).rpcMethod ?? null,
        rpcId: (req as { rpcId?: string | number }).rpcId ?? null,
        argShapeSent: (req as { argShapeSent?: Record<string, string> }).argShapeSent ?? null,
        status: res.statusCode,
        // Presence only. The value of a credential is never recorded.
        credentialPresent: credentialPresent(req, auth),
        userAgent: (req.header("user-agent") ?? "").slice(0, 120),
        durationMs: Math.round(performance.now() - started),
      }),
    );
    next();
  });

  // Health is exempt so a tunnel or a person can check liveness without the
  // key. It answers one fixed body and touches nothing.
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use(inboundAuthMiddleware(auth));

  // Parsed here only to record the JSON-RPC method for the trace, which is how
  // probe B2 sees whether Copilot Studio re-lists tools on every turn. The
  // production app's own parser skips a body that is already parsed.
  app.post("/mcp", express.json({ limit: "4mb" }), (req, _res, next) => {
    const body = req.body as { method?: unknown; id?: unknown; params?: { arguments?: unknown } } | undefined;
    if (body?.method === "tools/call") {
      (req as { argShapeSent?: Record<string, string> }).argShapeSent = argumentShape(body.params?.arguments);
    }
    if (typeof body?.method === "string") (req as { rpcMethod?: string }).rpcMethod = body.method;
    if (typeof body?.id === "string" || typeof body?.id === "number") {
      (req as { rpcId?: string | number }).rpcId = body.id;
    }
    next();
  });
  app.use(((error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error: the request body is not valid JSON." },
      id: null,
    });
  }) satisfies express.ErrorRequestHandler);

  app.use(createApp({ auth, serverFactory: () => buildProbeServer(opts.trace) }));
  return app;
}
