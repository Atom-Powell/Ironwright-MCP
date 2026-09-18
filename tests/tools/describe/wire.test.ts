import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { buildServer } from "../../../src/mcp/build-server.js";
import { createFakeToolContext, createFakeWorkbookGraphClient } from "../../tools/fake-context.js";
import { buildWorkbook } from "../../workbook/xlsx-fixture.js";
import { DESCRIBE_OUTPUT_SCHEMA } from "../../../src/tools/describe/output.js";
import { shapeDescribeSource } from "../../../src/tools/describe/shape.js";

function workbookBytes(): Uint8Array {
  return buildWorkbook({
    sheets: [
      {
        name: "Tracking",
        dimension: "A1:B3",
        rowsXml:
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>3</v></c></row>' +
          '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>1</v></c></row>',
      },
    ],
    sharedStrings: ["Client", "Owed", "CLIENTA", "CLIENTB"],
    tables: [{ name: "ClientTable", ref: "A1:B3", sheetIndex: 0 }],
  });
}

describe("describe_workbook over the wire", () => {
  it("reports a failure as a tool error the model can read, not a transport fault", async () => {
    // The fake context's Graph client rejects every call, so this exercises
    // the whole dispatch path including the error mapping.
    const server = buildServer({ allowWrites: false, context: createFakeToolContext() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({
        name: "describe_workbook",
        arguments: { library: "Documents", workbookPath: "Trackers/Book.xlsx" },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("declares an output schema the shaped source description validates against", () => {
    const output = shapeDescribeSource(
      "Documents",
      "Trackers/Book.xlsx",
      { kind: "table", name: "ClientTable" },
      {
        columns: [
          {
            position: 1,
            columnLabel: "A",
            header: "Client",
            headerUnevaluable: false,
            inferredType: "string",
            nonEmptyCount: 2,
            unevaluableCount: 0,
            distinctCount: 2,
            samples: ["CLIENTA", "CLIENTB"],
            samplesOmitted: 0,
          },
        ],
        headerRow: { proposed: 1, candidates: [] },
        samplesWithheld: false,
        sampleCap: 5,
      },
      2,
      {},
    );

    expect(() => z.object(DESCRIBE_OUTPUT_SCHEMA).parse(output)).not.toThrow();
  });

  it("returns a populated structuredContent, with at least one described column, that passes the SDK's own output validation on success", async () => {
    const context = createFakeToolContext({
      graph: createFakeWorkbookGraphClient({
        library: "Documents",
        workbooksByPath: { "Trackers/Book.xlsx": workbookBytes() },
      }),
    });

    const server = buildServer({ allowWrites: false, context });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({
        name: "describe_workbook",
        arguments: { library: "Documents", workbookPath: "Trackers/Book.xlsx", source: { kind: "table", name: "ClientTable" } },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toBeDefined();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.mode).toBe("source");
      const columns = structured.columns;
      expect(Array.isArray(columns) && columns.length).toBeGreaterThan(0);
      expect((columns as Array<Record<string, unknown>>)[0]?.header).toBe("Client");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("no longer advertises a siteUrl input, or the stub output schema", async () => {
    const server = buildServer({ allowWrites: false, context: createFakeToolContext() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const listed = (await client.listTools()).tools.find((tool) => tool.name === "describe_workbook");

      expect(Object.keys(listed?.inputSchema?.properties ?? {})).not.toContain("siteUrl");
      expect(Object.keys(listed?.inputSchema?.properties ?? {})).toEqual(
        expect.arrayContaining(["library", "workbookPath", "source"]),
      );
      expect(Object.keys(listed?.outputSchema?.properties ?? {})).toContain("mode");
      expect(Object.keys(listed?.outputSchema?.properties ?? {})).not.toContain("stub");
      expect(listed?.description).not.toContain("named range");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
