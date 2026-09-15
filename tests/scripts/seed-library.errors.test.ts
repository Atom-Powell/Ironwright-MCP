import { describe, expect, it } from "vitest";
import {
  buildSeedTree,
  createSeedGraphClient,
  loadSeedProfile,
  parseSeedArguments,
  substituteTokens,
} from "../../scripts/seed-library.js";
import { exampleSeedProfile } from "./seed/fixtures.js";

describe("substituteTokens failures", () => {
  it("refuses a token this seeder does not support", () => {
    expect(() => substituteTokens("{quarter}", { year: "2026" })).toThrow(/does not support/);
  });

  it("refuses {client} with no client value supplied", () => {
    expect(() => substituteTokens("{client}", { year: "2026" })).toThrow(/\{client\}/);
  });

  it("refuses {month:02} with no month value supplied", () => {
    expect(() => substituteTokens("{month:02}", { year: "2026" })).toThrow(/\{month:02\}/);
  });

  it("refuses {monthName} with no month value supplied", () => {
    expect(() => substituteTokens("{monthName}", { year: "2026" })).toThrow(/\{monthName\}/);
  });

  it("refuses {deliverable} with no deliverable value supplied", () => {
    expect(() => substituteTokens("{deliverable}", { year: "2026" })).toThrow(/\{deliverable\}/);
  });
});

describe("buildSeedTree failures", () => {
  it("refuses a clientCount below 1", () => {
    expect(() => buildSeedTree(exampleSeedProfile(), { clientCount: 0, year: 2026, includeQuarterly: false, throughMonth: 12 })).toThrow(
      /clientCount/,
    );
  });

  it("refuses a non-integer clientCount", () => {
    expect(() => buildSeedTree(exampleSeedProfile(), { clientCount: 1.5, year: 2026, includeQuarterly: false, throughMonth: 12 })).toThrow(
      /clientCount/,
    );
  });

  it("refuses a profile with no monthly-cadence deliverable", () => {
    const profile = exampleSeedProfile();
    profile.deliverables = [{ token: "QuarterlyPhishing", cadence: "quarterly" }];
    expect(() => buildSeedTree(profile, { clientCount: 1, year: 2026, includeQuarterly: false, throughMonth: 12 })).toThrow(/monthly/);
  });

  it("refuses includeQuarterly when the profile has no quarterly-cadence deliverable", () => {
    const profile = exampleSeedProfile();
    profile.deliverables = [{ token: "MonthlyTraining", cadence: "monthly" }];
    expect(() => buildSeedTree(profile, { clientCount: 1, year: 2026, includeQuarterly: true, throughMonth: 12 })).toThrow(/quarterly/);
  });

  it("refuses an empty taxonomy", () => {
    const profile = exampleSeedProfile();
    profile.taxonomy = { segments: [] };
    expect(() => buildSeedTree(profile, { clientCount: 1, year: 2026, includeQuarterly: false, throughMonth: 12 })).toThrow(
      /taxonomy/,
    );
  });
});

describe("parseSeedArguments failures", () => {
  it("refuses a missing --profile", () => {
    expect(() => parseSeedArguments([])).toThrow(/--profile/);
  });

  it("refuses --profile with no value", () => {
    expect(() => parseSeedArguments(["--profile"])).toThrow(/--profile needs a value/);
  });

  it("refuses --clients with a non-numeric value", () => {
    expect(() => parseSeedArguments(["--profile", "p.json", "--clients", "abc"])).toThrow(/--clients/);
  });

  it("refuses --clients below 1", () => {
    expect(() => parseSeedArguments(["--profile", "p.json", "--clients", "0"])).toThrow(/--clients/);
  });

  it("refuses --year with a non-numeric value", () => {
    expect(() => parseSeedArguments(["--profile", "p.json", "--year", "abc"])).toThrow(/--year/);
  });

  it("refuses an unrecognized flag", () => {
    expect(() => parseSeedArguments(["--profile", "p.json", "--bogus"])).toThrow(/--bogus/);
  });
});

describe("loadSeedProfile failures", () => {
  it("refuses a non-object profile", () => {
    expect(() => loadSeedProfile("not an object")).toThrow(/JSON object/);
  });

  it("refuses a profile missing identity.siteUrl or identity.library", () => {
    const profile = exampleSeedProfile() as unknown as Record<string, unknown>;
    delete (profile as { identity?: unknown }).identity;
    expect(() => loadSeedProfile(profile)).toThrow(/identity/);
  });

  it("refuses a profile with an empty taxonomy.segments", () => {
    const profile = { ...exampleSeedProfile(), taxonomy: { segments: [] } };
    expect(() => loadSeedProfile(profile)).toThrow(/taxonomy/);
  });

  it("refuses a profile with no naming.template", () => {
    const profile = { ...exampleSeedProfile(), naming: {} };
    expect(() => loadSeedProfile(profile)).toThrow(/naming/);
  });

  it("refuses a profile whose deliverables is not an array", () => {
    const profile = { ...exampleSeedProfile(), deliverables: "nope" };
    expect(() => loadSeedProfile(profile)).toThrow(/deliverables/);
  });

  it("refuses a deliverable entry with no token or cadence", () => {
    const profile = { ...exampleSeedProfile(), deliverables: [{ id: "x" }] };
    expect(() => loadSeedProfile(profile)).toThrow(/deliverables\[0\]/);
  });
});

describe("createSeedGraphClient failures", () => {
  const TOKEN = { getToken: async () => "token-1" };

  it("throws a GraphRequestError when folder creation is refused", async () => {
    const client = createSeedGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async () => new Response("{}", { status: 403 })) as typeof fetch,
    });

    await expect(client.createFolder("drive-1", "2026", "Client01")).rejects.toMatchObject({
      name: "GraphRequestError",
      status: 403,
    });
  });

  it("throws a GraphRequestError for a 409 that is not nameAlreadyExists, rather than tolerating every 409", async () => {
    const client = createSeedGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { code: "resourceLocked", message: "locked" } }), {
          status: 409,
        })) as typeof fetch,
    });

    await expect(client.createFolder("drive-1", "2026", "Client01")).rejects.toMatchObject({
      name: "GraphRequestError",
      status: 409,
      code: "resourceLocked",
    });
  });

  it("throws a GraphRequestError when file creation is refused", async () => {
    const client = createSeedGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async () => new Response("{}", { status: 507 })) as typeof fetch,
    });

    await expect(client.createFile("drive-1", "2026/Client01", "f.xlsx", "x")).rejects.toMatchObject({
      name: "GraphRequestError",
      status: 507,
    });
  });

  it("throws a GraphRequestError when the site or drive GET is refused", async () => {
    const client = createSeedGraphClient({
      tokenProvider: TOKEN,
      fetchImpl: (async () => new Response("{}", { status: 404 })) as typeof fetch,
    });

    await expect(client.get("/sites/contoso.sharepoint.com:/sites/Example")).rejects.toMatchObject({
      name: "GraphRequestError",
      status: 404,
    });
  });
});
