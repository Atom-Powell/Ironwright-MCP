import { randomUUID } from "node:crypto";
import type { AssessmentProfile } from "../../domain/profile/assessment.js";
import { isAssessmentProfile } from "../../domain/profile/library.js";
import { resolveDrive } from "../../graph/drive.js";
import type { ToolContext } from "../context.js";

export interface AssessmentContext {
  profile: AssessmentProfile;
  siteId: string;
  driveId: string;
  /** One per tool call, carried on every journal entry it writes and returned to the caller. */
  correlationId: string;
  now: Date;
}

export class NotAnAssessmentProfileError extends Error {
  constructor(profileId: string, kind: string) {
    super(`Profile "${profileId}" is a ${kind} profile; this tool needs an assessment profile, which carries the workspace and the lists.`);
    this.name = "NotAnAssessmentProfileError";
  }
}

/**
 * Two Graph reads per call, the site and its drives, paid by every tool so a
 * profile's library is resolved by name as Graph lists it (measured
 * 2026-11-07: the default library is "Documents", not its URL segment).
 */
export async function resolveAssessmentContext(context: ToolContext, profileId: string): Promise<AssessmentContext> {
  const profile = context.profiles.getAny(profileId);
  if (!isAssessmentProfile(profile)) throw new NotAnAssessmentProfileError(profileId, profile.kind ?? "compliance");
  const location = await resolveDrive(context.graph, profile.identity.siteUrl, profile.identity.library);
  return { profile, siteId: location.siteId, driveId: location.driveId, correlationId: randomUUID(), now: context.now() };
}
