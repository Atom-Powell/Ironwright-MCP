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
  profileId: string;
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
    const where =
      subject.siteUrl === undefined
        ? `Profile "${subject.profileId}" is what names the library.`
        : `The profile "${subject.profileId}" names site ${subject.siteUrl} and library "${subject.library ?? error.library}".`;
    return `${error.message} ${where}`;
  }

  if (error instanceof WorkbookMappingError) {
    // Passed through verbatim. That message was written for this reader,
    // against the sheet it read, and has its own tests; rewording it here
    // would produce a second, worse description of the same thing. The
    // attribution is a separate sentence for that reason.
    return `${error.message} This came from the workbook mapping in profile "${subject.profileId}".`;
  }

  if (error instanceof WorkbookFileError) {
    // The opposite attribution from the mapping case above, and just as
    // load bearing: this profile's own workbookPath and workbookMapping
    // could both be exactly right and this failure would still happen,
    // because it is the downloaded archive itself that cannot be trusted.
    // Sending an operator to edit a profile that is not wrong wastes the
    // one thing this message can usefully spend, which is where to look.
    return `${error.message} This is about the workbook file itself, not about how profile "${subject.profileId}" is configured.`;
  }

  if (error instanceof WorkbookUnreadableError) {
    // Neither of the two attributions above fits here, and asserting either
    // would assert something this server never observed: it only knows the
    // downloaded bytes did not open as a workbook, not whether that is
    // because profile "X"'s workbookPath names the wrong file or because the
    // download arrived damaged. So this names both possibilities rather than
    // picking one, and gives the operator the one thing that tells them
    // apart: the profile's workbookPath is a real path, and opening the file
    // it names is what a mapping problem and a damaged download cannot both
    // survive.
    return (
      `${error.message} This could be profile "${subject.profileId}"'s workbookPath naming a file that was ` +
      "never a workbook, or it could be a workbook download that was truncated or corrupted in transit. Open " +
      "the file at that path to see which."
    );
  }

  if (error instanceof TokenRequestError) {
    return (
      `Acquiring a Microsoft Graph token failed with ${error.status}. This is about the server application's own ` +
      "client id and secret rather than about the site, the profile, or whoever asked the question."
    );
  }

  if (error instanceof GraphRequestError) {
    return (
      `Microsoft Graph refused ${error.method} ${error.path} with ${error.status}` +
      `${error.code === undefined ? "" : ` (${error.code})`}, while serving ${subject.tool} for profile ` +
      `"${subject.profileId}". ` +
      "The full Graph response was written to the server log. This server does not infer a cause from the status."
    );
  }

  return error instanceof Error ? error.message : String(error);
}
