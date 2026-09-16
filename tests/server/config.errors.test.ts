import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";

describe("loadConfig rejections", () => {
  it("refuses to start without a profile directory, naming the variable", () => {
    expect(() => loadConfig({})).toThrow(/IW_PROFILE_DIR/);
  });

  it("treats a blank profile directory as absent rather than as the current directory", () => {
    expect(() => loadConfig({ IW_PROFILE_DIR: "   " })).toThrow(/IW_PROFILE_DIR/);
  });

  it("still rejects a port that is not an integer", () => {
    expect(() => loadConfig({ PORT: "3000abc", IW_PROFILE_DIR: "profiles" })).toThrow(/PORT/);
  });
});
