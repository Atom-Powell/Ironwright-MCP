import { describe, expect, it } from "vitest";
import {
  ABSENT_CLIENT,
  buildSeedPlan,
  buildSeedTree,
  createSeedGraphClient,
  DEFAULT_CLIENT_COUNT,
  estimateGraphRequests,
  executeSeed,
  formatDryRunReport,
  formatExecutionReport,
  loadSeedProfile,
  MISNAMED_FILE_CLIENT,
  MISNAMED_FILE_MONTH,
  MISSING_FILE_CLIENT,
  MISSING_FILE_MONTH,
  parseSeedArguments,
  runSeed,
  splitPath,
  substituteTokens,
  type SeedGraphClient,
  type SeedProfileInput,
} from "../../scripts/seed-library.js";
import { exampleSeedProfile } from "./seed/fixtures.js";

function exampleProfileRaw(): unknown {
  return exampleSeedProfile();
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
    const tree = buildSeedTree(exampleSeedProfile(), { clientCount: DEFAULT_CLIENT_COUNT, year: 2026, includeQuarterly: true, throughMonth: 12 });

    expect(tree.folderPaths).toHaveLength(157);
    expect(tree.filePaths).toHaveLength(192);
  });

  it("builds one year folder, one folder per client, and one per client-month", () => {
    const tree = buildSeedTree(exampleSeedProfile(), { clientCount: 2, year: 2026, includeQuarterly: false, throughMonth: 12 });

    expect(tree.folderPaths).toContain("2026");
    expect(tree.folderPaths).toContain("2026/Client01");
    expect(tree.folderPaths).toContain("2026/Client02");
    expect(tree.folderPaths).toContain("2026/Client01/01-January");
    expect(tree.folderPaths).toContain("2026/Client02/12-December");
    // 1 year folder + 2 client folders + 2*12 month folders.
    expect(tree.folderPaths).toHaveLength(1 + 2 + 24);
  });

  it("lists every folder exactly once even though clients and months share ancestors", () => {
    const tree = buildSeedTree(exampleSeedProfile(), { clientCount: 3, year: 2026, includeQuarterly: false, throughMonth: 12 });

    expect(new Set(tree.folderPaths).size).toBe(tree.folderPaths.length);
  });

  it("orders every folder after its own parent", () => {
    const tree = buildSeedTree(exampleSeedProfile(), { clientCount: 2, year: 2026, includeQuarterly: true, throughMonth: 12 });

    for (const path of tree.folderPaths) {
      const lastSlash = path.lastIndexOf("/");
      if (lastSlash === -1) continue;
      const parent = path.slice(0, lastSlash);
      expect(tree.folderPaths.indexOf(parent)).toBeLessThan(tree.folderPaths.indexOf(path));
    }
  });

  it("places the monthly file under the client's month folder, named from the template", () => {
    const tree = buildSeedTree(exampleSeedProfile(), { clientCount: 1, year: 2026, includeQuarterly: false, throughMonth: 12 });

    expect(tree.filePaths).toContain("2026/Client01/01-January/2026-01_Client01_MonthlyTraining.xlsx");
  });

  it("adds a quarterly file only in the last month of each quarter when requested", () => {
    const tree = buildSeedTree(exampleSeedProfile(), { clientCount: 1, year: 2026, includeQuarterly: true, throughMonth: 12 });

    expect(tree.filePaths).toContain("2026/Client01/03-March/2026-03_Client01_QuarterlyPhishing.xlsx");
    expect(tree.filePaths).toContain("2026/Client01/06-June/2026-06_Client01_QuarterlyPhishing.xlsx");
    expect(tree.filePaths.some((path) => path.includes("01-January") && path.includes("QuarterlyPhishing"))).toBe(
      false,
    );
  });

  it("omits every quarterly file when includeQuarterly is false", () => {
    const tree = buildSeedTree(exampleSeedProfile(), { clientCount: 1, year: 2026, includeQuarterly: false, throughMonth: 12 });

    expect(tree.filePaths.some((path) => path.includes("QuarterlyPhishing"))).toBe(false);
    expect(tree.filePaths).toHaveLength(12);
  });

  it("builds a tree of one client's worth for clientCount 1", () => {
    const tree = buildSeedTree(exampleSeedProfile(), { clientCount: 1, year: 2026, includeQuarterly: false, throughMonth: 12 });

    expect(tree.folderPaths).toHaveLength(1 + 1 + 12);
  });
});

describe("estimateGraphRequests", () => {
  it("is exactly two more than the tree's own folder and file counts", () => {
    const tree = buildSeedTree(exampleSeedProfile(), { clientCount: 2, year: 2026, includeQuarterly: true, throughMonth: 12 });

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
      throughMonth: 6,
    });
  });

  it("reads --clients, --year, --no-quarterly, and --confirm", () => {
    expect(
      parseSeedArguments(["--profile", "p.json", "--clients", "3", "--year", "2027", "--no-quarterly", "--confirm"], {
        now,
      }),
    ).toEqual({
      profilePath: "p.json",
      clientCount: 3,
      year: 2027,
      includeQuarterly: false,
      confirm: true,
      throughMonth: 12,
    });
  });
});

describe("parseSeedArguments throughMonth", () => {
  // "--profile p.json" rather than "--profile=p.json": parseSeedArguments only
  // ever matches a flag by exact equality and reads the next argv entry as its
  // value (see the "hasValue" guard above), the same space-separated shape
  // every other test in this file uses. An "=" form is not a syntax this
  // parser accepts.
  it("caps at the current month when the seeded year is the current year", () => {
    const args = parseSeedArguments(["--profile", "p.json"], { now: () => new Date("2026-09-15T00:00:00Z") });
    expect(args.year).toBe(2026);
    expect(args.throughMonth).toBe(9);
  });

  it("writes all twelve months for a past year", () => {
    const args = parseSeedArguments(["--profile", "p.json", "--year", "2025"], {
      now: () => new Date("2026-09-15T00:00:00Z"),
    });
    expect(args.throughMonth).toBe(12);
  });
});

describe("formatDryRunReport", () => {
  it("states the tree's own counts and derives the estimate from them", () => {
    const tree = buildSeedTree(exampleSeedProfile(), { clientCount: 1, year: 2026, includeQuarterly: false, throughMonth: 12 });
    const lines = formatDryRunReport(tree, {
      profilePath: "p.json",
      clientCount: 1,
      year: 2026,
      includeQuarterly: false,
      confirm: false,
      throughMonth: 12,
    }).join("\n");

    expect(lines).toMatch(/Dry run/);
    expect(lines).toMatch(new RegExp(`Folders that would be created: ${tree.folderPaths.length}`));
    expect(lines).toMatch(new RegExp(`Files that would be created: ${tree.filePaths.length}`));
    expect(lines).toMatch(new RegExp(`Estimated Graph requests[^:]*: ${estimateGraphRequests(tree)}`));
    expect(lines).toMatch(/estimate/i);
  });
});

describe("buildSeedPlan", () => {
  const options = { clientCount: 12, year: 2026, includeQuarterly: true, throughMonth: 9 };

  it("stops the tree at throughMonth", () => {
    const plan = buildSeedPlan(exampleSeedProfile(), options);
    expect(plan.tree.filePaths.some((path) => path.includes("10-October"))).toBe(false);
    expect(plan.tree.filePaths.some((path) => path.includes("09-September"))).toBe(true);
  });

  it("writes no folder for the absent client but lists it in the workbook", () => {
    const plan = buildSeedPlan(exampleSeedProfile(), options);
    expect(plan.clients).not.toContain(ABSENT_CLIENT);
    expect(plan.workbookClients).toContain(ABSENT_CLIENT);
    expect(plan.tree.folderPaths.some((path) => path.includes(ABSENT_CLIENT))).toBe(false);
  });

  it("omits exactly one monthly file, for the planted client and month", () => {
    const plan = buildSeedPlan(exampleSeedProfile(), options);
    const omitted = `2026/${MISSING_FILE_CLIENT}/01-January/2026-01_${MISSING_FILE_CLIENT}_MonthlyTraining.xlsx`;
    expect(plan.tree.filePaths).not.toContain(omitted);
    // The folder still exists: a missing artifact and a missing client are
    // different findings, and this row is meant to produce the first.
    expect(plan.tree.folderPaths).toContain(`2026/${MISSING_FILE_CLIENT}/01-January`);
    expect(MISSING_FILE_MONTH).toBe(1);
  });

  it("writes the planted misnamed file in the vendor-token shape", () => {
    const plan = buildSeedPlan(exampleSeedProfile(), options);
    const compliant = `2026/${MISNAMED_FILE_CLIENT}/01-January/2026-01_${MISNAMED_FILE_CLIENT}_MonthlyTraining.xlsx`;
    const misnamed = `2026/${MISNAMED_FILE_CLIENT}/01-January/2026-01_${MISNAMED_FILE_CLIENT}_VendorTraining.xlsx`;
    expect(plan.tree.filePaths).not.toContain(compliant);
    expect(plan.tree.filePaths).toContain(misnamed);
    expect(MISNAMED_FILE_MONTH).toBe(1);
  });

  it("is identical across two builds with the same arguments", () => {
    expect(buildSeedPlan(exampleSeedProfile(), options)).toEqual(buildSeedPlan(exampleSeedProfile(), options));
  });

  it("refuses a clientCount below the highest planted client index", () => {
    // MISNAMED_FILE_CLIENT is Client09, the higher of the two planted client
    // indexes, so a clientCount of 8 never builds a folder for it: planting
    // would fail for a reason that has nothing to do with the naming
    // template, which is exactly the false blame this guard exists to avoid.
    expect(() => buildSeedPlan(exampleSeedProfile(), { ...options, clientCount: 8 })).toThrow(/clientCount/);
  });

  it("refuses a clientCount at or above ABSENT_CLIENT's index", () => {
    // ABSENT_CLIENT is Client13. At clientCount 13, buildSeedTree builds a
    // folder for it, which is exactly the client this plant needs to stay
    // absent from the repository so the reconciliation report has a missing
    // client finding to make.
    expect(() => buildSeedPlan(exampleSeedProfile(), { ...options, clientCount: 13 })).toThrow(/clientCount/);
  });

  // Both planted months are now fixed at 1, always within throughMonth's
  // 1..12 range, and clientCount is bounded on both sides above, so neither
  // lever can exclude one plant's path from the tree without also excluding
  // the other's, or without buildSeedPlan refusing to run at all. The two
  // tests below construct the divergence the guards actually exist to catch
  // a different way: a profile whose naming.template answers differently on
  // one specific read than it did while buildSeedTree built the tree, which
  // is what "the profile's naming template and this seed's planted set have
  // diverged" is describing.
  //
  // buildSeedTree reads profile.naming.template once per (client, month)
  // pair while building the tree. With clientCount 9 (the plant's own floor)
  // and throughMonth 1, that pair count is 9 (9 clients times 1 month), and
  // month 1 is never a quarter-end month, so the quarterly branch never adds
  // a read. buildSeedPlan then reads the template three more times, in a
  // fixed order, one read per plantedPath call: omitted (the missing-file
  // plant), then replacedFrom (the misnamed-file plant's rename source),
  // then replacedTo (its rename target). So the omitted read is read 10, and
  // the replacedFrom read is read 11.
  const DIVERGENCE_OPTIONS = { clientCount: 9, year: 2026, includeQuarterly: true, throughMonth: 1 };
  const OMITTED_TEMPLATE_READ = 10;
  const REPLACED_FROM_TEMPLATE_READ = 11;

  function profileWithDivergedTemplateOnRead(divergeOnRead: number): SeedProfileInput {
    const profile = exampleSeedProfile();
    const realTemplate = profile.naming.template;
    let reads = 0;
    return {
      ...profile,
      naming: {
        get template() {
          reads += 1;
          return reads === divergeOnRead ? "{year}-{month:02}_{client}_{deliverable}_DIVERGED.xlsx" : realTemplate;
        },
      },
    };
  }

  it("names the missing-file plant when only its path was computed from a different template", () => {
    // Read 10 (omitted) answers with a different template; read 11
    // (replacedFrom) still answers with the real one, so the misnamed check
    // passes on its own and the missing-file check is the one that fires.
    expect(() => buildSeedPlan(profileWithDivergedTemplateOnRead(OMITTED_TEMPLATE_READ), DIVERGENCE_OPTIONS)).toThrow(
      /missing-file plant/,
    );
  });

  it("names the misnamed-file plant when only its rename-source path was computed from a different template", () => {
    // Read 11 (replacedFrom) answers with a different template; read 10
    // (omitted) still answers with the real one, so the misnamed check is
    // the one that fires, independently of the missing-file check.
    expect(() =>
      buildSeedPlan(profileWithDivergedTemplateOnRead(REPLACED_FROM_TEMPLATE_READ), DIVERGENCE_OPTIONS),
    ).toThrow(/misnamed-file plant/);
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
    expect(loadSeedProfile(exampleProfileRaw())).toEqual(exampleSeedProfile());
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
    putBytes: async () => { throw new Error("this fake does not implement putBytes"); },
    patch: async () => { throw new Error("this fake does not implement patch"); },
  };
  return { client, calls };
}

describe("executeSeed", () => {
  it("resolves the drive, creates every folder before any file, and counts every request", async () => {
    const profile = exampleSeedProfile();
    const tree = buildSeedTree(profile, { clientCount: 1, year: 2026, includeQuarterly: false, throughMonth: 12 });
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
      // December, so the seeded year (defaulted from this same clock) equals
      // the current year and throughMonth caps at 12: this test's point is
      // the dry-run wiring, not the month cap, so it asserts the full,
      // uncapped tree that the "buildSeedPlan" and "throughMonth" describe
      // blocks cover on their own.
      now: () => new Date("2026-12-15T00:00:00Z"),
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
      // Same reasoning as the dry-run test above: December keeps throughMonth
      // at 12 so this test's fixed folder and file counts stay meaningful.
      now: () => new Date("2026-12-15T00:00:00Z"),
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
