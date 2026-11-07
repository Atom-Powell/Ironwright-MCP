import { extractPlaceholders } from "../profile/placeholders.js";

/**
 * Two closed placeholder sets, closed for the reason the taxonomy's set is:
 * a typo in a profile is a validation error at load time rather than a path
 * that renders with a literal brace and is created on the customer's site.
 */
export const WORKSPACE_PLACEHOLDERS = ["vendor", "vendorFolder", "assessmentId", "yyyy", "mm"] as const;
export const ID_PLACEHOLDERS = ["prefix", "yyyy", "mm", "item"] as const;

const ITEM_WIDTH = /^item:([1-9]\d?)$/;

export function unknownWorkspacePlaceholders(template: string): string[] {
  const supported = new Set<string>(WORKSPACE_PLACEHOLDERS);
  return extractPlaceholders(template).filter((token) => !supported.has(token));
}

export function unknownIdPlaceholders(template: string): string[] {
  const supported = new Set<string>(ID_PLACEHOLDERS);
  return extractPlaceholders(template).filter((token) => !supported.has(token) && !ITEM_WIDTH.test(token));
}

export interface WorkspaceValues {
  vendor: string;
  vendorFolder: string;
  assessmentId: string;
  now: Date;
}

export interface IdValues {
  prefix: string;
  itemId: number;
  now: Date;
}

function yyyy(now: Date): string {
  return String(now.getUTCFullYear());
}

function mm(now: Date): string {
  return String(now.getUTCMonth() + 1).padStart(2, "0");
}

function fill(template: string, lookup: (token: string) => string | undefined, kind: string): string {
  return template.replace(/\{([^}]*)\}/g, (_match, token: string) => {
    const value = lookup(token);
    if (value === undefined) throw new Error(`"{${token}}" is not a ${kind} placeholder.`);
    if (value.length === 0) throw new Error(`"{${token}}" rendered empty, which would leave a path segment blank.`);
    return value;
  });
}

export function renderWorkspaceTemplate(template: string, values: WorkspaceValues): string {
  return fill(
    template,
    (token) => {
      switch (token) {
        case "vendor": return values.vendor;
        case "vendorFolder": return values.vendorFolder;
        case "assessmentId": return values.assessmentId;
        case "yyyy": return yyyy(values.now);
        case "mm": return mm(values.now);
        default: return undefined;
      }
    },
    "workspace",
  );
}

/**
 * The item id is SharePoint's integer list item id, unique for the life of
 * the list and never reused, which is what makes the rendered ID unique
 * without a server held counter. `{item:N}` pads to N digits and never
 * truncates: an id wider than the padding is rendered whole, because a
 * truncated id is a collision.
 */
export function renderAssessmentId(template: string, values: IdValues): string {
  return fill(
    template,
    (token) => {
      if (token === "prefix") return values.prefix;
      if (token === "yyyy") return yyyy(values.now);
      if (token === "mm") return mm(values.now);
      if (token === "item") return String(values.itemId);
      const width = ITEM_WIDTH.exec(token);
      if (width !== null) return String(values.itemId).padStart(Number(width[1]), "0");
      return undefined;
    },
    "assessment id",
  );
}

/**
 * The characters SharePoint refuses in a file or folder name, removed rather
 * than replaced so two vendors differing only in punctuation still differ in
 * their folder names less often than they would collapse onto one. Trailing
 * dots are stripped because SharePoint refuses them on a folder. The empty
 * string is a possible result and the caller refuses it with a message.
 */
export function sanitizeFolderName(name: string): string {
  return name
    .replace(/["*:<>?/\\|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "")
    .trim();
}

export function joinWorkspacePath(...segments: string[]): string {
  return segments
    .flatMap((segment) => segment.split("/"))
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("/");
}
