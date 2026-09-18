import { describe } from "vitest";
import { createMemoryStateStore } from "../../src/store/memory.js";
import { stateStoreConformance } from "./conformance.js";

describe("in-memory state store", () => {
  stateStoreConformance(() => createMemoryStateStore());
});
