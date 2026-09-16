import { GraphRequestError } from "../graph/errors.js";
import { LibraryNotFoundError } from "../graph/drive.js";
import { TokenRequestError } from "../graph/token.js";
import { WorkbookMappingError } from "../workbook/read.js";
import { UnknownProfileError } from "../profiles/registry.js";

/**
 * What the failing call was about, for the messages that can name it. The site
 * and library are absent when the failure was resolving the profile itself,
 * because at that point this server does not know them.
 */
export interface FailureSubject {
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

  if (error instanceof TokenRequestError) {
    return (
      `Acquiring a Microsoft Graph token failed with ${error.status}. This is about the server application's own ` +
      "client id and secret rather than about the site, the profile, or whoever asked the question."
    );
  }

  if (error instanceof GraphRequestError) {
    return (
      `Microsoft Graph refused ${error.method} ${error.path} with ${error.status}` +
      `${error.code === undefined ? "" : ` (${error.code})`}, while reconciling profile "${subject.profileId}". ` +
      "The full Graph response was written to the server log. This server does not infer a cause from the status."
    );
  }

  return error instanceof Error ? error.message : String(error);
}
