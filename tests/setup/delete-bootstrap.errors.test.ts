import { describe, expect, it } from "vitest";
import type { SetupGraph } from "../../src/setup/adapter.js";
import { GraphRequestError } from "../../src/graph/errors.js";
import { parseArgs } from "../../src/setup/cli.js";
import { runDeleteBootstrap } from "../../src/setup/run.js";

const base = ["node", "main.js", "--tenant=contoso.onmicrosoft.com"];

function fakeGraph(overrides: Partial<SetupGraph> = {}): SetupGraph {
  return {
    findApplicationByDisplayName: async () => undefined,
    deleteApplication: async () => {},
    purgeDeletedApplication: async () => {},
    resolveSite: async () => ({ siteId: "should-not-be-called" }),
    createApplication: async () => {
      throw new Error("should not be called");
    },
    addPassword: async () => ({ secretText: "should-not-be-called" }),
    createServicePrincipal: async () => ({ objectId: "should-not-be-called" }),
    resolveServicePrincipal: async () => ({ objectId: "should-not-be-called", appRoles: [] }),
    grantAppRole: async () => {},
    grantSitePermission: async () => ({ permissionId: "should-not-be-called" }),
    listSitePermissions: async () => [],
    verifyAppAccess: async () => ({ status: 200, body: "{}", appRoles: [] }),
    deleteSitePermission: async () => {},
    ...overrides,
  };
}

describe("runDeleteBootstrap not found", () => {
  // Was a throw before this task: an already-absent grant issuer is the
  // outcome a teardown wants, not a failure, so the lookup finding nothing
  // now returns a distinct outcome instead of rejecting. The display-name and
  // --name framing formerly asserted on the thrown message now lives in
  // describeDeleteBootstrapSuccess's already-absent branch, covered in
  // delete-bootstrap.test.ts.
  it("reports the missing application as already-absent rather than throwing", async () => {
    const graph = fakeGraph({ findApplicationByDisplayName: async () => undefined });

    await expect(
      runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer", confirm: true }),
    ).resolves.toEqual({ kind: "already-absent", displayName: "Ironwright Grant Issuer" });
  });
});

describe("runDeleteBootstrap delete failure", () => {
  it("propagates the original error rather than a wrapped one", async () => {
    const graph = fakeGraph({
      findApplicationByDisplayName: async () => ({ objectId: "obj-1", appId: "app-1" }),
      deleteApplication: async () => {
        throw new Error("Graph DELETE /applications/obj-1 failed with 403: Authorization_RequestDenied");
      },
    });

    await expect(
      runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer", confirm: true }),
    ).rejects.toThrow(/Authorization_RequestDenied/);
  });

  it("does not purge when the delete itself fails", async () => {
    const graph = fakeGraph({
      findApplicationByDisplayName: async () => ({ objectId: "obj-1", appId: "app-1" }),
      deleteApplication: async () => {
        throw new Error("Graph DELETE /applications/obj-1 failed with 403: Authorization_RequestDenied");
      },
      purgeDeletedApplication: async () => {
        throw new Error("should not be called: the delete never succeeded");
      },
    });

    await expect(
      runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer", confirm: true }),
    ).rejects.toThrow(/Authorization_RequestDenied/);
  });
});

// Mirrors delete-server-app.errors.test.ts's own coverage of a 404 from the
// delete: findApplicationByDisplayName can find an application that is gone
// by the time deleteApplication actually reaches it, a concurrent teardown
// or a manual removal in the portal, and this is this command's own founding
// bug (docs/OPEN-ITEMS.md) in a narrower window if it is reported as a
// failure instead of tolerated.
describe("runDeleteBootstrap delete-404", () => {
  it("does not throw when the delete returns 404", async () => {
    const graph = fakeGraph({
      findApplicationByDisplayName: async () => ({ objectId: "obj-1", appId: "app-1" }),
      deleteApplication: async () => {
        throw new GraphRequestError({ method: "DELETE", path: "/applications/obj-1", status: 404, body: "{}" });
      },
    });

    await expect(
      runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer", confirm: true }),
    ).resolves.toMatchObject({ kind: "deleted", applicationDeleted: false });
  });

  it("still purges when the delete returns 404, since the object may already be sitting in deleted items unpurged", async () => {
    const calls: string[] = [];
    const graph = fakeGraph({
      findApplicationByDisplayName: async () => ({ objectId: "obj-1", appId: "app-1" }),
      deleteApplication: async () => {
        calls.push("deleteApplication:obj-1");
        throw new GraphRequestError({ method: "DELETE", path: "/applications/obj-1", status: 404, body: "{}" });
      },
      purgeDeletedApplication: async () => {
        calls.push("purgeDeletedApplication:obj-1");
      },
    });

    const outcome = await runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer", confirm: true });

    expect(calls).toEqual(["deleteApplication:obj-1", "purgeDeletedApplication:obj-1"]);
    expect(outcome).toEqual({
      kind: "deleted",
      appId: "app-1",
      objectId: "obj-1",
      applicationDeleted: false,
      purgeConfirmed: true,
      purgeRetried: false,
    });
  });

  it("rethrows a delete failure that is not a 404", async () => {
    const graph = fakeGraph({
      findApplicationByDisplayName: async () => ({ objectId: "obj-1", appId: "app-1" }),
      deleteApplication: async () => {
        throw new GraphRequestError({
          method: "DELETE",
          path: "/applications/obj-1",
          status: 403,
          body: '{"error":{"code":"Authorization_RequestDenied"}}',
        });
      },
    });

    await expect(
      runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer", confirm: true }),
    ).rejects.toThrow(GraphRequestError);
  });
});

describe("runDeleteBootstrap ambiguous match", () => {
  // findApplicationByDisplayName itself refuses an ambiguous match (see
  // adapter.errors.test.ts); this confirms runDeleteBootstrap does not catch
  // and reinterpret that refusal, since doing so could turn a real ambiguity
  // into a false "nothing to delete" or a guess at which application to
  // remove.
  it("lets the lookup's ambiguity refusal propagate unchanged", async () => {
    const graph = fakeGraph({
      findApplicationByDisplayName: async () => {
        throw new Error(
          'Found 2 applications named "Ironwright Grant Issuer" in this tenant, so which one is meant is ambiguous.',
        );
      },
    });

    await expect(
      runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer", confirm: true }),
    ).rejects.toThrow(/Found 2 applications/);
  });
});

// Mirrors delete-server-app.errors.test.ts's own purge-retry coverage:
// purgeDeletedApplicationWithRetry is the same helper, called the same way,
// so these tests exist to pin that runDeleteBootstrap actually wires it up
// rather than to re-prove the ladder's own behavior.
describe("runDeleteBootstrap purge failure", () => {
  it("tolerates a 404 from the purge but records that the purge was not confirmed", async () => {
    const graph = fakeGraph({
      findApplicationByDisplayName: async () => ({ objectId: "obj-1", appId: "app-1" }),
      purgeDeletedApplication: async () => {
        throw new GraphRequestError({
          method: "DELETE",
          path: "/directory/deletedItems/obj-1",
          status: 404,
          body: "{}",
        });
      },
    });

    await expect(
      runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer", confirm: true }),
    ).resolves.toEqual({
      kind: "deleted",
      appId: "app-1",
      objectId: "obj-1",
      applicationDeleted: true,
      purgeConfirmed: false,
      purgeRetried: false,
    });
  });

  it("retries a purge that answers Request_ResourceNotFound, then gives up cleanly", async () => {
    const graph = fakeGraph({
      findApplicationByDisplayName: async () => ({ objectId: "obj-1", appId: "app-1" }),
      purgeDeletedApplication: async () => {
        throw new GraphRequestError({
          method: "DELETE",
          path: "/directory/deletedItems/obj-1",
          status: 404,
          body: JSON.stringify({ error: { code: "Request_ResourceNotFound" } }),
        });
      },
    });
    const slept: number[] = [];

    const outcome = await runDeleteBootstrap(
      graph,
      { displayName: "Ironwright Grant Issuer", confirm: true },
      {
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
    );

    // Three attempts on the same ladder the server application teardown
    // uses, then an unconfirmed purge rather than a thrown failure: nothing
    // observed says the object is gone, and nothing observed says the purge
    // failed either.
    expect(slept).toEqual([3000, 6000]);
    expect(outcome).toEqual({
      kind: "deleted",
      appId: "app-1",
      objectId: "obj-1",
      applicationDeleted: true,
      purgeConfirmed: false,
      purgeRetried: true,
    });
  });

  it("throws, naming the manual purge call, when the purge fails for a reason other than not-found", async () => {
    const graph = fakeGraph({
      findApplicationByDisplayName: async () => ({ objectId: "obj-1", appId: "app-1" }),
      purgeDeletedApplication: async () => {
        throw new GraphRequestError({
          method: "DELETE",
          path: "/directory/deletedItems/obj-1",
          status: 403,
          body: '{"error":{"code":"Authorization_RequestDenied"}}',
        });
      },
    });

    const failure = runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer", confirm: true });

    await expect(failure).rejects.toThrow(/was deleted/i);
    await expect(failure).rejects.toThrow(/purging it from deleted items failed/i);
    await expect(failure).rejects.toThrow(/30 days/);
    await expect(failure).rejects.toThrow(/DELETE \/directory\/deletedItems\/obj-1/);
  });

  it("re-running after a purge failure reports already-absent rather than retrying the purge", async () => {
    // Documents the same known limitation OPEN-ITEMS.md records for
    // runDeleteServerApp: findApplicationByDisplayName queries the live
    // /applications collection, which excludes a soft-deleted object, so a
    // re-run's lookup finds nothing and never calls purgeDeletedApplication
    // again. This is not a defect this task fixes; it is what the thrown
    // failure message above already tells the operator to expect.
    const graph = fakeGraph({ findApplicationByDisplayName: async () => undefined });

    await expect(
      runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer", confirm: true }),
    ).resolves.toEqual({ kind: "already-absent", displayName: "Ironwright Grant Issuer" });
  });
});

describe("parseArgs rejects combining create and delete", () => {
  it("throws a clear message rather than letting one flag silently win", () => {
    const argv = [...base, "--create-bootstrap", "--delete-bootstrap"];

    expect(() => parseArgs(argv)).toThrow(/--create-bootstrap.*--delete-bootstrap/);
  });
});
