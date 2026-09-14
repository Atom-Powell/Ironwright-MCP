import { describe, expect, it } from "vitest";
import type { SetupGraph } from "../../src/setup/adapter.js";
import { describeDeleteBootstrapSuccess, parseArgs } from "../../src/setup/cli.js";
import { runDeleteBootstrap } from "../../src/setup/run.js";

const base = ["node", "main.js", "--tenant=contoso.onmicrosoft.com"];

// Implements every SetupGraph method, not just the two runDeleteBootstrap is
// expected to call. A fake missing a method throws a TypeError the instant an
// unexpected call reaches it, before the calling test's own assertions run,
// which would make a negative assertion like "creates nothing" pass vacuously
// on a thrown error rather than on the fake actually recording no such call.
function fakeGraph(found: { objectId: string; appId: string } | undefined): {
  graph: SetupGraph;
  calls: string[];
} {
  const calls: string[] = [];
  const graph: SetupGraph = {
    resolveSite: async (sitePath) => {
      calls.push(`resolveSite:${sitePath}`);
      return { siteId: "should-not-be-called" };
    },
    findApplicationByDisplayName: async (displayName) => {
      calls.push(`findApplicationByDisplayName:${displayName}`);
      return found;
    },
    createApplication: async () => {
      calls.push("createApplication");
      return { objectId: "should-not-be-called", appId: "should-not-be-called" };
    },
    addPassword: async (objectId) => {
      calls.push(`addPassword:${objectId}`);
      return { secretText: "should-not-be-called" };
    },
    createServicePrincipal: async (appId) => {
      calls.push(`createServicePrincipal:${appId}`);
      return { objectId: "should-not-be-called" };
    },
    resolveServicePrincipal: async (appId) => {
      calls.push(`resolveServicePrincipal:${appId}`);
      return { objectId: "should-not-be-called", appRoles: [] };
    },
    grantAppRole: async () => {
      calls.push("grantAppRole");
    },
    grantSitePermission: async (siteId) => {
      calls.push(`grantSitePermission:${siteId}`);
      return { permissionId: "should-not-be-called" };
    },
    listSitePermissions: async (siteId) => {
      calls.push(`listSitePermissions:${siteId}`);
      return [];
    },
    verifyAppAccess: async () => {
      calls.push("verifyAppAccess");
      return { status: 200, body: "{}", appRoles: [] };
    },
    deleteSitePermission: async (siteId, permissionId) => {
      calls.push(`deleteSitePermission:${siteId}:${permissionId}`);
    },
    deleteApplication: async (objectId) => {
      calls.push(`deleteApplication:${objectId}`);
    },
    purgeDeletedApplication: async (objectId) => {
      calls.push(`purgeDeletedApplication:${objectId}`);
    },
  };
  return { graph, calls };
}

describe("runDeleteBootstrap", () => {
  it("finds the grant issuer by name, deletes it and purges it when confirmed", async () => {
    const { graph, calls } = fakeGraph({ objectId: "obj-1", appId: "app-1" });

    const result = await runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer", confirm: true });

    expect(calls).toEqual([
      "findApplicationByDisplayName:Ironwright Grant Issuer",
      "deleteApplication:obj-1",
      "purgeDeletedApplication:obj-1",
    ]);
    expect(result).toEqual({
      kind: "deleted",
      appId: "app-1",
      objectId: "obj-1",
      applicationDeleted: true,
      purgeConfirmed: true,
      // The purge succeeded on its first attempt, so the ladder never slept.
      purgeRetried: false,
    });
  });

  it("creates nothing and touches no site", async () => {
    const { graph, calls } = fakeGraph({ objectId: "obj-1", appId: "app-1" });

    await runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer", confirm: true });

    expect(calls.some((call) => call.startsWith("createApplication"))).toBe(false);
    expect(calls.some((call) => call.startsWith("resolveSite"))).toBe(false);
    expect(calls.some((call) => call.startsWith("grantSitePermission"))).toBe(false);
  });

  it("plans without deleting or purging anything when confirm is absent", async () => {
    const { graph, calls } = fakeGraph({ objectId: "obj-1", appId: "app-1" });

    const outcome = await runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer", confirm: false });

    expect(outcome).toEqual({ kind: "planned", appId: "app-1", objectId: "obj-1" });
    // The exact list, not two not.toContain assertions against named strings:
    // this is the one test that would catch a dry run that mutated anything.
    expect(calls).toEqual(["findApplicationByDisplayName:Ironwright Grant Issuer"]);
  });

  it("reports an already-absent grant issuer as done, not as a failure", async () => {
    const { graph, calls } = fakeGraph(undefined);

    const outcome = await runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer", confirm: true });

    expect(outcome).toEqual({ kind: "already-absent", displayName: "Ironwright Grant Issuer" });
    expect(calls.some((call) => call.startsWith("deleteApplication"))).toBe(false);
  });

  it("reports an already-absent grant issuer as done even on a dry run, since there is nothing to plan", async () => {
    const { graph } = fakeGraph(undefined);

    const outcome = await runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer", confirm: false });

    expect(outcome).toEqual({ kind: "already-absent", displayName: "Ironwright Grant Issuer" });
  });

  it("says nothing was deleted when the grant issuer was already gone, and does not claim a deletion", () => {
    const message = describeDeleteBootstrapSuccess({
      kind: "already-absent",
      displayName: "Ironwright Grant Issuer",
    });

    expect(message).toMatch(/no application named "Ironwright Grant Issuer"/i);
    expect(message).toMatch(/nothing to do/i);
    expect(message).not.toMatch(/Deleted application/);
  });
});

describe("parseArgs delete-bootstrap mode", () => {
  it("defaults deleteBootstrap to false", () => {
    expect(parseArgs([...base, "--site=https://contoso.sharepoint.com/sites/X"]).deleteBootstrap).toBe(false);
  });

  it("sets deleteBootstrap when the flag is present", () => {
    expect(parseArgs([...base, "--delete-bootstrap"]).deleteBootstrap).toBe(true);
  });

  it("does not require a site when deleting the bootstrap application", () => {
    const argv = [...base, "--delete-bootstrap"];
    expect(() => parseArgs(argv)).not.toThrow();
  });

  it("defaults to the grant issuer's name, since it operates on that application", () => {
    expect(parseArgs([...base, "--delete-bootstrap"]).displayName).toBe("Ironwright Grant Issuer");
  });

  it("still honors an explicit --name", () => {
    expect(parseArgs([...base, "--delete-bootstrap", "--name=Contoso Grant Issuer"]).displayName).toBe(
      "Contoso Grant Issuer",
    );
  });

  it("defaults confirm to false, so an invocation with no flag previews rather than acts", () => {
    expect(parseArgs([...base, "--delete-bootstrap"]).confirm).toBe(false);
  });

  it("sets confirm when the flag is present", () => {
    expect(parseArgs([...base, "--delete-bootstrap", "--confirm"]).confirm).toBe(true);
  });
});
