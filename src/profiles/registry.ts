import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadProfile, ProfileValidationError } from "../domain/profile/load.js";
import type { Profile } from "../domain/profile/schema.js";

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

/** One candidate profile, already read. `source` is used only in messages. */
export interface ProfileEntry {
  source: string;
  contents: unknown;
}

export interface ProfileRegistry {
  /** Throws `UnknownProfileError` rather than returning undefined: every caller has to report the same thing. */
  get(profileId: string): Profile;
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
 */
export function createProfileRegistry(entries: readonly ProfileEntry[]): ProfileRegistry {
  const issues: string[] = [];
  const byId = new Map<string, { profile: Profile; source: string }>();

  for (const entry of entries) {
    let profile: Profile;
    try {
      profile = loadProfile(entry.contents);
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
export async function loadProfileDirectory(dir: string): Promise<ProfileRegistry> {
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

  return createProfileRegistry(entries);
}
