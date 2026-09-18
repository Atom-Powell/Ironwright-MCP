import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { buildServer } from "../../src/mcp/build-server.js";
import { createFakeToolContext } from "../tools/fake-context.js";
import { ALL_TOOLS } from "../../src/tools/registry.js";
import { STUB_OUTPUT_SCHEMA } from "../../src/tools/stub-output.js";
import type { ToolDefinition } from "../../src/tools/types.js";

async function callTool(definitions: ToolDefinition[], name: string, args: Record<string, unknown>) {
  const server = buildServer({ allowWrites: true, context: createFakeToolContext(), tools: definitions });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

const HANDLED: ToolDefinition = {
  name: "handled_tool",
  kind: "read",
  title: "Handled",
  description: "A tool with a handler. Read-only: this tool makes no changes and is safe to repeat.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: z.object({ echo: z.string().describe("Text to echo back, for example \"hello\".") }),
  outputSchema: { echoed: z.string().describe("What came in, for example \"hello\".") },
  handler: async (input) => {
    const { echo } = z.object({ echo: z.string() }).parse(input);
    return { structuredContent: { echoed: echo }, content: [{ type: "text" as const, text: echo }] };
  },
};

/**
 * Carries `STUB_OUTPUT_SCHEMA` rather than the echo schema, because the SDK
 * validates a result's `structuredContent` against the declared outputSchema
 * and answers a mismatch with an error result. An unwired tool in the real
 * registry declares that schema for exactly this reason, so a fixture that
 * declared any other would be testing a tool this server could not serve.
 */
const STUBBED: ToolDefinition = { ...HANDLED, name: "stubbed_tool", outputSchema: STUB_OUTPUT_SCHEMA };
delete (STUBBED as { handler?: unknown }).handler;

const REFINED_CONSTRAINT = "at least one of a or b must be set";

/**
 * The one fixture in this suite whose input schema is a ZodEffects rather than
 * a plain ZodObject. The tool contract widening this task adds exists so a
 * schema like this can reach `registerTool` at all; a fixture that never
 * builds one would leave that claim unexercised, which is exactly the failure
 * mode `docs/OPEN-ITEMS.md` records from the Excel session work: a capability
 * built and reviewed without ever calling the API it depends on.
 */
const REFINED: ToolDefinition = {
  name: "refined_tool",
  kind: "read",
  title: "Refined",
  description: `Exercises a refined input schema at registration time. ${REFINED_CONSTRAINT}. Read-only: this tool makes no changes and is safe to repeat.`,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: z
    .object({
      a: z.string().optional().describe("First value, for example \"x\"."),
      b: z.string().optional().describe("Second value, for example \"y\"."),
    })
    .refine((value) => value.a !== undefined || value.b !== undefined),
  inputConstraints: REFINED_CONSTRAINT,
  outputSchema: { ok: z.boolean().describe("Always true, for example true.") },
  // A real handler rather than the no-handler stub path, so a call that clears
  // input validation returns structuredContent matching this fixture's own
  // outputSchema instead of failing output validation against the stub shape,
  // which would be a false positive for the input-validation claim under test.
  handler: async () => ({ structuredContent: { ok: true }, content: [{ type: "text" as const, text: "ok" }] }),
};

describe("buildServer", () => {
  it("routes a call to the tool's own handler when it has one", async () => {
    const result = await callTool([HANDLED], "handled_tool", { echo: "hello" });

    expect(result.structuredContent).toEqual({ echoed: "hello" });
  });

  it("hands the shared context to the handler", async () => {
    let sawProfileIds: string[] | undefined;
    const spy: ToolDefinition = {
      ...HANDLED,
      handler: async (_input, context) => {
        sawProfileIds = context.profiles.ids();
        return { structuredContent: { echoed: "ok" }, content: [{ type: "text" as const, text: "ok" }] };
      },
    };

    await callTool([spy], "handled_tool", { echo: "hello" });

    expect(sawProfileIds).toEqual(["example"]);
  });

  it("still serves the stub answer for a tool with no handler", async () => {
    const result = await callTool([STUBBED], "stubbed_tool", { echo: "hello" });

    expect(result.structuredContent).toMatchObject({ stub: true });
  });

  it("defaults to the full registry when no tool list is given", () => {
    const server = buildServer({ allowWrites: true, context: createFakeToolContext() });

    expect(server).toBeDefined();
    expect(ALL_TOOLS.length).toBeGreaterThan(0);
  });

  it("registers a refined (ZodEffects) input schema without throwing, though its fields do not survive the advertised listing", async () => {
    // If the installed SDK refused a ZodEffects schema outright, this call
    // would throw here, before a client ever connects. Asserting that
    // explicitly, rather than only letting an uncaught throw fail the test,
    // names the exact claim under test: this is the mechanism phase 6 depends
    // on, and it must be exercised once rather than assumed, per the lesson
    // this project already learned once from the Excel session work.
    const build = () => buildServer({ allowWrites: true, context: createFakeToolContext(), tools: [REFINED] });
    expect(build).not.toThrow();

    const server = build();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const listed = await client.listTools();
      const tool = listed.tools.find((entry) => entry.name === "refined_tool");
      expect(tool).toBeDefined();

      // This is the finding, pinned rather than worked around. The installed
      // SDK (1.30.0) converts a tool's inputSchema to JSON Schema through
      // normalizeObjectSchema, which recognizes an already-built object
      // schema only by a bare `.shape` property. A ZodEffects, which is what
      // `.refine()` produces, keeps that on `.innerType()` instead, so
      // normalizeObjectSchema returns undefined and the SDK falls back to an
      // empty object schema for the whole tool. Both fields this tool
      // declares are absent from what a caller, model included, would see.
      expect(tool?.inputSchema?.properties).toEqual({});

      // The gap is confined to the advertised listing. Call-time validation
      // takes the same fallback path but lands differently: mcp.js's
      // validateToolInput also calls normalizeObjectSchema, gets undefined for
      // the same reason, and then parses against tool.inputSchema itself
      // rather than an empty schema, so the ZodEffects and its refinement run
      // for real. A call satisfying neither field is rejected server-side even
      // though nothing in the advertised schema told the caller that.
      const rejected = await client.callTool({ name: "refined_tool", arguments: {} });
      expect(rejected.isError).toBe(true);

      const accepted = await client.callTool({ name: "refined_tool", arguments: { a: "x" } });
      expect(accepted.isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
