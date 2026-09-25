import { z } from "zod";
import { ProfileSchema, type Profile } from "./schema.js";
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
export const LibraryProfileSchema = z
  .object({
    kind: z.literal("library"),
    profileId: ProfileSchema.innerType().shape.profileId,
    identity: z
      .object({
        siteUrl: z.string().url(),
        library: z.string().min(1),
        searchRegion: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();

export type LibraryProfile = z.infer<typeof LibraryProfileSchema>;

export type AnyProfile = (Profile & { kind?: "compliance" }) | LibraryProfile;

export function isLibraryProfile(profile: AnyProfile): profile is LibraryProfile {
  return profile.kind === "library";
}

/**
 * The one entry point for a profile of either kind. An absent `kind` is a
 * compliance profile, so every profile written before kinds existed loads
 * exactly as it did.
 */
export function loadAnyProfile(input: unknown): AnyProfile {
  const kind = typeof input === "object" && input !== null ? (input as { kind?: unknown }).kind : undefined;
  if (kind === undefined || kind === "compliance") {
    const { kind: _ignored, ...rest } = input as Record<string, unknown>;
    return loadProfile(rest);
  }
  if (kind !== "library") {
    throw new ProfileValidationError([`kind: must be "compliance" or "library", not ${JSON.stringify(kind)}`]);
  }
  const result = LibraryProfileSchema.safeParse(input);
  if (result.success) return result.data;
  throw new ProfileValidationError(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
}
