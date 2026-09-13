/**
 * Path addressing is the default mode for a reason: a driveItem id is stable
 * only until someone moves the file, and an id-navigating tool fails on exactly
 * the repositories that need reconciling most.
 */

const ROOT_MARKER = "root:";

export class ParentPathError extends Error {
  readonly parentReferencePath: string;

  constructor(parentReferencePath: string) {
    super(
      "A driveItem's parentReference.path did not contain the expected \"root:\" marker, so its " +
        `library-relative path cannot be derived. Received: "${parentReferencePath}". ` +
        "Refused rather than guessed, because a wrong path becomes a file the reconciliation " +
        "engine reports as missing.",
    );
    this.name = "ParentPathError";
    this.parentReferencePath = parentReferencePath;
  }
}

/**
 * `encodeURIComponent` per segment rather than `encodeURI` over the whole path.
 * `encodeURI` leaves `#` and `?` alone, and either one in a SharePoint file name
 * truncates the request URL at that character and addresses the wrong item.
 */
export function driveItemPath(driveId: string, libraryRelativePath: string): string {
  const trimmed = libraryRelativePath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed.length === 0) return `/drives/${driveId}/root`;

  const encoded = trimmed.split("/").map(encodeURIComponent).join("/");
  return `/drives/${driveId}/root:/${encoded}:`;
}

/**
 * Graph returns `parentReference.path` percent-encoded and `name` unencoded, so
 * only the parent half is decoded here. Decoding the name as well would turn a
 * file genuinely called "a%20b.xlsx" into "a b.xlsx" and the engine would then
 * report the real file as missing and the decoded one as an orphan.
 */
export function libraryRelativePath(parentReferencePath: string, name: string): string {
  const marker = parentReferencePath.indexOf(ROOT_MARKER);
  if (marker === -1) throw new ParentPathError(parentReferencePath);

  const afterRoot = parentReferencePath.slice(marker + ROOT_MARKER.length);
  const segments = afterRoot
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(decodeURIComponent);

  return [...segments, name].join("/");
}
