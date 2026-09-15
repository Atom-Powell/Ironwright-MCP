import { describe, expect, it } from "vitest";
import { buildSeedPlan, createSeedGraphClient } from "../../../scripts/seed-library.js";
import { createSeedWorkbook } from "../../../scripts/seed/workbook.js";
import { exampleSeedProfile } from "./fixtures.js";

const plan = () => buildSeedPlan(exampleSeedProfile(), { clientCount: 12, year: 2026, includeQuarterly: true, throughMonth: 9 });

function clientFailing(predicate: (url: string) => boolean, status: number, body: string) {
  return createSeedGraphClient({
    tokenProvider: { getToken: async () => "token" },
    fetchImpl: (async (input: Parameters<typeof fetch>[0]) =>
      predicate(String(input)) ? new Response(body, { status }) : new Response(JSON.stringify({ id: "t" }), { status: 200 })) as typeof fetch,
  });
}

describe("createSeedWorkbook failures", () => {
  it("names the upload when the upload is what failed", async () => {
    const client = clientFailing((url) => url.includes(":/content"), 403, '{"error":{"code":"accessDenied"}}');
    await expect(createSeedWorkbook(client, "drive-1", "/Trackers/Book.xlsx", plan())).rejects.toThrow(
      /Uploading the blank workbook to \/Trackers\/Book\.xlsx failed with 403/,
    );
  });

  it("names the workbook bytes as the suspect when tables/add is what failed", async () => {
    const client = clientFailing((url) => url.includes("/tables/add"), 400, '{"error":{"code":"invalidRequest"}}');
    await expect(createSeedWorkbook(client, "drive-1", "/Trackers/Book.xlsx", plan())).rejects.toThrow(
      /first call that requires Graph to open the uploaded file as a workbook/,
    );
  });

  it("says a table of that name already exists when Graph reports the conflict", async () => {
    const client = clientFailing((url) => url.includes("/tables/add"), 409, '{"error":{"code":"nameAlreadyExists"}}');
    await expect(createSeedWorkbook(client, "drive-1", "/Trackers/Book.xlsx", plan())).rejects.toThrow(
      /already carries a table named ClientRoster/,
    );
  });
});
