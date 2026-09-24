import { describe, expect, it } from "vitest";
import { EmptyRelocationError, relocateDriveItem } from "../../src/graph/relocate.js";
import { GraphRequestError } from "../../src/graph/errors.js";

function failingClient(status: number, body = "{}") {
  return {
    patch: async <T>(path: string): Promise<T> => {
      throw new GraphRequestError({ method: "PATCH", path, status, body });
    },
  };
}

const MOVE = { driveId: "d1", path: "a/f.xlsx", etag: "e1", newParentPath: "b" };

describe("relocateDriveItem failures", () => {
  it("refuses a call that changes neither name nor folder, before any request", async () => {
    let called = false;
    const client = { patch: async <T>(): Promise<T> => { called = true; return {} as T; } };

    await expect(relocateDriveItem(client, { driveId: "d1", path: "a/f.xlsx", etag: "e1" })).rejects.toBeInstanceOf(
      EmptyRelocationError,
    );
    expect(called).toBe(false);
  });

  it("maps a 412 to a failed precondition", async () => {
    await expect(relocateDriveItem(failingClient(412), MOVE)).resolves.toEqual({ kind: "precondition_failed" });
  });

  it("maps a 404 to not found", async () => {
    await expect(relocateDriveItem(failingClient(404), MOVE)).resolves.toEqual({ kind: "not_found" });
  });

  it("rethrows the 400 an absent target folder answers, which is indistinguishable from any bad request", async () => {
    await expect(relocateDriveItem(failingClient(400, '{"error":{"code":"invalidRequest"}}'), MOVE)).rejects.toBeInstanceOf(
      GraphRequestError,
    );
  });

  it("maps a 409 nameAlreadyExists to a name conflict", async () => {
    await expect(
      relocateDriveItem(failingClient(409, '{"error":{"code":"nameAlreadyExists","message":"Name already exists"}}'), MOVE),
    ).resolves.toEqual({ kind: "name_conflict" });
  });

  it("rethrows a 409 carrying any other code, since only nameAlreadyExists was measured", async () => {
    await expect(relocateDriveItem(failingClient(409, '{"error":{"code":"somethingElse"}}'), MOVE)).rejects.toBeInstanceOf(
      GraphRequestError,
    );
  });

  it("reports an absent etag for each shape a bodiless response can take", async () => {
    for (const response of [{}, undefined, null]) {
      const client = { patch: async <T>(): Promise<T> => response as T };
      await expect(relocateDriveItem(client, MOVE)).resolves.toEqual({ kind: "relocated", etag: undefined });
    }
  });
});
