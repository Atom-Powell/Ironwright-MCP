import { describe, expect, it } from "vitest";
import { describeToolFailure } from "../../src/tools/errors.js";
import { LibraryProfileError, UnknownProfileError } from "../../src/profiles/registry.js";
import { LibraryNotFoundError } from "../../src/graph/drive.js";
import { WorkbookFileError, WorkbookMappingError, WorkbookUnreadableError } from "../../src/workbook/errors.js";
import { GraphRequestError } from "../../src/graph/errors.js";
import { TokenRequestError, UnexpectedTokenRolesError } from "../../src/graph/token.js";

const SUBJECT = {
  tool: "reconcile_workbook_vs_repository",
  profileId: "example",
  siteUrl: "https://contoso.sharepoint.com/sites/Example",
  library: "Compliance Reports",
};

describe("describeToolFailure", () => {
  it("passes an unknown profile through, since it already names the configured ids", () => {
    const message = describeToolFailure(new UnknownProfileError("nope", ["example", "other"]), {
      tool: "reconcile_workbook_vs_repository",
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

  it("names the tool that failed rather than assuming reconciliation", () => {
    const error = new GraphRequestError({
      method: "GET",
      path: "/drives/x/root/delta",
      status: 503,
      body: "",
    });

    const message = describeToolFailure(error, { tool: "inventory_tree", profileId: "example" });

    expect(message).toContain("inventory_tree");
    expect(message).not.toContain("reconciling");
  });

  it("reports a token failure as being about the server application's own credentials", () => {
    const message = describeToolFailure(new TokenRequestError({ status: 401, body: "{}" }), SUBJECT);

    expect(message).toContain("client id and secret");
    expect(message).not.toContain("signed-in operator has");
  });

  it("explains a refused token role set without sending the operator to the log", () => {
    const message = describeToolFailure(
      new UnexpectedTokenRolesError({ found: ["Sites.Selected", "Files.Read.All"], extra: ["Files.Read.All"], missing: [] }),
      SUBJECT,
    );

    expect(message).toContain("Files.Read.All");
    expect(message).toContain("reconcile_workbook_vs_repository stopped when its Graph token was refused");
    // A token can rotate mid-call, after a scan has read pages or a plan tool
    // has fetched ETags, so this function cannot observe that nothing was read.
    expect(message).not.toMatch(/nothing was read/i);
    expect(message).not.toMatch(/did not run/i);
    expect(message).toContain("up to about an hour");
    expect(message).toContain("immediately if the server is restarted");
    expect(message).not.toContain("server log");
  });

  it("reports an unrecognized error by its own message rather than inventing a category", () => {
    expect(describeToolFailure(new Error("socket hang up"), SUBJECT)).toContain("socket hang up");
  });

  it("reports a thrown non-error without crashing on it", () => {
    expect(describeToolFailure("not an error object", SUBJECT)).toContain("not an error object");
  });

  it("explains that a tool needs a compliance profile when handed a library-only one", () => {
    const message = describeToolFailure(new LibraryProfileError("docs"), { tool: "reconcile_workbook_vs_repository", profileId: "docs" });

    expect(message).toContain('"docs"');
    expect(message).toContain("library-only");
    expect(message).toContain("reconcile_workbook_vs_repository");
  });

  describe("with no profileId, the shape describe_workbook is the first tool to hit", () => {
    const NO_PROFILE_SUBJECT = { tool: "describe_workbook", siteUrl: "https://contoso.sharepoint.com/sites/Example", library: "Documents" };

    it("names this call's own site and library rather than a profile when the library will not resolve", () => {
      const message = describeToolFailure(new LibraryNotFoundError("Documents", ["Trackers"], 1), NO_PROFILE_SUBJECT);

      expect(message).toContain("This call named site https://contoso.sharepoint.com/sites/Example and library \"Documents\" directly, not through a profile.");
      expect(message).not.toContain("profile \"undefined\"");
      expect(message).not.toContain("Profile \"");
    });

    it("names neither a site nor a profile when the failure came before either was known", () => {
      const message = describeToolFailure(new LibraryNotFoundError("Documents", ["Trackers"], 1), { tool: "describe_workbook" });

      expect(message).toContain("This call's own arguments are what name the library; no profile is involved.");
      expect(message).not.toContain("undefined");
    });

    it("attributes a workbook mapping failure to this call's own arguments rather than a profile", () => {
      const original = 'No table named "Nope" was found in the workbook.';

      const message = describeToolFailure(new WorkbookMappingError(original), NO_PROFILE_SUBJECT);

      expect(message).toContain(original);
      expect(message).toContain("This came from the source named in this call's own arguments, not from a profile.");
      expect(message).not.toContain("profile \"undefined\"");
    });

    it("attributes a workbook file failure to the file itself, naming no profile", () => {
      const original = "The workbook archive has no xl/_rels/workbook.xml.rels.";

      const message = describeToolFailure(new WorkbookFileError(original), NO_PROFILE_SUBJECT);

      expect(message).toContain(original);
      expect(message).toContain("This is about the workbook file itself, not about anything this call's own arguments named.");
      expect(message).not.toContain("profile \"undefined\"");
    });

    it("names this call's own workbookPath argument, not a profile's, for an unreadable workbook", () => {
      const original = "The downloaded file is not a zip archive, so it is not an xlsx workbook.";

      const message = describeToolFailure(new WorkbookUnreadableError(original), NO_PROFILE_SUBJECT);

      expect(message).toContain(original);
      expect(message).toContain("this call's own workbookPath argument naming a file that was never a workbook");
      expect(message).not.toContain("profile \"undefined\"");
    });

    it("names the tool alone, with no dangling profile attribution, for a Graph failure", () => {
      const error = new GraphRequestError({ method: "GET", path: "/drives/drive-1/root/content", status: 403, body: "{}" });

      const message = describeToolFailure(error, NO_PROFILE_SUBJECT);

      expect(message).toContain("while serving describe_workbook.");
      expect(message).not.toContain("for profile");
    });
  });
});
