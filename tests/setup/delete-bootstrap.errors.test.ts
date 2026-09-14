import { describe, expect, it } from "vitest";
import type { SetupGraph } from "../../src/setup/adapter.js";
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
      runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer" }),
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

    await expect(runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer" })).rejects.toThrow(
      /Authorization_RequestDenied/,
    );
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

    await expect(runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer" })).rejects.toThrow(
      /Found 2 applications/,
    );
  });
});

describe("parseArgs rejects combining create and delete", () => {
  it("throws a clear message rather than letting one flag silently win", () => {
    const argv = [...base, "--create-bootstrap", "--delete-bootstrap"];

    expect(() => parseArgs(argv)).toThrow(/--create-bootstrap.*--delete-bootstrap/);
  });
});
