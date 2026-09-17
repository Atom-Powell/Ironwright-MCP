import { describe, expect, it } from "vitest";
import { createGraphClient } from "../../src/graph/client.js";
import { downloadDriveItem, MAX_WORKBOOK_DOWNLOAD_BYTES } from "../../src/graph/content.js";
import { GraphResponseTooLargeError } from "../../src/graph/errors.js";

const tokenProvider = { getToken: async (): Promise<string> => "test-token" };

function clientReturning(response: () => Response): ReturnType<typeof createGraphClient> {
  return createGraphClient({ tokenProvider, fetchImpl: (async () => response()) as typeof fetch });
}

describe("downloadDriveItem failures", () => {
  it("refuses a body whose Content-Length exceeds the cap, before reading it", async () => {
    const client = clientReturning(
      () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-length": String(MAX_WORKBOOK_DOWNLOAD_BYTES + 1) },
        }),
    );

    await expect(downloadDriveItem(client, { driveId: "d1", workbookPath: "/Book.xlsx" })).rejects.toMatchObject({
      name: "GraphResponseTooLargeError",
      message: expect.stringMatching(/larger than the 50 MB this server will download/) as unknown,
    });
  });

  it("refuses a body that exceeds the cap despite an absent Content-Length", async () => {
    const client = clientReturning(
      () => new Response(new Uint8Array(MAX_WORKBOOK_DOWNLOAD_BYTES + 1), { status: 200 }),
    );

    await expect(downloadDriveItem(client, { driveId: "d1", workbookPath: "/Book.xlsx" })).rejects.toMatchObject({
      name: "GraphResponseTooLargeError",
      message: expect.stringMatching(/larger than the 50 MB this server will download/) as unknown,
    });
  });

  it("refuses a redirect that names no location", async () => {
    const client = clientReturning(() => new Response(null, { status: 302 }));

    await expect(downloadDriveItem(client, { driveId: "d1", workbookPath: "/Book.xlsx" })).rejects.toThrow(
      /answered 302 with no location header/,
    );
  });
});

describe("GraphResponseTooLargeError message formatting", () => {
  // The workbook cap divides evenly by 1 MiB, so the tests above never exercise
  // a maxBytes that does not. A future caller with a limit of its own, such as
  // a per-tool cap smaller than the workbook one, is not guaranteed to divide
  // evenly, and the message must still read as a number rather than the long
  // repeating decimal a bare String() on the division would produce.
  it("renders a whole-megabyte limit with no decimal point", () => {
    const error = new GraphResponseTooLargeError({ path: "/x", bytes: 2 * 1024 * 1024, maxBytes: 1 * 1024 * 1024 });
    expect(error.message).toContain("larger than the 1 MB this server will download");
  });

  it("renders a limit that does not divide evenly by 1 MiB as a short decimal, not a repeating one", () => {
    const error = new GraphResponseTooLargeError({
      path: "/x",
      bytes: 2 * 1024 * 1024,
      maxBytes: 1.5 * 1024 * 1024,
    });
    expect(error.message).toContain("larger than the 1.5 MB this server will download");
  });
});
