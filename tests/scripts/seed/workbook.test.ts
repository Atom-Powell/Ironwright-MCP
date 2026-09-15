import { describe, expect, it } from "vitest";
import { buildSeedPlan, createSeedGraphClient } from "../../../scripts/seed-library.js";
import { createSeedWorkbook } from "../../../scripts/seed/workbook.js";
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

const plan = () => buildSeedPlan(exampleSeedProfile(), { clientCount: 12, year: 2026, includeQuarterly: true, throughMonth: 9 });

describe("createSeedWorkbook", () => {
  it("creates the parent folder, uploads, writes the range, adds and names the table, in that order", async () => {
    const { client, calls } = recordingClient((call) =>
      call.url.includes("/tables/add")
        ? new Response(JSON.stringify({ id: "{table-1}" }), { status: 201 })
        : new Response("{}", { status: 200 }),
    );

    await createSeedWorkbook(client, "drive-1", "/Trackers/Operational Tracking Workbook.xlsx", plan());

    expect(calls.map((call) => call.method)).toEqual(["POST", "PUT", "PATCH", "PATCH", "POST", "PATCH"]);
    expect(calls[1]?.url).toContain("Operational%20Tracking%20Workbook.xlsx:/content");
    expect(calls[1]?.body).toBe("<bytes>");
    expect(calls[2]?.url).toContain(`worksheets('${"Sheet1"}')/range(address='A1:D14')`);
    expect(calls[3]?.url).toContain("range(address='D2:D14')");
    expect(calls[4]?.url).toContain("/workbook/tables/add");
    expect(JSON.parse(calls[4]?.body ?? "{}")).toMatchObject({ address: expect.stringContaining("A1:D14"), hasHeaders: true });
    expect(JSON.parse(calls[5]?.body ?? "{}")).toEqual({ name: "ClientRoster" });
  });

  it("sends the client rows in the range body", async () => {
    const { client, calls } = recordingClient((call) =>
      call.url.includes("/tables/add") ? new Response(JSON.stringify({ id: "t" }), { status: 201 }) : new Response("{}", { status: 200 }),
    );
    await createSeedWorkbook(client, "drive-1", "/Trackers/Book.xlsx", plan());
    const values = (JSON.parse(calls[2]?.body ?? "{}") as { values: unknown[][] }).values;
    expect(values[0]).toEqual(["Client", "Monthly Training", "Quarterly Phishing", "Onboarded"]);
    expect(values).toHaveLength(14);
  });
});
