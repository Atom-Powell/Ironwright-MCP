import { describe, expect, it } from "vitest";
import { buildSeedPlan, createSeedGraphClient } from "../../../scripts/seed-library.js";
import { GraphRequestError } from "../../../src/graph/errors.js";
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

// createSeedWorkbook now issues exactly one call after the workbook's
// ancestor folders exist: the content upload. The range write, the number
// format call, the table add and the table rename are gone, along with the
// three-way blame each of their failure messages used to carry, because those
// calls went through the Graph Excel API's /workbook/ surface, which app-only
// tokens cannot reach at all: there is no longer a second or third call whose
// failure this module could misattribute to the uploaded bytes. One failure
// path remains, and it names the one thing that can actually fail.
describe("createSeedWorkbook failures", () => {
  it("names the upload when the upload is what failed", async () => {
    const client = clientFailing((url) => url.includes(":/content"), 403, '{"error":{"code":"accessDenied"}}');
    await expect(createSeedWorkbook(client, "drive-1", "/Trackers/Book.xlsx", plan())).rejects.toThrow(
      /Uploading the workbook to \/Trackers\/Book\.xlsx failed with 403/,
    );
  });

  it("carries Graph's own error code and the response it came from, not the status alone", async () => {
    // A 403 on this call is accessDenied or it is something else, and the two
    // have different remedies. The status alone sends an operator to the
    // wrong one, and the GraphRequestError this catch replaces already
    // carries both the code and the whole response body.
    const client = clientFailing((url) => url.includes(":/content"), 403, '{"error":{"code":"accessDenied"}}');
    const failure = (await createSeedWorkbook(client, "drive-1", "/Trackers/Book.xlsx", plan()).then(
      () => undefined,
      (error: unknown) => error,
    )) as Error;

    expect(failure.message).toContain("accessDenied");
    expect(failure.cause).toBeInstanceOf(GraphRequestError);
    expect((failure.cause as GraphRequestError).body).toContain("accessDenied");
  });

  it("propagates a non-Graph failure unchanged, rather than wrapping it as though Graph answered", async () => {
    const client = createSeedGraphClient({
      tokenProvider: { getToken: async () => "token" },
      fetchImpl: (async () => {
        throw new Error("network unreachable");
      }) as typeof fetch,
    });

    await expect(createSeedWorkbook(client, "drive-1", "/Trackers/Book.xlsx", plan())).rejects.toThrow(
      "network unreachable",
    );
  });
});
