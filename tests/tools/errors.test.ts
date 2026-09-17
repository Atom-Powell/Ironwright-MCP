import { describe, expect, it } from "vitest";
import { describeToolFailure } from "../../src/tools/errors.js";
import { UnknownProfileError } from "../../src/profiles/registry.js";
import { LibraryNotFoundError } from "../../src/graph/drive.js";
import { WorkbookFileError, WorkbookMappingError, WorkbookUnreadableError } from "../../src/workbook/errors.js";
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
    // edit a mapping that is not the problem. This is xlsx.ts's actual
    // message for xl/_rels/workbook.xml.rels being absent, which is reached
    // only after xl/workbook.xml was already found and parsed, so this
    // archive is confirmed xlsx-shaped and the failure is squarely the
    // file's, not a candidate for the wrong-file ambiguity below.
    const original =
      "The workbook archive has no xl/_rels/workbook.xml.rels, which is needed for mapping a sheet's r:id to " +
      "the worksheet part that holds it. Either the file is not a well formed xlsx workbook, or the download " +
      "was truncated.";

    const message = describeToolFailure(new WorkbookFileError(original), SUBJECT);

    expect(message).toContain(original);
    expect(message).toContain("about the workbook file itself");
    expect(message).not.toContain("workbook mapping in profile");
  });

  it("names both possibilities for an unreadable workbook without asserting either", () => {
    const original = "The downloaded file is not a zip archive, so it is not an xlsx workbook.";

    const message = describeToolFailure(new WorkbookUnreadableError(original), SUBJECT);

    expect(message).toContain(original);
    expect(message).toContain('profile "example"\'s workbookPath naming a file that was never a workbook');
    expect(message).toContain("truncated or corrupted in transit");
    expect(message).toContain("Open the file at that path to see which");
  });

  it("names both possibilities for a workbook missing xl/workbook.xml, the same as any other unreadable archive", () => {
    // xl/workbook.xml is the part that makes an archive an xlsx workbook at
    // all, so its absence is exactly as ambiguous as bytes that do not open
    // as a zip: a profile's workbookPath naming a file that was never a
    // workbook -- a .docx is a zip too -- and a truncated xlsx download both
    // produce it, and xlsx.ts's requirePart cannot tell them apart either,
    // so it throws this same kind with this same attribution.
    const original = "The workbook archive has no xl/workbook.xml, so it does not open as a workbook.";

    const message = describeToolFailure(new WorkbookUnreadableError(original), SUBJECT);

    expect(message).toContain(original);
    expect(message).toContain('profile "example"\'s workbookPath naming a file that was never a workbook');
    expect(message).toContain("truncated or corrupted in transit");
    expect(message).toContain("Open the file at that path to see which");
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
