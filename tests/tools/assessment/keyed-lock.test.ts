import { describe, expect, it } from "vitest";
import { withKeyedLock } from "../../../src/tools/assessment/keyed-lock.js";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("withKeyedLock", () => {
  it("runs calls under one key one at a time, in arrival order", async () => {
    const events: string[] = [];
    const run = (name: string) =>
      withKeyedLock("k", async () => {
        events.push(`${name} start`);
        await tick();
        await tick();
        events.push(`${name} end`);
        return name;
      });

    const results = await Promise.all([run("a"), run("b"), run("c")]);

    expect(results).toEqual(["a", "b", "c"]);
    expect(events).toEqual(["a start", "a end", "b start", "b end", "c start", "c end"]);
  });

  it("lets calls under different keys overlap", async () => {
    const events: string[] = [];
    const run = (key: string) =>
      withKeyedLock(key, async () => {
        events.push(`${key} start`);
        await tick();
        events.push(`${key} end`);
      });

    await Promise.all([run("x"), run("y")]);

    expect(events).toEqual(["x start", "y start", "x end", "y end"]);
  });

  it("releases the key when a call throws, so the next call still runs", async () => {
    await expect(withKeyedLock("k", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");

    await expect(withKeyedLock("k", async () => "after")).resolves.toBe("after");
  });
});
