import { describe, expect, it } from "vitest";
import { describeToolFailure } from "../../src/tools/errors.js";
import { UnknownProfileError } from "../../src/profiles/registry.js";
import { LibraryNotFoundError } from "../../src/graph/drive.js";
import { WorkbookFileError, WorkbookMappingError } from "../../src/workbook/errors.js";
import { GraphRequestError } from "../../src/graph/errors.js";
import { TokenRequestError } from "../../src/graph/token.js";

const SUBJECT = {
  profileId: "example",
  siteUrl: "https://contoso.sharepoint.com/sites/Example",
  library: "Compliance Reports",
};

describe("describeToolFailure", () => {
  it("passes an unknown profile through, since it already names the configured ids", () => {
    const message = describeToolFailure(new UnknownProfileError("nope", ["example", "other"]), {
      profileId: "nope",
    });

    expect(message).toContain('"example", "other"');
    expect(message).toContain('No profile named "nope"');
  });

  it("names the site and library from the profile when the library will not resolve", () => {
    const message = describeToolFailure(new LibraryNotFoundError("Compliance Reports", ["Documents"], 1), SUBJECT);

    expect(message).toContain('profile "example"');
    expect(message).toContain("https://contoso.sharepoint.com/sites/Example");
    expect(message).toContain('"Compliance Reports"');
    expect(message).toContain('"Documents"');
  });

  it("passes a workbook mapping message through unchanged and says which profile it came from", () => {
    const original = 'The mapping names a column "Client Code" that the sheet does not have.';

    const message = describeToolFailure(new WorkbookMappingError(original), SUBJECT);

    expect(message).toContain(original);
    expect(message).toContain('workbook mapping in profile "example"');
  });

  it("passes a workbook file message through unchanged and says it is not about the profile", () => {
    // The opposite attribution from the mapping case above: the profile
    // named a real table in a real worksheet, and the archive itself is
    // what cannot be trusted, so the message must not send an operator to
    // edit a mapping that is not the problem.
    const original = "The workbook archive has no xl/workbook.xml, which is needed for resolving any sheet or table.";

    const message = describeToolFailure(new WorkbookFileError(original), SUBJECT);

    expect(message).toContain(original);
    expect(message).toContain("about the workbook file itself");
    expect(message).not.toContain("workbook mapping in profile");
  });

  it("reports a Graph failure by status, code and request, and guesses at no cause", () => {
    const error = new GraphRequestError({
      method: "GET",
      path: "/drives/drive-1/root/delta",
      status: 403,
      body: JSON.stringify({ error: { code: "accessDenied", message: "Access denied" } }),
    });

    const message = describeToolFailure(error, SUBJECT);

    expect(message).toContain("403");
    expect(message).toContain("accessDenied");
    expect(message).toContain("GET /drives/drive-1/root/delta");
    expect(message).toContain("written to the server log");
  });

  it("reports a token failure as being about the server application's own credentials", () => {
    const message = describeToolFailure(new TokenRequestError({ status: 401, body: "{}" }), SUBJECT);

    expect(message).toContain("client id and secret");
    expect(message).not.toContain("signed-in operator has");
  });

  it("reports an unrecognized error by its own message rather than inventing a category", () => {
    expect(describeToolFailure(new Error("socket hang up"), SUBJECT)).toContain("socket hang up");
  });

  it("reports a thrown non-error without crashing on it", () => {
    expect(describeToolFailure("not an error object", SUBJECT)).toContain("not an error object");
  });
});
