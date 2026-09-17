import { describe, expect, it, vi } from "vitest";
import { runReconcile } from "../../../src/tools/reconciliation/run.js";
import { createFakeToolContext } from "../../tools/fake-context.js";
import { WorkbookMappingError } from "../../../src/workbook/errors.js";
import { GraphRequestError } from "../../../src/graph/errors.js";

function textOf(result: Awaited<ReturnType<typeof runReconcile>>): string {
  return JSON.stringify(result.content);
}

describe("runReconcile failures", () => {
  it("names the configured profiles when asked for one that is not configured", async () => {
    const result = await runReconcile({ profileId: "nope" }, createFakeToolContext(), async () => {
      throw new Error("the workbook should never have been read");
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("example");
  });

  it("does not scan when the workbook read fails", async () => {
    let scanned = false;
    const context = createFakeToolContext({
      scans: {
        run: async () => {
          scanned = true;
          throw new Error("unreachable");
        },
      },
    });

    const result = await runReconcile({ profileId: "example" }, context, async () => {
      throw new WorkbookMappingError('The mapping names a column "Client Code" that the sheet does not have.');
    });

    expect(scanned).toBe(false);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Client Code");
  });

  it("reports a Graph failure by status and code without the response body", async () => {
    const context = createFakeToolContext({
      scans: {
        run: async () => {
          throw new GraphRequestError({
            method: "GET",
            path: "/drives/drive-1/root/delta",
            status: 429,
            body: JSON.stringify({ error: { code: "activityLimitReached", message: "DO-NOT-LEAK" } }),
          });
        },
      },
    });

    const result = await runReconcile({ profileId: "example" }, context, async () => ({
      rows: [],
      rejectedRows: [],
      source: "workbook",
    }));

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("activityLimitReached");
    expect(textOf(result)).not.toContain("DO-NOT-LEAK");
  });

  it("logs the failure before describing it, so the log the description promises actually exists", async () => {
    // describeToolFailure's Graph branch tells the operator that the full
    // Graph response was written to the server log, and src/tools/errors.ts
    // itself does no logging. Nothing else in this repo checks that the log
    // call in run.ts still exists, so a future edit could delete it and
    // every other committed test would stay green while that sentence
    // started promising a log entry nothing wrote.
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const graphError = new GraphRequestError({
        method: "GET",
        path: "/drives/drive-1/root/delta",
        status: 429,
        body: JSON.stringify({ error: { code: "activityLimitReached", message: "irrelevant to this test" } }),
      });
      const context = createFakeToolContext({
        scans: {
          run: async () => {
            throw graphError;
          },
        },
      });

      const result = await runReconcile({ profileId: "example" }, context, async () => ({
        rows: [],
        rejectedRows: [],
        source: "workbook",
      }));

      expect(result.isError).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      // Asserted against the actual error object, not just that some log
      // call happened, because a log call that only carries a string would
      // not be the full Graph response the message promises was written.
      const call = spy.mock.calls[0];
      expect(call?.[1]).toBe(graphError);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects an input with no profileId rather than reconciling a default", async () => {
    await expect(runReconcile({}, createFakeToolContext(), async () => ({
      rows: [],
      rejectedRows: [],
      source: "workbook",
    }))).rejects.toThrow();
  });
});
