import { describe, expect, it } from "vitest";
import type { SetupGraph } from "../../src/setup/adapter.js";
import { GraphRequestError } from "../../src/setup/graph-error.js";
import type { SetupResult } from "../../src/setup/run.js";
import { SetupFailedError, runSetup } from "../../src/setup/run.js";
import { SITES_SELECTED_ROLE_CLAIM } from "../../src/setup/steps.js";

interface Fake {
  graph: SetupGraph;
  calls: string[];
  notices: string[];
}

function fakeGraph(overrides: Partial<SetupGraph> = {}): Fake {
  const calls: string[] = [];
  const graph: SetupGraph = {
    resolveSite: async () => ({ siteId: "site-1" }),
    findApplicationByDisplayName: async () => undefined,
    createApplication: async () => {
      calls.push("createApplication");
      return { objectId: "object-1", appId: "app-1" };
    },
    addPassword: async () => ({ secretText: "secret-1" }),
    createServicePrincipal: async () => ({ objectId: "sp-1" }),
    resolveServicePrincipal: async () => ({
      objectId: "graph-sp-1",
      appRoles: [{ id: "role-selected", value: SITES_SELECTED_ROLE_CLAIM }],
    }),
    grantAppRole: async () => {},
    grantSitePermission: async () => ({ permissionId: "permission-1" }),
    verifyAppAccess: async () => ({ status: 200, body: "{}", appRoles: [SITES_SELECTED_ROLE_CLAIM] }),
    deleteSitePermission: async (siteId, permissionId) => {
      calls.push(`deleteSitePermission:${siteId}:${permissionId}`);
    },
    deleteApplication: async (objectId) => {
      calls.push(`deleteApplication:${objectId}`);
    },
    ...overrides,
  };
  return { graph, calls, notices: [] };
}

function run(fake: Fake, extraHooks: Record<string, unknown> = {}): Promise<unknown> {
  return runSetup(
    fake.graph,
    { displayName: "App", siteUrl: "https://contoso.sharepoint.com/sites/Example", write: true },
    { onNotice: (message) => fake.notices.push(message), ...extraHooks },
  );
}

describe("runSetup verification diagnostics", () => {
  it("blames the unconsented application permission when the app token carries no roles", async () => {
    const fake = fakeGraph({ verifyAppAccess: async () => ({ status: 403, body: "{}", appRoles: [] }) });

    await expect(run(fake)).rejects.toThrow(SetupFailedError);
    await expect(run(fake)).rejects.toThrow(/admin consent/i);
  });

  it("does not tell the operator to re-run a command that creates a second registration", async () => {
    const fake = fakeGraph({ verifyAppAccess: async () => ({ status: 403, body: "{}", appRoles: [] }) });

    await expect(run(fake)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("Re-run") }) as Error,
    );
  });

  it("names propagation, not a missing grant, when the application permission is demonstrably consented", async () => {
    const fake = fakeGraph({
      verifyAppAccess: async () => ({ status: 403, body: "{}", appRoles: [SITES_SELECTED_ROLE_CLAIM] }),
    });

    const result = (await run(fake)) as SetupResult;

    if (result.verification.confirmed) throw new Error("expected an unconfirmed verification");
    expect(result.verification.message).toMatch(/propagat/);
  });

  it("surfaces a credential problem separately from a permission problem", async () => {
    const fake = fakeGraph({ verifyAppAccess: async () => ({ status: 401, body: "", appRoles: undefined }) });

    await expect(run(fake)).rejects.toThrow(/client secret/);
  });

  it("does not swallow a failure from the grant call itself", async () => {
    const fake = fakeGraph({
      grantSitePermission: async () => {
        throw new Error("Graph POST /sites/site-1/permissions failed with 403: accessDenied");
      },
    });

    await expect(run(fake)).rejects.toThrow(/permissions failed with 403/);
  });
});

describe("runSetup service principal replication lag", () => {
  it("retries once on Request_ResourceNotFound and completes the run", async () => {
    let attempts = 0;
    const slept: number[] = [];
    const fake = fakeGraph({
      createServicePrincipal: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new GraphRequestError({
            method: "POST",
            path: "/servicePrincipals",
            status: 404,
            body: JSON.stringify({ error: { code: "Request_ResourceNotFound" } }),
          });
        }
        return { objectId: "sp-1" };
      },
    });

    const result = await run(fake, { sleep: async (ms: number) => void slept.push(ms) });

    expect(attempts).toBe(2);
    expect(slept).toEqual([3000]);
    expect(result).toEqual({
      appId: "app-1",
      objectId: "object-1",
      secret: "secret-1",
      siteId: "site-1",
      verification: { confirmed: true },
    });
  });

  it("does not retry a response that merely quotes the code somewhere in its body", async () => {
    // Nine seconds of waiting is the cost of matching on the message text
    // rather than on Graph's own code field, and the message carries the whole
    // response body.
    let attempts = 0;
    const fake = fakeGraph({
      createServicePrincipal: async () => {
        attempts += 1;
        throw new GraphRequestError({
          method: "POST",
          path: "/servicePrincipals",
          status: 403,
          body: JSON.stringify({
            error: { code: "Authorization_RequestDenied", message: "not Request_ResourceNotFound" },
          }),
        });
      },
    });

    await expect(run(fake, { sleep: async () => {} })).rejects.toThrow(/Authorization_RequestDenied/);
    expect(attempts).toBe(1);
  });

  it("does not retry a failure that is not the replication-lag error code", async () => {
    const fake = fakeGraph({
      createServicePrincipal: async () => {
        throw new Error("Graph POST /servicePrincipals failed with 403: Authorization_RequestDenied");
      },
    });

    await expect(run(fake, { sleep: async () => {} })).rejects.toThrow(/Authorization_RequestDenied/);
  });
});

describe("runSetup rollback", () => {
  it("removes the site permission and the credentialed registration when verification fails", async () => {
    const fake = fakeGraph({ verifyAppAccess: async () => ({ status: 403, body: "{}", appRoles: [] }) });

    await expect(run(fake)).rejects.toThrow(SetupFailedError);
    expect(fake.calls).toEqual([
      "createApplication",
      "deleteSitePermission:site-1:permission-1",
      "deleteApplication:object-1",
    ]);
  });

  it("removes the registration without inventing a site permission that was never granted", async () => {
    const fake = fakeGraph({
      grantAppRole: async () => {
        throw new Error("Graph POST appRoleAssignedTo failed with 403: Authorization_RequestDenied");
      },
    });

    await expect(run(fake)).rejects.toThrow(/Authorization_RequestDenied/);
    expect(fake.calls).toEqual(["createApplication", "deleteApplication:object-1"]);
  });

  it("attempts no rollback when nothing was created yet", async () => {
    const fake = fakeGraph({
      resolveSite: async () => {
        throw new Error("Graph GET /sites/contoso.sharepoint.com:/sites/Example failed with 404: itemNotFound");
      },
    });

    await expect(run(fake)).rejects.toThrow(/itemNotFound/);
    expect(fake.calls).toEqual([]);
  });

  it("attempts no rollback when Graph's service principal cannot be resolved", async () => {
    const fake = fakeGraph({
      resolveServicePrincipal: async () => {
        throw new Error("Graph GET /servicePrincipals(appId='...') failed with 404: Request_ResourceNotFound");
      },
    });

    await expect(run(fake)).rejects.toThrow(/Request_ResourceNotFound/);
    expect(fake.calls).toEqual([]);
  });

  it("attempts no rollback when Graph does not publish the requested app role", async () => {
    const fake = fakeGraph({
      resolveServicePrincipal: async () => ({ objectId: "graph-sp-1", appRoles: [] }),
    });

    await expect(run(fake)).rejects.toThrow(/Sites\.Selected/);
    expect(fake.calls).toEqual([]);
  });

  it("does not issue a delete it cannot address when the permission id is unknown", async () => {
    // The id is the last path segment of DELETE /sites/{id}/permissions/{id}.
    // Sending that request without one cannot target the permission Graph may
    // have created, so it is not a cleanup attempt at all; it only looked like
    // one because Graph rejected it and the manual-check notice was emitted
    // from the catch.
    const fake = fakeGraph({
      grantSitePermission: async () => {
        throw new Error("permission response had no id");
      },
    });

    await expect(run(fake)).rejects.toThrow(/no id/);
    expect(fake.calls.some((call) => call.startsWith("deleteSitePermission"))).toBe(false);
  });

  it("reports a possibly orphaned grant whenever the permission id is unknown", async () => {
    const fake = fakeGraph({
      grantSitePermission: async () => {
        throw new Error("permission response had no id");
      },
    });

    await expect(run(fake)).rejects.toThrow(/no id/);
    // Unconditional rather than emitted from a failed delete's catch: a
    // possibly orphaned grant on a customer's site has to be reported even
    // when the rest of the rollback succeeds.
    const notices = fake.notices.join("\n");
    expect(notices).toMatch(/not known whether/i);
    expect(notices).toContain("GET /sites/site-1/permissions");
  });

  it("tolerates a rollback delete failing for a permission whose id is known, reporting it rather than masking the original error", async () => {
    const fake = fakeGraph({
      verifyAppAccess: async () => ({ status: 403, body: "{}", appRoles: [] }),
      deleteSitePermission: async () => {
        throw new Error("Graph DELETE /sites/site-1/permissions/permission-1 failed with 404: itemNotFound");
      },
    });

    let caught: unknown;
    try {
      await run(fake);
    } catch (error) {
      caught = error;
    }

    // The original failure survives even though the compensating delete this
    // command attempted also failed: whatever went wrong with the run is still
    // the more useful thing for the operator to see, not the secondary failure
    // from trying to clean it up.
    expect(caught).toBeInstanceOf(SetupFailedError);
    expect((caught as Error).message).not.toMatch(/itemNotFound/);
    expect(fake.notices.join("\n")).toContain("itemNotFound");
    expect(fake.notices.join("\n")).toContain("DELETE /sites/site-1/permissions/permission-1");
  });

  it("reports the registration for manual deletion when rollback itself fails, without masking the cause", async () => {
    const fake = fakeGraph({
      verifyAppAccess: async () => ({ status: 403, body: "{}", appRoles: [] }),
      deleteApplication: async () => {
        throw new Error("Graph DELETE /applications/object-1 failed with 403: Authorization_RequestDenied");
      },
    });

    await expect(run(fake)).rejects.toThrow(SetupFailedError);
    expect(fake.notices.join("\n")).toContain("app-1");
    expect(fake.notices.join("\n")).toMatch(/delete it manually/i);
  });

  it("confirms the rollback when it succeeds, so no credential is assumed to be loose", async () => {
    const fake = fakeGraph({ verifyAppAccess: async () => ({ status: 403, body: "{}", appRoles: [] }) });

    await expect(run(fake)).rejects.toThrow(SetupFailedError);
    expect(fake.notices.join("\n")).toMatch(/rolled back/i);
  });
});

describe("runSetup verification failure outcomes match what the run actually did", () => {
  // The defect these pin: every remedy used to tell the operator to act on
  // objects the run had already deleted, and the whole-string pins in
  // steps.errors.test.ts could not catch that because nothing asserted the
  // message alongside the rollback behavior that produced it.
  const cases: {
    name: string;
    appRoles: string[] | undefined;
    keepsApplication: boolean;
    claims: RegExp;
    forbids: RegExp;
  }[] = [
    {
      name: "a token that carries the role",
      appRoles: [SITES_SELECTED_ROLE_CLAIM],
      keepsApplication: true,
      claims: /kept, not rolled back/,
      forbids: /rolled back everything it created/,
    },
    {
      name: "a token that carries no roles",
      appRoles: [],
      keepsApplication: false,
      claims: /rolled back everything it created/,
      forbids: /kept, not rolled back/,
    },
    {
      name: "a token that could not be read",
      appRoles: undefined,
      keepsApplication: false,
      claims: /rolled back everything it created/,
      forbids: /kept, not rolled back/,
    },
  ];

  it.each(cases)("$name", async ({ appRoles, keepsApplication, claims, forbids }) => {
    const fake = fakeGraph({ verifyAppAccess: async () => ({ status: 403, body: "{}", appRoles }) });

    let message: string;
    if (keepsApplication) {
      const result = (await run(fake)) as SetupResult;
      if (result.verification.confirmed) throw new Error("expected an unconfirmed verification");
      message = result.verification.message;
    } else {
      let caught: unknown;
      try {
        await run(fake);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SetupFailedError);
      message = (caught as Error).message;
    }

    const deleted = fake.calls.filter((call) => call.startsWith("delete"));
    expect(deleted.length > 0).toBe(!keepsApplication);
    expect(message).toMatch(claims);
    expect(message).not.toMatch(forbids);
  });

  it("returns the credentials, not an error, when the role is present and access is unconfirmed", async () => {
    const fake = fakeGraph({
      verifyAppAccess: async () => ({ status: 403, body: "{}", appRoles: [SITES_SELECTED_ROLE_CLAIM] }),
    });

    const result = (await run(fake)) as SetupResult;

    expect(result.appId).toBe("app-1");
    expect(result.secret).toBe("secret-1");
    expect(result.siteId).toBe("site-1");
    expect(fake.calls).toEqual(["createApplication"]);
  });

  it("reports a confirmed verification on a successful run, so the caller can tell the two apart", async () => {
    const fake = fakeGraph();

    const result = (await run(fake)) as SetupResult;

    expect(result.verification).toEqual({ confirmed: true });
  });
});
