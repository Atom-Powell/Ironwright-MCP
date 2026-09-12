import { describe, expect, it } from "vitest";
import type { SetupGraph } from "../../src/setup/adapter.js";
import { runCreateBootstrap } from "../../src/setup/run.js";
import { SITES_FULL_CONTROL_ROLE_CLAIM, assertBootstrapToken } from "../../src/setup/steps.js";

function fakeAccessToken(payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `header.${encoded}.signature`;
}

describe("assertBootstrapToken", () => {
  it("rejects a token that cannot be read", () => {
    expect(() => assertBootstrapToken("not-a-jwt")).toThrow(/could not be read/);
  });

  it("rejects a token whose roles omit Sites.FullControl.All", () => {
    expect(() => assertBootstrapToken(fakeAccessToken({ roles: ["Sites.Selected"] }))).toThrow(
      /Sites\.FullControl\.All/,
    );
  });

  it("accepts a token that carries Sites.FullControl.All", () => {
    expect(() => assertBootstrapToken(fakeAccessToken({ roles: [SITES_FULL_CONTROL_ROLE_CLAIM] }))).not.toThrow();
  });
});

function fakeGraph(overrides: Partial<SetupGraph> = {}): { graph: SetupGraph; calls: string[] } {
  const calls: string[] = [];
  const graph: SetupGraph = {
    resolveSite: async () => ({ siteId: "should-not-be-called" }),
    findApplicationByDisplayName: async () => undefined,
    createApplication: async () => {
      calls.push("createApplication");
      return { objectId: "obj-1", appId: "app-1" };
    },
    addPassword: async () => ({ secretText: "secret-1" }),
    createServicePrincipal: async () => ({ objectId: "sp-1" }),
    resolveServicePrincipal: async () => ({
      objectId: "graph-sp",
      appRoles: [{ id: "role-full", value: SITES_FULL_CONTROL_ROLE_CLAIM }],
    }),
    grantAppRole: async () => {},
    grantSitePermission: async () => ({ permissionId: "p" }),
    verifyAppAccess: async () => ({ status: 200, body: "{}", appRoles: [] }),
    deleteSitePermission: async () => {},
    deleteApplication: async (objectId) => {
      calls.push(`deleteApplication:${objectId}`);
    },
    ...overrides,
  };
  return { graph, calls };
}

describe("runCreateBootstrap rollback", () => {
  it("rolls the application back when granting the app role fails, and the original error survives", async () => {
    const { graph, calls } = fakeGraph({
      grantAppRole: async () => {
        throw new Error("Graph POST appRoleAssignedTo failed with 403: Authorization_RequestDenied");
      },
    });

    await expect(runCreateBootstrap(graph, { displayName: "Ironwright Grant Issuer" })).rejects.toThrow(
      /Authorization_RequestDenied/,
    );
    expect(calls).toEqual(["createApplication", "deleteApplication:obj-1"]);
  });

  it("attempts no rollback when Graph's service principal cannot be resolved", async () => {
    const { graph, calls } = fakeGraph({
      resolveServicePrincipal: async () => {
        throw new Error("Graph GET /servicePrincipals(appId='...') failed with 404: Request_ResourceNotFound");
      },
    });

    await expect(runCreateBootstrap(graph, { displayName: "Ironwright Grant Issuer" })).rejects.toThrow(
      /Request_ResourceNotFound/,
    );
    expect(calls).toEqual([]);
  });

  it("attempts no rollback when Graph does not publish the requested app role", async () => {
    const { graph, calls } = fakeGraph({
      resolveServicePrincipal: async () => ({ objectId: "graph-sp", appRoles: [] }),
    });

    await expect(runCreateBootstrap(graph, { displayName: "Ironwright Grant Issuer" })).rejects.toThrow(
      /Sites\.FullControl\.All/,
    );
    expect(calls).toEqual([]);
  });
});

describe("runCreateBootstrap duplicate guard", () => {
  it("refuses to create a second grant issuer when one already carries that name", async () => {
    const { graph, calls } = fakeGraph({
      findApplicationByDisplayName: async () => ({ objectId: "existing-obj", appId: "existing-app" }),
    });

    await expect(runCreateBootstrap(graph, { displayName: "Ironwright Grant Issuer" })).rejects.toThrow(
      /already exists/i,
    );
    expect(calls).toEqual([]);
  });

  it("names the existing application and what to do instead of creating another", async () => {
    const { graph } = fakeGraph({
      findApplicationByDisplayName: async () => ({ objectId: "existing-obj", appId: "existing-app" }),
    });

    let caught: unknown;
    try {
      await runCreateBootstrap(graph, { displayName: "Ironwright Grant Issuer" });
    } catch (error) {
      caught = error;
    }

    const message = (caught as Error).message;
    expect(message).toContain("existing-app");
    expect(message).toContain("IW_BOOTSTRAP_CLIENT_ID");
    expect(message).toMatch(/--name/);
  });

  it("covers the case the preflight's own remedy sends the operator here for: an unconsented grant issuer", async () => {
    // steps.ts's assertBootstrapToken tells an operator whose bootstrap token
    // lacks Sites.FullControl.All to re-run with --create-bootstrap. That
    // always hits this guard, because the unconsented application is the one
    // this command itself created. Without an unconsented-permission escape
    // hatch here, alongside the unrecorded/expired-secret one, that prescribed
    // next step would be refused with no route past it.
    const { graph } = fakeGraph({
      findApplicationByDisplayName: async () => ({ objectId: "existing-obj", appId: "existing-app" }),
    });

    let caught: unknown;
    try {
      await runCreateBootstrap(graph, { displayName: "Ironwright Grant Issuer" });
    } catch (error) {
      caught = error;
    }

    const message = (caught as Error).message;
    expect(message).toMatch(/consented/i);
    expect(message).toContain("Sites.FullControl.All");
    expect(message).toMatch(/delete the existing application and run this again/i);
  });
});

