import { describe, expect, it } from "vitest";
import { describeToolFailure } from "../../src/tools/errors.js";
import { LibraryNotFoundError } from "../../src/graph/drive.js";
import { GraphRequestError } from "../../src/graph/errors.js";

describe("describeToolFailure says nothing it cannot observe", () => {
  it("does not name a site it was not given", () => {
    const message = describeToolFailure(new LibraryNotFoundError("Reports", ["Documents"], 1), {
      tool: "reconcile_workbook_vs_repository",
      profileId: "example",
    });

    expect(message).not.toContain("names site");
    expect(message).toContain('Profile "example" is what names the library');
  });

  it("omits the parenthesized code when Graph returned a body carrying none", () => {
    const error = new GraphRequestError({ method: "GET", path: "/sites/x", status: 502, body: "<html>bad gateway</html>" });

    const message = describeToolFailure(error, { tool: "reconcile_workbook_vs_repository", profileId: "example" });

    expect(message).toContain("502");
    expect(message).not.toContain("(undefined)");
    expect(message).not.toContain("()");
  });

  it("does not reproduce a Graph response body in the tool result", () => {
    const error = new GraphRequestError({
      method: "GET",
      path: "/sites/x",
      status: 500,
      body: JSON.stringify({ error: { code: "internalServerError", message: "SECRET-LOOKING-DETAIL" } }),
    });

    expect(
      describeToolFailure(error, { tool: "reconcile_workbook_vs_repository", profileId: "example" }),
    ).not.toContain("SECRET-LOOKING-DETAIL");
  });
});
