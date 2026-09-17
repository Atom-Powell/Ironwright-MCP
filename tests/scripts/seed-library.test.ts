import { readFileSync } from "node:fs";
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
  formatWorkbookReport,
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
import { parseProfile } from "../../scripts/seed/expected.js";
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
  it("adds the workbook's fixed one call plus one createFolder per ancestor segment of its path", () => {
    const tree = buildSeedTree(exampleSeedProfile(), { clientCount: 2, year: 2026, includeQuarterly: true, throughMonth: 12 });

    expect(estimateGraphRequests(tree, "/Trackers/Operational Tracking Workbook.xlsx")).toBe(
      2 + tree.folderPaths.length + tree.filePaths.length + 2,
    );
  });

  it("costs one, not two, for a workbook sitting at the library root", () => {
    const tree = buildSeedTree(exampleSeedProfile(), { clientCount: 2, year: 2026, includeQuarterly: true, throughMonth: 12 });

    expect(estimateGraphRequests(tree, "/Tracker.xlsx")).toBe(2 + tree.folderPaths.length + tree.filePaths.length + 1);
  });

  it("costs one more request for each additional level the workbook is nested", () => {
    const tree = buildSeedTree(exampleSeedProfile(), { clientCount: 2, year: 2026, includeQuarterly: true, throughMonth: 12 });

    expect(estimateGraphRequests(tree, "/A/B/C/Tracker.xlsx")).toBe(
      2 + tree.folderPaths.length + tree.filePaths.length + 4,
    );
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

  it("defaults the year from the same UTC clock the cap is computed against", () => {
    // A stand-in rather than a real Date, because the disagreement this guards
    // against only exists in host time zones behind UTC and a real Date would
    // make the test pass or fail on where it ran. Around New Year the two
    // readings differ for a few hours: local is still the old year while UTC
    // has rolled over. Defaulting the year from the local reading and the cap
    // from the UTC one made them name different years, so throughMonth fell
    // back to 12 and the seeder wrote a full year that asOf sits outside,
    // which is exactly the orphan noise the cap exists to prevent.
    const newYearUtcAheadOfLocal = {
      getFullYear: () => 2026,
      getUTCFullYear: () => 2027,
      getUTCMonth: () => 0,
    } as unknown as Date;

    const args = parseSeedArguments(["--profile", "p.json"], { now: () => newYearUtcAheadOfLocal });

    expect(args.year).toBe(2027);
    expect(args.throughMonth).toBe(1);
  });
});

describe("formatDryRunReport", () => {
  it("states the tree's own counts, names the workbook, and derives the estimate from both", () => {
    const tree = buildSeedTree(exampleSeedProfile(), { clientCount: 1, year: 2026, includeQuarterly: false, throughMonth: 12 });
    // The validated profile rather than a bare path string: the workbook path
    // this report names and the one the expectation is built from must be the
    // same value, and holding the parsed profile is also what lets this report
    // say the profile passed the engine's schema without asserting something
    // it did not observe.
    const profile = parseProfile(JSON.parse(readFileSync("examples/profiles/example.json", "utf8")));
    const workbookPath = profile.identity.workbookPath;
    const lines = formatDryRunReport(
      tree,
      {
        profilePath: "p.json",
        clientCount: 1,
        year: 2026,
        includeQuarterly: false,
        confirm: false,
        throughMonth: 12,
      },
      profile,
    ).join("\n");

    expect(lines).toMatch(/Dry run/);
    expect(lines).toMatch(new RegExp(`Folders that would be created: ${tree.folderPaths.length}`));
    expect(lines).toMatch(new RegExp(`Files that would be created: ${tree.filePaths.length}`));
    expect(lines).toContain(workbookPath);
    expect(lines).toMatch(/replaced/i);
    expect(lines).toMatch(new RegExp(`Estimated Graph requests[^:]*: ${estimateGraphRequests(tree, workbookPath)}`));
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
  it("reports the tree's own counts, with no workbook request count in it", () => {
    // formatExecutionReport no longer takes a workbookRequests value at all:
    // runSeed calls it as soon as executeSeed returns, before the workbook
    // step has run, so there is no such count for it to state yet. See its
    // own comment in scripts/seed-library.ts for the sitting that ordering
    // fixes.
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
    expect(lines).toMatch(/tree: 14/);
    expect(lines).toMatch(/250ms/);
    expect(lines).not.toMatch(/workbook/i);
  });
});

describe("formatWorkbookReport", () => {
  it("states the workbook's own request count on its own line", () => {
    const lines = formatWorkbookReport(6).join("\n");
    expect(lines).toMatch(/workbook: 6/);
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
    // post, putBytes and patch answer for real, unlike the get/createFolder/
    // createFile branches' earlier not-implemented stand-ins. createSeedWorkbook
    // (scripts/seed/workbook.ts) drives only putBytes today, the workbook's one
    // content upload; post and patch are implemented anyway because
    // SeedGraphClient declares them, and a stub that throws would be a client
    // claiming a capability it silently refuses, the same reasoning
    // createSeedGraphClient's own post implementation documents.
    post: async <T,>(path: string): Promise<T> => {
      requestCount += 1;
      calls.push(`POST:${path}`);
      return { id: "t" } as T;
    },
    putBytes: async (_driveId, path) => {
      requestCount += 1;
      calls.push(`PUT:${path}`);
      return { status: 201 };
    },
    patch: async <T,>(path: string): Promise<T> => {
      requestCount += 1;
      calls.push(`PATCH:${path}`);
      return {} as T;
    },
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
      // The real example profile, not exampleProfileRaw(): runSeed validates
      // the whole profile against ProfileSchema before the --confirm branch,
      // and exampleProfileRaw() carries only the four fields loadSeedProfile
      // itself reads.
      readProfileFile: async (path) => {
        readCalls.push(path);
        return JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as unknown;
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

    // No --clients here, unlike an earlier version of this test that passed
    // "1": buildSeedPlan (which runSeed now calls in place of buildSeedTree)
    // guards clientCount to [9, 12] so both planted discrepancies land inside
    // the tree and ABSENT_CLIENT stays outside it, and 1 falls under that
    // floor. The default client count (12) already sits inside the guarded
    // range, so there is nothing to narrow.
    //
    // readProfileFile returns the real examples/profiles/example.json here,
    // not exampleProfileRaw(): runSeed validates the whole profile against
    // ProfileSchema on every path, before the --confirm branch, and
    // exampleProfileRaw() only carries the narrower set of fields
    // loadSeedProfile itself needs.
    await runSeed(["--profile", "p.json", "--no-quarterly", "--confirm"], {
      readProfileFile: async () => JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as unknown,
      createGraphClient: () => client,
      // Same reasoning as the dry-run test above: December keeps throughMonth
      // at 12 so this test's fixed folder and file counts stay meaningful.
      now: () => new Date("2026-12-15T00:00:00Z"),
      log: (line) => logs.push(line),
    });

    expect(logs.some((line) => /Seed complete/.test(line))).toBe(true);
    expect(logs.some((line) => /Folders processed: 157/.test(line))).toBe(true);
    expect(logs.some((line) => /Files processed: 143/.test(line))).toBe(true);
  });
});

describe("runSeed with the workbook", () => {
  it("issues no Graph call at all without --confirm", async () => {
    let created = false;
    await runSeed(["--profile", "examples/profiles/example.json"], {
      readProfileFile: async () => JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as unknown,
      createGraphClient: () => {
        created = true;
        throw new Error("a dry run must not build a client");
      },
      now: () => new Date("2026-09-15T00:00:00Z"),
      log: () => {},
    });
    expect(created).toBe(false);
  });

  it("names the workbook it will create in the dry run report", async () => {
    const lines: string[] = [];
    await runSeed(["--profile", "examples/profiles/example.json"], {
      readProfileFile: async () => JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as unknown,
      createGraphClient: () => {
        throw new Error("not reached");
      },
      now: () => new Date("2026-09-15T00:00:00Z"),
      log: (line) => lines.push(line),
    });
    expect(lines.join("\n")).toContain("Operational Tracking Workbook.xlsx");
  });

  // The brief's version of this test narrowed to --clients=2, which fails
  // for two reasons: this parser only takes a flag's value as the next,
  // space-separated argv entry ("--clients", "2"), not an "=" form, and even
  // spelled correctly, 2 falls under buildSeedPlan's guarded floor of 9. The
  // default client count (12) already sits inside the guarded range, so
  // --clients is omitted here rather than set to a value the guard would
  // refuse.
  it("prints the expected report after a confirmed run", async () => {
    const lines: string[] = [];
    const { client } = fakeSeedClient("Compliance Reports");

    await runSeed(["--profile", "examples/profiles/example.json", "--confirm"], {
      readProfileFile: async () => JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as unknown,
      createGraphClient: () => client,
      now: () => new Date("2026-09-15T00:00:00Z"),
      log: (line) => lines.push(line),
    });
    expect(lines.join("\n")).toContain("Expected report from the live reconciliation tool");
  });

  it("prints the execution report for the tree even when the workbook step then fails", async () => {
    // This is the 2026-09-16 sitting's second seeder defect, from
    // docs/OPEN-ITEMS.md: the workbook step failed and the operator was told
    // nothing about the 121 folders and 143 files that executeSeed had, by
    // then, already written. putBytes fails here to stand in for that
    // failure; everything else about the client answers normally, so the
    // tree step succeeds before the workbook step is even attempted.
    const lines: string[] = [];
    const { client } = fakeSeedClient("Compliance Reports");
    const workbookFailingClient: SeedGraphClient = {
      ...client,
      putBytes: async () => {
        throw new Error("simulated workbook upload failure");
      },
    };

    await expect(
      runSeed(["--profile", "examples/profiles/example.json", "--confirm"], {
        readProfileFile: async () => JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as unknown,
        createGraphClient: () => workbookFailingClient,
        now: () => new Date("2026-09-15T00:00:00Z"),
        log: (line) => lines.push(line),
      }),
    ).rejects.toThrow(/simulated workbook upload failure/);

    const report = lines.join("\n");
    expect(report).toMatch(/Seed complete/);
    expect(report).toMatch(/Folders processed: \d+/);
    expect(report).toMatch(/Files processed: \d+/);
    // The workbook step never returned a request count, so nothing printed
    // here claims one: a count this function has not observed is exactly the
    // kind of assertion this project treats as a first class defect.
    expect(report).not.toMatch(/Graph requests issued to replace the workbook/);
  });

  it("refuses a profile that fails the full schema before the dry run prints anything", async () => {
    // exampleProfileRaw() passes loadSeedProfile's four-field check and fails
    // ProfileSchema, which is the exact shape of profile this guard exists
    // for. Validated in the dry run, not only on the confirmed path: the
    // alternative is a complete seed against a live tenant that then dies
    // with a Zod error and prints no expectation at all.
    const lines: string[] = [];
    await expect(
      runSeed(["--profile", "p.json"], {
        readProfileFile: async () => exampleProfileRaw(),
        createGraphClient: () => {
          throw new Error("a dry run must not build a client");
        },
        now: () => new Date("2026-09-15T00:00:00Z"),
        log: (line) => lines.push(line),
      }),
    ).rejects.toThrow();
    expect(lines).toEqual([]);
  });

  it("says in the dry run that the profile passed the schema the engine requires", async () => {
    const lines: string[] = [];
    await runSeed(["--profile", "examples/profiles/example.json"], {
      readProfileFile: async () => JSON.parse(readFileSync("examples/profiles/example.json", "utf8")) as unknown,
      createGraphClient: () => {
        throw new Error("a dry run must not build a client");
      },
      now: () => new Date("2026-09-15T00:00:00Z"),
      log: (line) => lines.push(line),
    });
    expect(lines.join("\n")).toMatch(/profile schema/i);
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
