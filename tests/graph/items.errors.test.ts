import { describe, expect, it } from "vitest";
import { GraphRequestError } from "../../src/graph/errors.js";
import { createFile, createFolder, MAX_SMALL_UPLOAD_BYTES, overwriteFile, readDriveItem, UploadTooLargeError } from "../../src/graph/items.js";
import { F1B_FOLDER_CONFLICT, F2B_FILE_CONFLICT, F3B_STALE_ETAG } from "./fixtures/assessment-probe.js";

function failure(status: number, body: unknown): GraphRequestError {
  return new GraphRequestError({ method: "X", path: "/p", status, body: JSON.stringify(body) });
}

function failingClient(error: unknown) {
  let calls = 0;
  const fail = async (): Promise<never> => {
    calls += 1;
    throw error;
  };
  return { calls: () => calls, get: fail, post: fail, putBytes: fail };
}

const BYTES = new Uint8Array([1]);
const FILE = { driveId: "d1", path: "a/b.md", bytes: BYTES, contentType: "text/markdown" };

describe("readDriveItem failures", () => {
  it("maps a 404 to not_found", async () => {
    const client = failingClient(failure(404, { error: { code: "itemNotFound" } }));
    await expect(readDriveItem(client, { driveId: "d1", path: "a" })).resolves.toEqual({ kind: "not_found" });
  });

  it("rethrows any other status", async () => {
    const client = failingClient(failure(403, { error: { code: "accessDenied" } }));
    await expect(readDriveItem(client, { driveId: "d1", path: "a" })).rejects.toMatchObject({ status: 403 });
  });
});

describe("createFolder failures", () => {
  it("maps 409 nameAlreadyExists to already_exists", async () => {
    const client = failingClient(failure(409, F1B_FOLDER_CONFLICT));
    await expect(createFolder(client, { driveId: "d1", parentPath: "", name: "a" })).resolves.toEqual({ kind: "already_exists" });
  });

  it("rethrows a 409 with another code", async () => {
    const client = failingClient(failure(409, { error: { code: "resourceLocked" } }));
    await expect(createFolder(client, { driveId: "d1", parentPath: "", name: "a" })).rejects.toMatchObject({ code: "resourceLocked" });
  });
});

describe("createFile failures", () => {
  it("maps 409 nameAlreadyExists to name_conflict", async () => {
    const client = failingClient(failure(409, F2B_FILE_CONFLICT));
    await expect(createFile(client, FILE)).resolves.toEqual({ kind: "name_conflict" });
  });

  it("rethrows a 409 with another code", async () => {
    const client = failingClient(failure(409, { error: { code: "resourceLocked" } }));
    await expect(createFile(client, FILE)).rejects.toMatchObject({ code: "resourceLocked" });
  });
});

describe("overwriteFile failures", () => {
  it("maps a 412 to precondition_failed whatever its code, since Graph answers notAllowed", async () => {
    const client = failingClient(failure(412, F3B_STALE_ETAG));
    await expect(overwriteFile(client, { ...FILE, etag: "<etag-1>" })).resolves.toEqual({ kind: "precondition_failed" });
  });

  it("rethrows any other status", async () => {
    const client = failingClient(failure(500, { error: { code: "generalException" } }));
    await expect(overwriteFile(client, { ...FILE, etag: "<etag-1>" })).rejects.toMatchObject({ status: 500 });
  });
});

describe("the small upload ceiling", () => {
  const tooBig = new Uint8Array(MAX_SMALL_UPLOAD_BYTES + 1);

  it("refuses 4194305 bytes in createFile before calling the client", async () => {
    const client = failingClient(new Error("must not be called"));
    await expect(createFile(client, { ...FILE, bytes: tooBig })).rejects.toBeInstanceOf(UploadTooLargeError);
    expect(client.calls()).toBe(0);
  });

  it("refuses 4194305 bytes in overwriteFile before calling the client", async () => {
    const client = failingClient(new Error("must not be called"));
    await expect(overwriteFile(client, { ...FILE, bytes: tooBig, etag: "e" })).rejects.toBeInstanceOf(UploadTooLargeError);
    expect(client.calls()).toBe(0);
  });

  it("names the byte count received and the cap", () => {
    const message = new UploadTooLargeError(4194305).message;
    expect(message).toContain("4194305");
    expect(message).toContain(String(MAX_SMALL_UPLOAD_BYTES));
  });
});
