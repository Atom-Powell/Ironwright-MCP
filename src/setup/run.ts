import type { SetupGraph } from "./adapter.js";
import {
  buildAppRegistrationRequest,
  buildSitePermissionRequest,
  interpretVerification,
  siteIdPathFromUrl,
  type VerificationOutcome,
} from "./steps.js";

export interface SetupArgs {
  displayName: string;
  siteUrl: string;
  write: boolean;
}

export interface SetupResult {
  appId: string;
  objectId: string;
  secret: string;
  siteId: string;
}

export class SetupFailedError extends Error {
  readonly outcome: Extract<VerificationOutcome, { ok: false }>;

  constructor(outcome: Extract<VerificationOutcome, { ok: false }>) {
    super(outcome.message);
    this.name = "SetupFailedError";
    this.outcome = outcome;
  }
}

export async function runSetup(graph: SetupGraph, args: SetupArgs): Promise<SetupResult> {
  const { objectId, appId } = await graph.createApplication(buildAppRegistrationRequest(args.displayName));
  const { secretText } = await graph.addPassword(objectId);
  const { siteId } = await graph.resolveSite(siteIdPathFromUrl(args.siteUrl));

  await graph.grantSitePermission(
    siteId,
    buildSitePermissionRequest({ appId, appDisplayName: args.displayName, write: args.write }),
  );

  const verification = await graph.verifyAppAccess({ appId, secret: secretText, siteId });
  const outcome = interpretVerification(verification.status, verification.body);
  if (!outcome.ok) throw new SetupFailedError(outcome);

  return { appId, objectId, secret: secretText, siteId };
}
