import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProfileValidationError } from "../domain/profile/load.js";
import type { Profile } from "../domain/profile/schema.js";
import { isLibraryProfile, type AnyProfile } from "../domain/profile/library.js";
import { normalizeProfileSites } from "../domain/profile/base.js";
import { ALL_MODULES, moduleForKind, type DomainModule } from "../modules/index.js";

/**
 * A profile directory this server cannot start with. Every problem found in
 * the directory is reported in one message rather than the first one only,
 * for the reason `loadGraphCredentials` gives about environment variables: an
 * operator fixing a deployment they did not build should not pay one failed
 * start per mistake.
 */
export class ProfileRegistryError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`the profile directory cannot be loaded:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ProfileRegistryError";
    this.issues = issues;
  }
}

/**
 * Names the ids that are configured. Profile ids are deployment names rather
 * than secrets, and an agent told which ids exist corrects itself in one turn
 * instead of guessing at a second wrong one.
 */
export class UnknownProfileError extends Error {
  readonly profileId: string;
  readonly configured: string[];

  constructor(profileId: string, configured: string[]) {
    super(
      `No profile named "${profileId}" is configured. ` +
        (configured.length === 0
          ? "This server has no profiles at all, which means it was started against an empty profile directory."
          : `The configured ${configured.length === 1 ? "profile is" : "profiles are"}: ${configured
              .map((id) => `"${id}"`)
              .join(", ")}.`),
    );
    this.name = "UnknownProfileError";
    this.profileId = profileId;
    this.configured = configured;
  }
}

/**
 * A tool that needs a compliance definition was handed a library-only
 * profile. Every such tool resolves its profile before its first Graph
 * request, so in practice nothing has been read; the message does not claim
 * that, because this class cannot observe where its caller was. A
 * reconciliation or structure check over a profile with no expected state
 * would report every client as compliant, a result the server did not observe.
 */
export class LibraryProfileError extends Error {
  readonly profileId: string;

  constructor(profileId: string) {
    super(
      `Profile "${profileId}" is library-only: it names a site and a library but no tracking workbook, ` +
        "taxonomy or filename standard, so this tool, which needs them, cannot run against it. inventory_tree, " +
        "query_repository's empty_folders question, and the custom plan tools work with a library-only profile.",
    );
    this.name = "LibraryProfileError";
    this.profileId = profileId;
  }
}

/**
 * Validates with the module that owns the profile's kind. An absent kind means
 * compliance, the default every profile written before kinds existed relies on.
 */
function loadThroughModule(contents: unknown, modules: readonly DomainModule[]): AnyProfile {
  const normalized = normalizeProfileSites(contents);
  const kind =
    typeof normalized === "object" && normalized !== null ? ((normalized as { kind?: unknown }).kind ?? "compliance") : "compliance";
  const module = moduleForKind(String(kind), modules);
  if (module === undefined) {
    throw new ProfileValidationError([
      `kind "${String(kind)}" is not one this server has a module for; the configured kinds are ${modules.map((m) => `"${m.kind}"`).join(", ")}`,
    ]);
  }
  const result = module.profileSchema.safeParse(normalized);
  if (result.success) return result.data as AnyProfile;
  throw new ProfileValidationError(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
}

/** One candidate profile, already read. `source` is used only in messages. */
export interface ProfileEntry {
  source: string;
  contents: unknown;
}

/**
 * Compares two site URLs the way an operator means them, not the way a
 * literal string comparison would. A trailing slash and a difference in case
 * are both ordinary: an operator pastes a site URL from a browser address bar,
 * and neither of those differences names a different site, so both are
 * normalized away before comparing.
 *
 * Nothing beyond that is normalized. A different path segment, a different
 * host, or a different scheme is left significant, because each of those can
 * be a genuinely different site, and folding any of them away would let a
 * misconfigured profile pass this check instead of being caught by it.
 */
function sameSite(a: string, b: string): boolean {
  const normalize = (value: string): string => value.trim().replace(/\/+$/, "").toLowerCase();
  return normalize(a) === normalize(b);
}

export interface ProfileRegistry {
  /**
   * Throws `UnknownProfileError` rather than returning undefined: every
   * caller has to report the same thing. Also throws `LibraryProfileError`
   * for a profile that carries identity only, since this method's callers
   * need a compliance definition and a library profile has none.
   */
  get(profileId: string): Profile;
  /** Either kind. For the tools that work without a compliance definition. */
  getAny(profileId: string): AnyProfile;
  ids(): string[];
}

/**
 * Pure over already-read contents, so every validation rule is testable
 * without a filesystem. `loadProfileDirectory` below is the only part that
 * does I/O, which keeps the untestable half to one function.
 *
 * Indexed by the `profileId` field rather than by the file name, because the
 * file name is not the identity: the report carries `profileId` from the
 * profile itself, so a registry keyed on the file name could answer a call for
 * one profile with a report labeled another.
 *
 * `grantedSiteUrl` is required rather than optional for the same reason it is
 * required in `loadGrantedSiteUrl`: a registry that skipped the check when the
 * value was absent would let a misconfigured deployment start clean and fail
 * later as an unexplained 403. Every profile is checked against it, and a
 * mismatch is reported as one more issue alongside a validation failure,
 * because startup already fails loudly on those and a second failure path
 * would be a second thing an operator has to learn.
 */
export function createProfileRegistry(
  entries: readonly ProfileEntry[],
  grantedSiteUrl: string,
  modules: readonly DomainModule[] = ALL_MODULES,
): ProfileRegistry {
  const issues: string[] = [];
  const byId = new Map<string, { profile: AnyProfile; source: string }>();

  for (const entry of entries) {
    let profile: AnyProfile;
    try {
      profile = loadThroughModule(entry.contents, modules);
    } catch (error) {
      if (!(error instanceof ProfileValidationError)) throw error;
      issues.push(`${entry.source}: ${error.issues.join("; ")}`);
      continue;
    }

    const held = byId.get(profile.profileId);
    if (held !== undefined) {
      issues.push(
        `${entry.source} and ${held.source} both declare profileId "${profile.profileId}". ` +
          "A profile id names one deployment target, so which of the two a call would reach is undecidable.",
      );
      continue;
    }

    const foreign = profile.sites.findIndex((site) => !sameSite(site.siteUrl, grantedSiteUrl));
    if (foreign >= 0) {
      issues.push(
        `${entry.source}: profile "${profile.profileId}" sites[${foreign}] names site ${profile.sites[foreign]!.siteUrl}, but this ` +
          `server's Sites.Selected grant covers ${grantedSiteUrl}. A profile pointed at a site the grant does ` +
          "not cover would fail as a 403 on its first Graph call rather than at startup.",
      );
      continue;
    }

    byId.set(profile.profileId, { profile, source: entry.source });
  }

  if (entries.length === 0) {
    issues.push("the directory contains no profile files, so this server could not answer any call");
  }

  if (issues.length > 0) throw new ProfileRegistryError(issues);

  const ids = [...byId.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    ids: () => [...ids],
    get(profileId: string): Profile {
      const held = byId.get(profileId);
      if (held === undefined) throw new UnknownProfileError(profileId, [...ids]);
      if (isLibraryProfile(held.profile)) throw new LibraryProfileError(profileId);
      return held.profile;
    },
    getAny(profileId: string): AnyProfile {
      const held = byId.get(profileId);
      if (held === undefined) throw new UnknownProfileError(profileId, [...ids]);
      return held.profile;
    },
  };
}

/**
 * The only part of this module that touches a filesystem, kept to one function
 * so every rule above is testable without one.
 *
 * Files are read in sorted order so two starts over one directory produce the
 * same message when more than one file is wrong, and a duplicate-id message
 * names the same file first every time.
 *
 * A parse failure names the file. `JSON.parse` reports a character offset and
 * nothing else, which leaves an operator holding a parser message with no way
 * to tell which of several profiles produced it, and the same reasoning already
 * put this wrapper around the scan command's own profile read.
 */
export async function loadProfileDirectory(
  dir: string,
  grantedSiteUrl: string,
  modules: readonly DomainModule[] = ALL_MODULES,
): Promise<ProfileRegistry> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    throw new Error(
      `The profile directory "${dir}" could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Extension match is case sensitive on purpose. A container image is built
  // on a case sensitive filesystem, so accepting ".JSON" here would load a file
  // locally that the deployed server does not see, which is a difference that
  // shows up as a missing profile in production and nowhere else.
  const jsonNames = names.filter((name) => name.endsWith(".json")).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const entries: ProfileEntry[] = [];
  for (const name of jsonNames) {
    const text = await readFile(join(dir, name), "utf8");
    try {
      entries.push({ source: name, contents: JSON.parse(text) as unknown });
    } catch (error) {
      throw new Error(
        `The profile "${name}" in "${dir}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return createProfileRegistry(entries, grantedSiteUrl, modules);
}
