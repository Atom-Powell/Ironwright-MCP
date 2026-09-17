import { describe, expect, it } from "vitest";
import { buildSeedPlan, createSeedGraphClient } from "../../../scripts/seed-library.js";
import { createSeedWorkbook } from "../../../scripts/seed/workbook.js";
import { parseWorkbookGrid } from "../../../src/workbook/xlsx.js";
import { exampleSeedProfile } from "./fixtures.js";

interface Recorded {
  method: string;
  url: string;
  body: string;
}

function recordingClient(responder: (call: Recorded) => Response) {
  const calls: Recorded[] = [];
  const client = createSeedGraphClient({
    tokenProvider: { getToken: async () => "token" },
    fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = init?.body;
      const call = {
        method: init?.method ?? "GET",
        url: String(input),
        body: typeof body === "string" ? body : body === undefined ? "" : "<bytes>",
      };
      calls.push(call);
      return responder(call);
    }) as typeof fetch,
  });
  return { client, calls };
}

/**
 * Keeps the raw bytes of the one content upload createSeedWorkbook makes,
 * rather than only recording that an upload happened, so a test can hand them
 * to the production parser instead of only counting calls.
 */
function bytesCapturingClient() {
  let uploaded: Uint8Array | undefined;
  const client = createSeedGraphClient({
    tokenProvider: { getToken: async () => "token" },
    fetchImpl: (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (init?.body instanceof Uint8Array) uploaded = init.body;
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });
  return { client, getUploaded: (): Uint8Array => {
    if (uploaded === undefined) {
      throw new Error("No PUT carrying a Uint8Array body was observed; createSeedWorkbook did not upload bytes.");
    }
    return uploaded;
  } };
}

const plan = () => buildSeedPlan(exampleSeedProfile(), { clientCount: 12, year: 2026, includeQuarterly: true, throughMonth: 9 });

describe("createSeedWorkbook", () => {
  it("creates the workbook with a single content upload and no workbook API call at all", async () => {
    const { client, calls } = recordingClient(() => new Response("{}", { status: 200 }));

    await createSeedWorkbook(client, "drive-1", "/Trackers/Operational Tracking Workbook.xlsx", plan());

    expect(calls.filter((call) => call.url.includes("/workbook/"))).toEqual([]);
    const uploads = calls.filter((call) => call.url.endsWith("/content"));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.method).toBe("PUT");
    expect(uploads[0]?.body).toBe("<bytes>");
  });

  it("writes a table the production parser can resolve by name", async () => {
    // The seeder and the reader meeting on real bytes. This is not
    // agree-by-construction: the reader is the production parser
    // (src/workbook/xlsx.ts's parseWorkbookGrid), and what it proves is that
    // the seeded file is one the server can actually read, not merely one
    // this test's own expectations agree with.
    const { client, getUploaded } = bytesCapturingClient();

    await createSeedWorkbook(client, "drive-1", "/Trackers/Book.xlsx", plan());

    const { grid } = parseWorkbookGrid(getUploaded(), { kind: "table", name: "ClientRoster" });
    expect(grid[0]).toContain("Client");
    expect(grid).toHaveLength(plan().workbookClients.length + 1);
  });

  it("writes the Onboarded column as ISO text a real workbook reader can parse as an effective date", async () => {
    // Controller ruling: the Onboarded column is written as ISO text rather
    // than a number carrying a date format, because applying that format
    // would need both a styles.xml cellXfs entry nothing else in this seed
    // needs and a /workbook/ range call, the unreachable API this task
    // exists to route around. src/workbook/read.ts's readWorkbookGrid
    // screens a text date through the same predicate it applies to a
    // converted serial, so this is a deliberate choice, not an oversight.
    const { client, getUploaded } = bytesCapturingClient();

    await createSeedWorkbook(client, "drive-1", "/Trackers/Book.xlsx", plan());

    const { grid } = parseWorkbookGrid(getUploaded(), { kind: "table", name: "ClientRoster" });
    expect(grid[0]?.[3]).toBe("Onboarded");
    expect(grid[1]?.[3]).toBe("2026-01-01");
  });

  it("sends the client rows in the uploaded workbook", async () => {
    const { client, getUploaded } = bytesCapturingClient();

    await createSeedWorkbook(client, "drive-1", "/Trackers/Book.xlsx", plan());

    const { grid } = parseWorkbookGrid(getUploaded(), { kind: "table", name: "ClientRoster" });
    expect(grid[0]).toEqual(["Client", "Monthly Training", "Quarterly Phishing", "Onboarded"]);
    expect(grid[1]).toEqual(["Client01", "Yes", "Yes", "2026-01-01"]);
  });

  it("creates every ancestor folder in order for a workbook nested two levels deep", async () => {
    const { client, calls } = recordingClient(() => new Response("{}", { status: 200 }));

    await createSeedWorkbook(client, "drive-1", "/Ops/Trackers/Workbook.xlsx", plan());

    // One POST per ancestor level, root to leaf, then the one content
    // upload: "Ops" under the drive root, then "Trackers" under "Ops". A
    // single createFolder call naming "Trackers" under a parent that was
    // never created would fail against a real tenant, which is exactly the
    // defect this test guards against.
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST", "PUT"]);
    expect(calls[0]?.url).not.toContain("Ops:/children");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ name: "Ops" });
    expect(calls[1]?.url).toContain("root:/Ops:/children");
    expect(JSON.parse(calls[1]?.body ?? "{}")).toMatchObject({ name: "Trackers" });
  });

  it("issues no folder call for a workbook at the library root", async () => {
    const { client, calls } = recordingClient(() => new Response("{}", { status: 200 }));

    await createSeedWorkbook(client, "drive-1", "/Workbook.xlsx", plan());

    expect(calls.map((call) => call.method)).toEqual(["PUT"]);
  });

  it("returns the number of Graph requests actually issued", async () => {
    const { client } = recordingClient(() => new Response("{}", { status: 200 }));

    const result = await createSeedWorkbook(client, "drive-1", "/Ops/Workbook.xlsx", plan());

    // One createFolder ("Ops") plus one content upload.
    expect(result.requests).toBe(2);
  });
});
