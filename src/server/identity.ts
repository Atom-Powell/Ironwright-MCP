import { UnexpectedTokenRolesError, type TokenProvider } from "../graph/token.js";

/**
 * Asks for one token before the port is bound, so a deployment whose server
 * application carries the wrong permissions fails at startup with a message
 * rather than looking healthy until its first tool call.
 *
 * Only a role mismatch stops startup. Any other failure to obtain a token is a
 * fact about Entra or the network, not about this deployment's permissions,
 * and refusing to start on it would turn a third party's outage into a restart
 * loop, the failure GET /health is kept free of Graph to avoid. The guard in
 * front of the provider still checks the first token that does arrive.
 */
export async function checkStartupIdentity(
  provider: TokenProvider,
  log: (line: string) => void,
): Promise<"verified" | "skipped"> {
  try {
    await provider.getToken();
    return "verified";
  } catch (error) {
    if (error instanceof UnexpectedTokenRolesError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    log(
      `warning: could not obtain a Graph token at startup, so the check that it carries only Sites.Selected ` +
        `was skipped and will run on first use. ${detail}`,
    );
    return "skipped";
  }
}
