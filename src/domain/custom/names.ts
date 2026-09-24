/**
 * SharePoint's naming rules, from Microsoft's "Restrictions and limitations in
 * OneDrive and SharePoint" (support.microsoft.com, read 2026-09-24). Checked at
 * plan time so a name Graph would refuse is excluded with a reason rather than
 * discovered as a failure during a write. Graph remains the authority: a name
 * this passes that Graph still refuses is reported as failed, never applied.
 */
const FORBIDDEN_CHARACTERS = /["*:<>?/\\|]/;
const RESERVED = new Set([
  ".lock",
  "con",
  "prn",
  "aux",
  "nul",
  "desktop.ini",
  ...Array.from({ length: 10 }, (_v, i) => `com${String(i)}`),
  ...Array.from({ length: 10 }, (_v, i) => `lpt${String(i)}`),
]);

/**
 * Splits at the last dot. A leading dot alone is not an extension, so a name
 * such as ".gitignore" keeps its whole self as the stem; otherwise a rename
 * rule would treat that file as having no stem at all.
 */
export function splitName(name: string): { stem: string; extension: string } {
  const cut = name.lastIndexOf(".");
  if (cut <= 0) return { stem: name, extension: "" };
  return { stem: name.slice(0, cut), extension: name.slice(cut) };
}

/** Why a name cannot be used, or undefined when it can. */
export function invalidNameReason(name: string, atLibraryRoot: boolean): string | undefined {
  if (name.length === 0) return "the name is empty";
  if (FORBIDDEN_CHARACTERS.test(name)) return 'the name contains a character SharePoint forbids (" * : < > ? / \\ |)';
  if (name !== name.trim()) return "the name has a leading or trailing space";
  const lower = name.toLowerCase();
  // A device name stays reserved with any extension appended, so the stem is
  // checked as well as the whole name.
  if (RESERVED.has(lower) || RESERVED.has(splitName(lower).stem)) return `"${name}" is a reserved name in SharePoint`;
  if (name.startsWith("~$")) return "a name may not begin with ~$";
  if (lower.includes("_vti_")) return "a name may not contain _vti_";
  if (atLibraryRoot && lower === "forms") return '"forms" may not be used at the root of a library';
  return undefined;
}
