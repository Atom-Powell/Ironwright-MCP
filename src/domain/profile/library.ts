import { z } from "zod";
import { type Profile } from "./schema.js";
import { ProfileIdSchema, SiteEntrySchema, normalizeProfileSites, refineIdentityAgreesWithSites } from "./base.js";
import { AssessmentProfileSchema, type AssessmentProfile } from "./assessment.js";
import { ProfileValidationError, loadProfile } from "./load.js";

/**
 * Identity only: the site and the library, and the search region a scan would
 * use. A library profile has no workbook, taxonomy, filename standard or
 * deliverables, so it can be inventoried, queried for empty folders, and
 * reorganized through operator-written plans, and nothing else.
 *
 * `.strict()` so a compliance field on a library profile is refused rather
 * than silently ignored: a profile that looks configured for reconciliation
 * but is not would be read as a promise the server does not keep.
 */
const LibrarySiteEntrySchema = SiteEntrySchema.omit({ workbookPath: true });
const LIBRARY_SITE_KEYS = new Set<string>(Object.keys(LibrarySiteEntrySchema.shape));

export const LibraryProfileSchema = z
  .object({
    kind: z.literal("library"),
    profileId: ProfileIdSchema,
    identity: SiteEntrySchema.omit({ workbookPath: true }).strict(),
    // Passthrough so the loop below, not zod's strict error, names each unknown
    // key at its own path (sites.1.workbookPath), which is where an operator looks.
    sites: z.array(LibrarySiteEntrySchema.passthrough()).min(1),
  })
  .strict()
  .superRefine((profile, ctx) => {
    refineIdentityAgreesWithSites(profile, ctx);
    profile.sites.forEach((site, index) => {
      for (const key of Object.keys(site)) {
        if (LIBRARY_SITE_KEYS.has(key)) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sites", index, key],
          message:
            key === "workbookPath"
              ? "a library profile has no workbook, so a site entry cannot carry a workbookPath"
              : `"${key}" is not a field of a library profile's site entry`,
        });
      }
    });
  });

export type LibraryProfile = z.infer<typeof LibraryProfileSchema>;

export type AnyProfile = (Profile & { kind?: "compliance" }) | LibraryProfile | AssessmentProfile;

export function isLibraryProfile(profile: AnyProfile): profile is LibraryProfile {
  return profile.kind === "library";
}

export function isAssessmentProfile(profile: AnyProfile): profile is AssessmentProfile {
  return profile.kind === "assessment";
}

/**
 * The one entry point for a profile of either kind. An absent `kind` is a
 * compliance profile, so every profile written before kinds existed loads
 * exactly as it did.
 */
export function loadAnyProfile(rawInput: unknown): AnyProfile {
  const input = normalizeProfileSites(rawInput);
  const kind = typeof input === "object" && input !== null ? (input as { kind?: unknown }).kind : undefined;
  if (kind === undefined || kind === "compliance") {
    const { kind: _ignored, ...rest } = input as Record<string, unknown>;
    return loadProfile(rest);
  }
  if (kind === "assessment") {
    const assessment = AssessmentProfileSchema.safeParse(input);
    if (assessment.success) return assessment.data;
    throw new ProfileValidationError(assessment.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  }
  if (kind !== "library") {
    throw new ProfileValidationError([`kind: must be "compliance", "library" or "assessment", not ${JSON.stringify(kind)}`]);
  }
  const result = LibraryProfileSchema.safeParse(input);
  if (result.success) return result.data;
  throw new ProfileValidationError(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
}
