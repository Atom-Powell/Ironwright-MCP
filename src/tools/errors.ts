import { GraphRequestError } from "../graph/errors.js";
import { LibraryNotFoundError } from "../graph/drive.js";
import { TokenRequestError } from "../graph/token.js";
import { WorkbookFileError, WorkbookMappingError, WorkbookUnreadableError } from "../workbook/errors.js";
import { UnknownProfileError } from "../profiles/registry.js";

/**
 * What the failing call was about, for the messages that can name it. The site
 * and library are absent when the failure was resolving the profile itself,
 * because at that point this server does not know them.
 */
export interface FailureSubject {
  /**
   * The failing tool's own registered name. Required rather than optional
   * because this mapper is shared, and a message that names the wrong
   * operation is the defect class this project produced nine times in phase 1:
   * correct on its own, wrong about what the program actually did.
   */
  tool: string;
  /**
   * Optional because describe_workbook has none: it is the one tool a human
   * runs before a profile exists, so it names a library and a workbookPath
   * directly rather than through profile configuration. Every branch below
   * that would otherwise interpolate this field carries its own undefined
   * case, so a message never names a profile that does not exist, which
   * would read as `profile ""`, the defect this project is named for.
   */
  profileId?: string;
  siteUrl?: string;
  library?: string;
}

/**
 * Turns a failure into something an operator can act on, naming only what this
 * server observed.
 *
 * Nothing here infers a cause from a status. A 403 from Graph has several
 * remedies and this server cannot tell which applies, and a message that picks
 * one sends the operator to check the wrong thing. The setup command already
 * produced that defect and it is recorded in `docs/OPEN-ITEMS.md`.
 */
export function describeToolFailure(error: unknown, subject: FailureSubject): string {
  if (error instanceof UnknownProfileError) {
    // Already names the configured ids, which is the whole remedy.
    return error.message;
  }

  if (error instanceof LibraryNotFoundError) {
    const library = subject.library ?? error.library;
    // Four branches rather than two: profileId and siteUrl are independent
    // unknowns for this mapper now that describe_workbook can supply a
    // siteUrl (the granted site) with no profileId at all. Collapsing this
    // to a single ternary on profileId alone would silently interpolate
    // `undefined` into `subject.siteUrl` for a caller that somehow has
    // neither, which is exactly the substitution this function exists to
    // refuse.
    const where =
      subject.profileId === undefined
        ? subject.siteUrl === undefined
          ? "This call's own arguments are what name the library; no profile is involved."
          : `This call named site ${subject.siteUrl} and library "${library}" directly, not through a profile.`
        : subject.siteUrl === undefined
          ? `Profile "${subject.profileId}" is what names the library.`
          : `The profile "${subject.profileId}" names site ${subject.siteUrl} and library "${library}".`;
    return `${error.message} ${where}`;
  }

  if (error instanceof WorkbookMappingError) {
    // Passed through verbatim. That message was written for this reader,
    // against the sheet it read, and has its own tests; rewording it here
    // would produce a second, worse description of the same thing. The
    // attribution is a separate sentence for that reason.
    const attribution =
      subject.profileId === undefined
        ? "This came from the source named in this call's own arguments, not from a profile."
        : `This came from the workbook mapping in profile "${subject.profileId}".`;
    return `${error.message} ${attribution}`;
  }

  if (error instanceof WorkbookFileError) {
    // The opposite attribution from the mapping case above, and just as
    // load bearing: a profile's own workbookPath and workbookMapping, or a
    // direct call's own arguments, could both be exactly right and this
    // failure would still happen, because it is the downloaded archive
    // itself that cannot be trusted. Sending an operator to edit
    // configuration that is not wrong wastes the one thing this message can
    // usefully spend, which is where to look.
    const attribution =
      subject.profileId === undefined
        ? "This is about the workbook file itself, not about anything this call's own arguments named."
        : `This is about the workbook file itself, not about how profile "${subject.profileId}" is configured.`;
    return `${error.message} ${attribution}`;
  }

  if (error instanceof WorkbookUnreadableError) {
    // Neither of the two attributions above fits here, and asserting either
    // would assert something this server never observed: it only knows the
    // downloaded bytes did not open as a workbook, not whether that is
    // because a workbookPath names the wrong file or because the download
    // arrived damaged. So this names both possibilities rather than picking
    // one, and gives the operator the one thing that tells them apart: the
    // workbookPath is a real path, and opening the file it names is what a
    // mapping problem and a damaged download cannot both survive.
    const wrongFile =
      subject.profileId === undefined
        ? "this call's own workbookPath argument naming a file that was never a workbook"
        : `profile "${subject.profileId}"'s workbookPath naming a file that was never a workbook`;
    return (
      `${error.message} This could be ${wrongFile}, or it could be a workbook download that was truncated or ` +
      "corrupted in transit. Open the file at that path to see which."
    );
  }

  if (error instanceof TokenRequestError) {
    return (
      `Acquiring a Microsoft Graph token failed with ${error.status}. This is about the server application's own ` +
      "client id and secret rather than about the site, the profile, or whoever asked the question."
    );
  }

  if (error instanceof GraphRequestError) {
    const forWhom = subject.profileId === undefined ? subject.tool : `${subject.tool} for profile "${subject.profileId}"`;
    return (
      `Microsoft Graph refused ${error.method} ${error.path} with ${error.status}` +
      `${error.code === undefined ? "" : ` (${error.code})`}, while serving ${forWhom}. ` +
      "The full Graph response was written to the server log. This server does not infer a cause from the status."
    );
  }

  return error instanceof Error ? error.message : String(error);
}
