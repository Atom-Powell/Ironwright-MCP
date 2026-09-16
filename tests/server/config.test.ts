import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";

describe("loadConfig", () => {
  it("reads the profile directory alongside the port and the write gate", () => {
    const config = loadConfig({ PORT: "8080", IW_ALLOW_WRITES: "true", IW_PROFILE_DIR: "/etc/iw/profiles" });

    expect(config).toEqual({ port: 8080, allowWrites: true, profileDir: "/etc/iw/profiles" });
  });

  it("keeps the port default and the writes-disabled default", () => {
    const config = loadConfig({ IW_PROFILE_DIR: "profiles" });

    expect(config.port).toBe(3000);
    expect(config.allowWrites).toBe(false);
  });

  it("trims a profile directory given with surrounding whitespace", () => {
    expect(loadConfig({ IW_PROFILE_DIR: "  profiles  " }).profileDir).toBe("profiles");
  });
});
