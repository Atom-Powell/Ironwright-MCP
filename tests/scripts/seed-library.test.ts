import { describe, expect, it } from "vitest";
import {
  buildSeedTree,
  createSeedGraphClient,
  DEFAULT_CLIENT_COUNT,
  estimateGraphRequests,
  executeSeed,
  formatDryRunReport,
  formatExecutionReport,
  loadSeedProfile,
  parseSeedArguments,
  runSeed,
  splitPath,
  substituteTokens,
  type SeedGraphClient,
  type SeedProfileInput,
} from "../../scripts/seed-library.js";

function exampleProfile(): SeedProfileInput {
  // Mirrors examples/profiles/example.json's taxonomy, naming, and
  // deliverables exactly, since the spec that drove this script names that
  // file as the token vocabulary this seeder has to support.
  return {
    identity: { siteUrl: "https://contoso.sharepoint.com/sites/Example", library: "Compliance Reports" },
    taxonomy: { segments: ["{year}", "{client}", "{month:02}-{monthName}"] },
    naming: { template: "{year}-{month:02}_{client}_{deliverable}.xlsx" },
    deliverables: [
      { token: "MonthlyTraining", cadence: "monthly" },
      { token: "QuarterlyPhishing", cadence: "quarterly" },
    ],
  };
}

function exampleProfileRaw(): unknown {
  return exampleProfile();
}

describe("substituteTokens", () => {
  it("replaces every supported token in one template", () => {
    expect(
      substituteTokens("{year}-{month:02}_{client}_{deliverable}", {
        year: "2026",
        client: "Client01",
        monthNumber: "02",
        monthName: "February",
        deliverable: "MonthlyTraining",
      }),
    ).toBe("2026-02_Client01_MonthlyTraining");
  });

  it("replaces {monthName} on its own", () => {
    expect(substituteTokens("{month:02}-{monthName}", { year: "2026", monthNumber: "01", monthName: "January" })).toBe(
      "01-January",
    );
  });

  it("leaves a template with no tokens untouched", () => {
    expect(substituteTokens("Compliance Reports", { year: "2026" })).toBe("Compliance Reports");
  });
});

describe("splitPath", () => {
  it("splits a nested path into its parent and its name", () => {
    expect(splitPath("2026/Client01/01-January")).toEqual({ parentPath: "2026/Client01", name: "01-January" });
  });

  it("treats a path with no slash as a root-level name", () => {
    expect(splitPath("2026")).toEqual({ parentPath: "", name: "2026" });
  });
});

describe("buildSeedTree", () => {
  it("produces 157 folders and 192 files for the documented default shape", () => {
    const tree = buildSeedTree(exampleProfile(), { clientCount: DEFAULT_CLIENT_COUNT, year: 2026, includeQuarterly: true });

    expect(tree.folderPaths).toHaveLength(157);
    expect(tree.filePaths).toHaveLength(192);
  });

  it("builds one year folder, one folder per client, and one per client-month", () => {
    const tree = buildSeedTree(exampleProfile(), { clientCount: 2, year: 2026, includeQuarterly: false });

    expect(tree.folderPaths).toContain("2026");
    expect(tree.folderPaths).toContain("2026/Client01");
    expect(tree.folderPaths).toContain("2026/Client02");
    expect(tree.folderPaths).toContain("2026/Client01/01-January");
    expect(tree.folderPaths).toContain("2026/Client02/12-December");
    // 1 year folder + 2 client folders + 2*12 month folders.
    expect(tree.folderPaths).toHaveLength(1 + 2 + 24);
  });

  it("lists every folder exactly once even though clients and months share ancestors", () => {
    const tree = buildSeedTree(exampleProfile(), { clientCount: 3, year: 2026, includeQuarterly: false });

    expect(new Set(tree.folderPaths).size).toBe(tree.folderPaths.length);
  });

  it("orders every folder after its own parent", () => {
    const tree = buildSeedTree(exampleProfile(), { clientCount: 2, year: 2026, includeQuarterly: true });

    for (const path of tree.folderPaths) {
      const lastSlash = path.lastIndexOf("/");
      if (lastSlash === -1) continue;
      const parent = path.slice(0, lastSlash);
      expect(tree.folderPaths.indexOf(parent)).toBeLessThan(tree.folderPaths.indexOf(path));
    }
  });

  it("places the monthly file under the client's month folder, named from the template", () => {
    const tree = buildSeedTree(exampleProfile(), { clientCount: 1, year: 2026, includeQuarterly: false });

    expect(tree.filePaths).toContain("2026/Client01/01-January/2026-01_Client01_MonthlyTraining.xlsx");
  });

  it("adds a quarterly file only in the last month of each quarter when requested", () => {
    const tree = buildSeedTree(exampleProfile(), { clientCount: 1, year: 2026, includeQuarterly: true });

    expect(tree.filePaths).toContain("2026/Client01/03-March/2026-03_Client01_QuarterlyPhishing.xlsx");
    expect(tree.filePaths).toContain("2026/Client01/06-June/2026-06_Client01_QuarterlyPhishing.xlsx");
    expect(tree.filePaths.some((path) => path.includes("01-January") && path.includes("QuarterlyPhishing"))).toBe(
      false,
    );
  });

  it("omits every quarterly file when includeQuarterly is false", () => {
    const tree = buildSeedTree(exampleProfile(), { clientCount: 1, year: 2026, includeQuarterly: false });

    expect(tree.filePaths.some((path) => path.includes("QuarterlyPhishing"))).toBe(false);
    expect(tree.filePaths).toHaveLength(12);
  });

  it("builds a tree of one client's worth for clientCount 1", () => {
    const tree = buildSeedTree(exampleProfile(), { clientCount: 1, year: 2026, includeQuarterly: false });

    expect(tree.folderPaths).toHaveLength(1 + 1 + 12);
  });
});

describe("estimateGraphRequests", () => {
  it("is exactly two more than the tree's own folder and file counts", () => {
    const tree = buildSeedTree(exampleProfile(), { clientCount: 2, year: 2026, includeQuarterly: true });

    expect(estimateGraphRequests(tree)).toBe(2 + tree.folderPaths.length + tree.filePaths.length);
  });
});

describe("parseSeedArguments", () => {
  const now = () => new Date("2026-06-15T00:00:00Z");

  it("requires --profile", () => {
    expect(() => parseSeedArguments([], { now })).toThrow(/--profile/);
  });

  it("fills in the documented defaults", () => {
    expect(parseSeedArguments(["--profile", "p.json"], { now })).toEqual({
      profilePath: "p.json",
      clientCount: DEFAULT_CLIENT_COUNT,
      year: 2026,
      includeQuarterly: true,
      confirm: false,
    });
  });

  it("reads --clients, --year, --no-quarterly, and --confirm", () => {
    expect(
      parseSeedArguments(["--profile", "p.json", "--clients", "3", "--year", "2027", "--no-quarterly", "--confirm"], {
        now,
      }),
    ).toEqual({ profilePath: "p.json", clientCount: 3, year: 2027, includeQuarterly: false, confirm: true });
  });
});

describe("formatDryRunReport", () => {
  it("states the tree's own counts and derives the estimate from them", () => {
    const tree = buildSeedTree(exampleProfile(), { clientCount: 1, year: 2026, includeQuarterly: false });
    const lines = formatDryRunReport(tree, {
      profilePath: "p.json",
      clientCount: 1,
      year: 2026,
      includeQuarterly: false,
      confirm: false,
    }).join("\n");

    expect(lines).toMatch(/Dry run/);
    expect(lines).toMatch(new RegExp(`Folders that would be created: ${tree.folderPaths.length}`));
    expect(lines).toMatch(new RegExp(`Files that would be created: ${tree.filePaths.length}`));
    expect(lines).toMatch(new RegExp(`Estimated Graph requests[^:]*: ${estimateGraphRequests(tree)}`));
    expect(lines).toMatch(/estimate/i);
  });
});

describe("formatExecutionReport", () => {
  it("reports the counts and requests it was given", () => {
    const lines = formatExecutionReport({
      driveId: "drive-1",
      foldersProcessed: 5,
      filesProcessed: 7,
      graphRequests: 14,
      elapsedMs: 250,
    }).join("\n");

    expect(lines).toMatch(/drive-1/);
    expect(lines).toMatch(/Folders processed: 5/);
    expect(lines).toMatch(/Files processed: 7/);
    expect(lines).toMatch(/Graph requests issued: 14/);
    expect(lines).toMatch(/250ms/);
  });
});

describe("loadSeedProfile", () => {
  it("accepts the fields this script needs from a profile-shaped object", () => {
    expect(loadSeedProfile(exampleProfileRaw())).toEqual(exampleProfile());
  });
});

function fakeSeedClient(driveName: string): { client: SeedGraphClient; calls: string[] } {
  const calls: string[] = [];
  let requestCount = 0;
  const client: SeedGraphClient = {
    requests: () => requestCount,
    get: async <T,>(path: string): Promise<T> => {
      requestCount += 1;
      calls.push(`GET:${path}`);
      if (path.includes("/drives")) {
        return { value: [{ id: "drive-1", name: driveName }] } as T;
      }
      return { id: "site-1" } as T;
    },
    createFolder: async (_driveId, parentPath, name) => {
      requestCount += 1;
      calls.push(`FOLDER:${parentPath}/${name}`);
      return { status: 201 };
    },
    createFile: async (_driveId, parentPath, name) => {
      requestCount += 1;
      calls.push(`FILE:${parentPath}/${name}`);
      return { status: 201 };
    },
    post: async () => { throw new Error("this fake does not implement post"); },
  };
  return { client, calls };
}

describe("executeSeed", () => {
  it("resolves the drive, creates every folder before any file, and counts every request", async () => {
    const profile = exampleProfile();
    const tree = buildSeedTree(profile, { clientCount: 1, year: 2026, includeQuarterly: false });
    const { client, calls } = fakeSeedClient(profile.identity.library);

    const result = await executeSeed(client, profile.identity, tree);

    expect(result.driveId).toBe("drive-1");
    expect(result.foldersProcessed).toBe(tree.folderPaths.length);
    expect(result.filesProcessed).toBe(tree.filePaths.length);
    expect(result.graphRequests).toBe(2 + tree.folderPaths.length + tree.filePaths.length);
    expect(typeof result.elapsedMs).toBe("number");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);

    const lastFolderCall = calls.findLastIndex((call) => call.startsWith("FOLDER:"));
    const firstFileCall = calls.findIndex((call) => call.startsWith("FILE:"));
    expect(lastFolderCall).toBeLessThan(firstFileCall);
    expect(calls[0]).toMatch(/^GET:/);
  });
});

describe("runSeed", () => {
  it("dry run reads the profile, builds the tree, and never calls createGraphClient", async () => {
    const logs: string[] = [];
    const readCalls: string[] = [];

    await runSeed(["--profile", "p.json"], {
      readProfileFile: async (path) => {
        readCalls.push(path);
        return exampleProfileRaw();
      },
      createGraphClient: () => {
        throw new Error("createGraphClient must not be called on a dry run");
      },
      now: () => new Date("2026-01-01T00:00:00Z"),
      log: (line) => logs.push(line),
    });

    expect(readCalls).toEqual(["p.json"]);
    expect(logs.some((line) => /Dry run/.test(line))).toBe(true);
    expect(logs.some((line) => /Folders that would be created: 157/.test(line))).toBe(true);
  });

  it("confirmed run creates the tree through the injected graph client", async () => {
    const logs: string[] = [];
    const { client } = fakeSeedClient("Compliance Reports");

    await runSeed(["--profile", "p.json", "--clients", "1", "--no-quarterly", "--confirm"], {
      readProfileFile: async () => exampleProfileRaw(),
      createGraphClient: () => client,
      now: () => new Date("2026-01-01T00:00:00Z"),
      log: (line) => logs.push(line),
    });

    expect(logs.some((line) => /Seed complete/.test(line))).toBe(true);
    expect(logs.some((line) => /Folders processed: 14/.test(line))).toBe(true);
    expect(logs.some((line) => /Files processed: 12/.test(line))).toBe(true);
  });
});

describe("createSeedGraphClient", () => {
  const TOKEN = { getToken: async () => "token-1" };

  it("creates a folder with fail conflict behavior, which cannot silently overwrite what is already there", async () => {
    const seen: Request[] = [];
    const client = createSeedGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        seen.push(new Request(input as string, init));
        return new Response("{}", { status: 201 });
      }) as typeof fetch,
    });

    await client.createFolder("drive-1", "2026", "Client01");

    const request = seen[0];
    expect(request?.url).toBe("https://graph.microsoft.com/v1.0/drives/drive-1/root:/2026:/children");
    expect(request?.method).toBe("POST");
    const body = JSON.parse(await request!.text()) as Record<string, unknown>;
    expect(body["@microsoft.graph.conflictBehavior"]).toBe("fail");
    expect(client.requests()).toBe(1);
  });

  it("tolerates a 409 nameAlreadyExists on folder creation, which is what a re-run against an existing folder returns", async () => {
    const client = createSeedGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { code: "nameAlreadyExists", message: "already there" } }), {
          status: 409,
        })) as typeof fetch,
    });

    await expect(client.createFolder("drive-1", "2026", "Client01")).resolves.toEqual({ status: 409 });
    // Still counted: the request was issued either way, which is what keeps
    // the dry-run estimate honest about a re-run costing the same requests.
    expect(client.requests()).toBe(1);
  });

  it("creates a file with a PUT to its content endpoint carrying the conflict behavior", async () => {
    const seen: Request[] = [];
    const client = createSeedGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        seen.push(new Request(input as string, init));
        return new Response("{}", { status: 201 });
      }) as typeof fetch,
    });

    await client.createFile("drive-1", "2026/Client01", "file.xlsx", "placeholder");

    const request = seen[0];
    expect(request?.url).toBe(
      "https://graph.microsoft.com/v1.0/drives/drive-1/root:/2026/Client01/file.xlsx:/content?@microsoft.graph.conflictBehavior=replace",
    );
    expect(request?.method).toBe("PUT");
    expect(await request!.text()).toBe("placeholder");
  });

  it("issues a bearer-token GET and counts it", async () => {
    const seen: Request[] = [];
    const client = createSeedGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        seen.push(new Request(input as string, init));
        return new Response(JSON.stringify({ id: "site-1" }), { status: 200 });
      }) as typeof fetch,
    });

    const value = await client.get<{ id: string }>("/sites/contoso.sharepoint.com:/sites/Example");

    expect(value.id).toBe("site-1");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer token-1");
    expect(client.requests()).toBe(1);
  });
});
