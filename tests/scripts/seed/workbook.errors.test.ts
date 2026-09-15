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

  it("names the workbook bytes as the suspect when the first workbook-opening call fails", async () => {
    // The client rows range write is the first call requiring Graph to open
    // the uploaded file as a workbook. Its URL address, "A1:D14" for the
    // default plan, is what distinguishes it from the second range PATCH
    // ("D2:D14") and from tables/add, which carries no address in its URL.
    const client = clientFailing((url) => url.includes("range(address='A1:D14')"), 400, '{"error":{"code":"invalidRequest"}}');
    await expect(createSeedWorkbook(client, "drive-1", "/Trackers/Book.xlsx", plan())).rejects.toThrow(
      /first call that requires Graph to open the uploaded file as a workbook/,
    );
  });

  it("names the table request itself as the suspect, not the bytes, when tables/add fails for another reason", async () => {
    // By the time tables/add runs, both range writes above have already
    // succeeded, so the code has positively observed that Graph opened the
    // uploaded file as a workbook. The message must not blame the bytes for
    // something it has evidence against.
    const client = clientFailing((url) => url.includes("/tables/add"), 400, '{"error":{"code":"invalidRequest"}}');
    const failure = await createSeedWorkbook(client, "drive-1", "/Trackers/Book.xlsx", plan()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/this request's own address, header row, or an existing table/);
    expect((failure as Error).message).not.toMatch(/the bytes/);
  });

  it("says a table of that name already exists when Graph reports the conflict", async () => {
    const client = clientFailing((url) => url.includes("/tables/add"), 409, '{"error":{"code":"nameAlreadyExists"}}');
    await expect(createSeedWorkbook(client, "drive-1", "/Trackers/Book.xlsx", plan())).rejects.toThrow(
      /already carries a table named ClientRoster/,
    );
  });
});
