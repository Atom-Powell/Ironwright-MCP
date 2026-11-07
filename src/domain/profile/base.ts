import { z } from "zod";

/**
 * What every profile kind shares. A profile addresses a set of sites rather
 * than one: the compliance and library domains use a one-entry set today, and
 * the CPA practice domain, one site per client, is why the shape is settled
 * now rather than retrofitted. `clientId` exists for that case, where the
 * client is the site rather than a folder segment.
 *
 * `identity` is kept as the first site so the eighteen places that read
 * `profile.identity` stay as they are. `normalizeProfileSites` makes the two
 * agree before any schema runs.
 */
export const PROFILE_KINDS = ["compliance", "library", "assessment"] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

export const ProfileIdSchema = z.string().min(1).regex(/^[a-z0-9-]+$/, "must be lowercase letters, digits, and hyphens");

export const SiteEntrySchema = z.object({
  siteUrl: z.string().url(),
  library: z.string().min(1),
  /**
   * The Microsoft Search region, such as "NAM". Required by Graph on any search
   * issued with an application permission, and there is no discovery call this
   * project has verified, so it is configured rather than detected. Optional:
   * when absent the cross-check is skipped and the report says that is why.
   */
  searchRegion: z.string().min(1).optional(),
  /** The customer's own id for the client this site belongs to, when the client is the site. */
  clientId: z.string().min(1).optional(),
  /** Library-relative path of the tracking workbook. Required on every site of a compliance profile, refused on a library profile. */
  workbookPath: z.string().startsWith("/").optional(),
});
export type SiteEntry = z.infer<typeof SiteEntrySchema>;

export const SitesSchema = z.array(SiteEntrySchema).min(1);

/**
 * Accepts the legacy single `identity`, the new `sites` list, or both, and
 * returns an object carrying both so one schema shape serves every profile
 * ever written. Pure and tolerant: anything that is not a plain object is
 * returned untouched for the schema to reject with its own message. When
 * both are present and disagree, both are left in place and the schema's
 * superRefine reports it, so the message names the path of the mismatch.
 */
export function normalizeProfileSites(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  const hasIdentity = record.identity !== undefined;
  // Presence, not array-ness: a malformed `sites` must reach the schema and be refused, never be overwritten.
  const hasSites = record.sites !== undefined;
  if (hasIdentity && !hasSites) return { ...record, sites: [record.identity] };
  if (!hasIdentity && hasSites) return { ...record, identity: Array.isArray(record.sites) ? record.sites[0] : undefined };
  return record;
}

/**
 * Field by field, not by serializing: zod emits keys in schema declaration
 * order and the identity and site-entry schemas need not declare them in the
 * same order. The field list must be updated by hand when SiteEntrySchema gains a field.
 */
function sameSiteEntry(a: SiteEntry, b: SiteEntry): boolean {
  return (
    a.siteUrl === b.siteUrl &&
    a.library === b.library &&
    a.workbookPath === b.workbookPath &&
    a.searchRegion === b.searchRegion &&
    a.clientId === b.clientId
  );
}

/** The superRefine every kind runs: identity and sites[0] must be the same entry. */
export function refineIdentityAgreesWithSites(profile: { identity: SiteEntry; sites: SiteEntry[] }, ctx: z.RefinementCtx): void {
  const first = profile.sites[0];
  if (first === undefined || !sameSiteEntry(profile.identity, first)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["identity"],
      message: "identity must equal sites[0]; write the profile with sites only, or make the two agree",
    });
  }
}
