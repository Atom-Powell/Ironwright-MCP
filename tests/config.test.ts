import { describe, expect, it } from "vitest";
import { loadGraphCredentials, loadStoreConnectionString } from "../src/config.js";

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
