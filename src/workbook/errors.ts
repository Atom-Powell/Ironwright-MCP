/**
 * The three kinds of failure this reader can hit, and the distinction an
 * operator needs to know which one to act on.
 *
 * A `WorkbookMappingError` means the profile's own identification of what to
 * read -- `identity.workbookPath` naming the wrong file, or
 * `workbookMapping`'s table or worksheet name and column headers naming
 * something a workbook that is otherwise perfectly readable does not have --
 * disagrees with what is actually there. The fix lives in the profile:
 * point it at the right file, table, worksheet, or column.
 *
 * A `WorkbookFileError` means the archive itself cannot be trusted regardless
 * of what the profile asked for: a part the format requires is missing, the
 * file's own internal relationships name a part the archive does not
 * contain, or a value the format requires to have a specific shape, such as
 * a cell reference or a table's declared range, does not have it. No change
 * to a profile fixes this; the workbook itself would need to be produced
 * again, or the download retried.
 *
 * A `WorkbookUnreadableError` means neither of the above, because both assert
 * a cause and this one exists for the case where the code has not observed
 * which. It is thrown when the downloaded bytes do not open as a workbook at
 * all, such as bytes that will not parse as a zip archive: that observation
 * is consistent with `identity.workbookPath` naming a file that was never a
 * workbook, and it is equally consistent with a workbook download that was
 * truncated or otherwise corrupted in transit. This code cannot tell those
 * two apart from the bytes alone, and a kind that asserted one anyway would
 * assert something the code never observed. The fix is not in the profile
 * and not necessarily in the workbook; it is to look at the file the path
 * names and find out which happened.
 *
 * This module exists so `zip.ts`, `sheet.ts`, and `xlsx.ts`, which resolve
 * parts, cells, and ranges, can throw the correct one without importing an
 * error class from `read.ts`, which sits a layer above them and turns a
 * resolved grid into records. `read.ts` imports its `WorkbookMappingError`
 * from here as well, so every module in this package shares one definition
 * of each kind rather than each layer keeping its own.
 */

export class WorkbookMappingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkbookMappingError";
  }
}

export class WorkbookFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkbookFileError";
  }
}

export class WorkbookUnreadableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkbookUnreadableError";
  }
}
