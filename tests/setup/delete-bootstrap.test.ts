import { describe, expect, it } from "vitest";
import type { SetupGraph } from "../../src/setup/adapter.js";
import { parseArgs } from "../../src/setup/cli.js";
import { runDeleteBootstrap } from "../../src/setup/run.js";

const base = ["node", "main.js", "--tenant=contoso.onmicrosoft.com"];

function fakeGraph(found: { objectId: string; appId: string } | undefined): {
  graph: SetupGraph;
  calls: string[];
} {
  const calls: string[] = [];
  const graph = {
    findApplicationByDisplayName: async (displayName: string) => {
      calls.push(`findApplicationByDisplayName:${displayName}`);
      return found;
    },
    deleteApplication: async (objectId: string) => {
      calls.push(`deleteApplication:${objectId}`);
    },
  } as unknown as SetupGraph;
  return { graph, calls };
}

describe("runDeleteBootstrap", () => {
  it("finds the grant issuer by name and deletes it", async () => {
    const { graph, calls } = fakeGraph({ objectId: "obj-1", appId: "app-1" });

    const result = await runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer" });

    expect(calls).toEqual([
      "findApplicationByDisplayName:Ironwright Grant Issuer",
      "deleteApplication:obj-1",
    ]);
    expect(result).toEqual({ appId: "app-1", objectId: "obj-1" });
  });

  it("creates nothing and touches no site", async () => {
    const { graph, calls } = fakeGraph({ objectId: "obj-1", appId: "app-1" });

    await runDeleteBootstrap(graph, { displayName: "Ironwright Grant Issuer" });

    expect(calls.some((call) => call.startsWith("createApplication"))).toBe(false);
    expect(calls.some((call) => call.startsWith("resolveSite"))).toBe(false);
    expect(calls.some((call) => call.startsWith("grantSitePermission"))).toBe(false);
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
});
