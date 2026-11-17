import { z } from "zod";
import { type Profile } from "./schema.js";
import { ProfileIdSchema, SiteEntrySchema, refineIdentityAgreesWithSites } from "./base.js";
import type { AssessmentProfile } from "./assessment.js";

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
