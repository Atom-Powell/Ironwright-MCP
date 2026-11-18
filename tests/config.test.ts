import { describe, expect, it } from "vitest";
import { loadGrantedSiteUrl, loadGrantedSiteUrls, loadGraphCredentials, loadStoreConnectionString } from "../src/config.js";

const ENV = {
  IW_TENANT_ID: "tenant-1",
  IW_CLIENT_ID: "client-1",
  IW_CLIENT_SECRET: "secret-1",
};

describe("loadGraphCredentials", () => {
  it("reads all three values", () => {
    expect(loadGraphCredentials(ENV)).toEqual({ tenantId: "tenant-1", clientId: "client-1", clientSecret: "secret-1" });
  });
});

// A deployment may be granted more than one site: a department each, for a consumer whose
// departments each keep their own. One variable names them all.
describe("loadGrantedSiteUrls", () => {
  const OPS = "https://contoso.sharepoint.com/sites/Ops";
  const DESK = "https://contoso.sharepoint.com/sites/ServiceDesk";

  it("reads one site as a list of one", () => {
    expect(loadGrantedSiteUrls({ IW_SITE_URL: OPS })).toEqual([OPS]);
  });

  it("reads several sites separated by commas, spaces or new lines, in the order given and once each", () => {
    expect(loadGrantedSiteUrls({ IW_SITE_URL: `${OPS}, ${DESK}\n${OPS}` })).toEqual([OPS, DESK]);
  });

  it("refuses an entry that is not a URL, naming it and saying what the variable holds", () => {
    expect(() => loadGrantedSiteUrls({ IW_SITE_URL: `${OPS}, ServiceDesk` })).toThrow(/IW_SITE_URL names "ServiceDesk", which is not a URL/);
  });

  it("refuses a missing value as the single form does", () => {
    expect(() => loadGrantedSiteUrls({})).toThrow(/IW_SITE_URL/);
  });

  it("gives the first site to the one caller that needs a single site", () => {
    expect(loadGrantedSiteUrl({ IW_SITE_URL: `${OPS} ${DESK}` })).toBe(OPS);
  });
});

describe("loadGrantedSiteUrl", () => {
  it("reads the granted site from IW_SITE_URL", () => {
    expect(loadGrantedSiteUrl({ IW_SITE_URL: "https://contoso.sharepoint.com/sites/Ops" })).toBe(
      "https://contoso.sharepoint.com/sites/Ops",
    );
  });

  it("refuses a missing granted site by naming the variable and where it comes from", () => {
    expect(() => loadGrantedSiteUrl({})).toThrow(/IW_SITE_URL/);
    expect(() => loadGrantedSiteUrl({})).toThrow(/npm run setup/);
  });
});

describe("loadStoreConnectionString", () => {
  it("returns undefined when none is set, which selects the in-memory store", () => {
    expect(loadStoreConnectionString({})).toBeUndefined();
  });

  it("returns the connection string when set", () => {
    expect(loadStoreConnectionString({ IW_TABLE_CONNECTION_STRING: "UseDevelopmentStorage=true" })).toBe(
      "UseDevelopmentStorage=true",
    );
  });
});
