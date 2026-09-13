import { describe, expect, it } from "vitest";
import { loadGraphCredentials } from "../src/config.js";

describe("loadGraphCredentials failures", () => {
  it("names every missing variable at once rather than one per run", () => {
    expect(() => loadGraphCredentials({ IW_TENANT_ID: "tenant-1" })).toThrow(/IW_CLIENT_ID.*IW_CLIENT_SECRET/s);
  });

  it("treats an empty value as absent, since an unset shell variable expands to one", () => {
    expect(() =>
      loadGraphCredentials({ IW_TENANT_ID: "tenant-1", IW_CLIENT_ID: "", IW_CLIENT_SECRET: "secret-1" }),
    ).toThrow(/IW_CLIENT_ID/);
  });

  it("never echoes a value it rejected", () => {
    expect(() => loadGraphCredentials({ IW_CLIENT_SECRET: "secret-1" })).not.toThrow(/secret-1/);
  });

  it("translates the names npm run setup actually prints, which differ from the ones read here", () => {
    const call = () => loadGraphCredentials({});

    expect(call).toThrow(/AZURE_TENANT_ID is IW_TENANT_ID/);
    expect(call).toThrow(/AZURE_CLIENT_SECRET is IW_CLIENT_SECRET/);
  });
});
