import { describe, expect, it } from "vitest";
import type { SetupGraph } from "../../src/setup/adapter.js";
import { SetupFailedError, runSetup } from "../../src/setup/run.js";

function graphReturning(status: number, body = "{}"): { graph: SetupGraph; granted: boolean[] } {
  const granted: boolean[] = [];
  const graph: SetupGraph = {
    createApplication: async () => ({ objectId: "object-1", appId: "app-1" }),
    addPassword: async () => ({ secretText: "secret-1" }),
    resolveSite: async () => ({ siteId: "site-1" }),
    grantSitePermission: async () => {
      granted.push(true);
    },
    verifyAppAccess: async () => ({ status, body }),
  };
  return { graph, granted };
}

const args = { displayName: "App", siteUrl: "https://contoso.sharepoint.com/sites/Example", write: true };

describe("runSetup failures", () => {
  it("fails with an actionable message when the app is still denied access", async () => {
    const { graph } = graphReturning(403);

    await expect(runSetup(graph, args)).rejects.toThrow(SetupFailedError);
    await expect(runSetup(graph, args)).rejects.toThrow(/\/sites\/\{site-id\}\/permissions/);
  });

  it("does not swallow a failure from the grant call itself", async () => {
    const { graph } = graphReturning(200);
    graph.grantSitePermission = async () => {
      throw new Error("Graph POST /sites/site-1/permissions failed with 403: accessDenied");
    };

    await expect(runSetup(graph, args)).rejects.toThrow(/permissions failed with 403/);
  });

  it("surfaces a credential problem separately from a permission problem", async () => {
    const { graph } = graphReturning(401);

    await expect(runSetup(graph, args)).rejects.toThrow(/client secret/);
  });
});
