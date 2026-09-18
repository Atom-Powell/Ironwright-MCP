import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { buildServer } from "../../../src/mcp/build-server.js";
import { createFakeToolContext } from "../../tools/fake-context.js";
import { VALIDATE_STRUCTURE_OUTPUT_SCHEMA } from "../../../src/tools/validate/output.js";
import { shapeValidateStructure } from "../../../src/tools/validate/shape.js";
import type { ScanCoordinator } from "../../../src/scan/coordinator.js";
import type { Profile } from "../../../src/domain/profile/schema.js";
import type { RepositorySnapshot } from "../../../src/domain/reconcile/index.js";

const PROFILE: Profile = {
  profileId: "example",
  identity: {
    siteUrl: "https://contoso.sharepoint.com/sites/Example",
    library: "Compliance Reports",
    workbookPath: "/Trackers/Tracker.xlsx",
  },
  taxonomy: { segments: ["{year}", "{client}", "{month:02}"] },
  naming: { template: "{year}-{month:02}_{client}_{deliverable}.xlsx", recognizers: [] },
  deliverables: [
    {
      id: "monthly-training",
      token: "TRAINING",
      cadence: "monthly",
      periodAnchor: "last",
      appliesTo: { workbookField: "monthlyTraining", truthy: true },
    },
  ],
  workbookMapping: {
    source: { kind: "table", name: "ClientRoster" },
    headerRow: 1,
    columns: { client: "Client", monthlyTraining: "Monthly Training" },
  },
  window: { mode: "rolling", months: 12, respectEffectiveFrom: false },
};

const SNAPSHOT: RepositorySnapshot = {
  files: [
    { path: "2026/CLIENTA/09/2026-09_CLIENTA_TRAINING.xlsx", name: "2026-09_CLIENTA_TRAINING.xlsx", size: 12, modified: "2026-09-01T00:00:00.000Z", etag: "a" },
  ],
  folderPaths: ["2026", "2026/CLIENTA", "2026/CLIENTA/09"],
  scannedAt: "2026-09-17T00:00:00.000Z",
  searchCrossCheckIncluded: false,
};

// Distinct from PROFILE/SNAPSHOT above: the real "example" profile the fake
// context's registry loads from examples/profiles/example.json, whose
// taxonomy and naming template shape differ (a "{monthName}" segment, and
// "MonthlyTraining" rather than "TRAINING" as the deliverable token). The
// wire tests go through that real registry rather than a profile this file
// invents, so their fixture data has to conform to it instead.
const REAL_EXAMPLE_SNAPSHOT: RepositorySnapshot = {
  files: [
    {
      path: "2026/CLIENTA/09-September/2026-09_CLIENTA_MonthlyTraining.xlsx",
      name: "2026-09_CLIENTA_MonthlyTraining.xlsx",
      size: 12,
      modified: "2026-09-01T00:00:00.000Z",
      etag: "a",
    },
  ],
  folderPaths: ["2026", "2026/CLIENTA", "2026/CLIENTA/09-September"],
  scannedAt: "2026-09-17T00:00:00.000Z",
  searchCrossCheckIncluded: false,
};

describe("validate_structure over the wire", () => {
  it("reports a failure as a tool error the model can read, not a transport fault", async () => {
    // The fake context's scan coordinator rejects, so this exercises the whole
    // dispatch path including the error mapping.
    const server = buildServer({ allowWrites: false, context: createFakeToolContext() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({
        name: "validate_structure",
        arguments: { profileId: "example" },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("declares an output schema the shaped validation validates against", () => {
    const output = shapeValidateStructure("example", "Compliance Reports", PROFILE, SNAPSHOT, undefined, 3, {});

    expect(() => z.object(VALIDATE_STRUCTURE_OUTPUT_SCHEMA).parse(output)).not.toThrow();
  });

  it("returns a populated structuredContent that passes the SDK's own output validation on success", async () => {
    // The two tests above cover the error path (structuredContent absent, the
    // SDK never validates) and the shape in isolation (a local schema parse
    // with the SDK nowhere in the loop). Neither exercises the SDK's own
    // outputSchema validator against a real successful result over a real
    // transport. This one does, with a snapshot that produces one compliant
    // client so every field the schema declares is populated at least once.
    const scans: ScanCoordinator = {
      run: () =>
        Promise.resolve({
          result: {
            snapshot: REAL_EXAMPLE_SNAPSHOT,
            driveId: "drive-1",
            mode: "full",
            resynced: false,
            pages: 1,
            changesApplied: 0,
            graphRequests: 3,
            storeBatches: 0,
            unfilteredFileCount: REAL_EXAMPLE_SNAPSHOT.files.length,
            unfilteredFolderCount: REAL_EXAMPLE_SNAPSHOT.folderPaths.length,
          },
          joined: false,
        }),
    };

    const context = createFakeToolContext({ scans });

    const server = buildServer({ allowWrites: false, context });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await client.callTool({
        name: "validate_structure",
        arguments: { profileId: "example" },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toBeDefined();
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.profileId).toBe("example");
      expect(structured.library).toBe("Compliance Reports");
      expect(structured.graphRequests).toBe(3);
      const clients = structured.clients;
      expect(Array.isArray(clients) && clients.length).toBe(1);
      expect((clients as Array<Record<string, unknown>>)[0]?.verdict).toBe("compliant");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("no longer advertises the stub output schema", async () => {
    const server = buildServer({ allowWrites: false, context: createFakeToolContext() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const listed = (await client.listTools()).tools.find((tool) => tool.name === "validate_structure");

      expect(Object.keys(listed?.outputSchema?.properties ?? {})).toContain("clients");
      expect(Object.keys(listed?.outputSchema?.properties ?? {})).not.toContain("stub");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
