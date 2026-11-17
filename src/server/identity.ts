import { UnexpectedTokenRolesError, type TokenProvider } from "../graph/token.js";

/** How long startup waits for the first token before it stops waiting. */
export const STARTUP_TOKEN_TIMEOUT_MS = 15_000;

const TIMED_OUT = Symbol("timed out");

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
 *
 * The wait is bounded. A token endpoint that accepts the connection and never
 * answers would otherwise hold startup open for as long as fetch allows, and a
 * platform's startup probe would restart the server for a reason no log line
 * names. A wait that runs out is the same outcome as a token that could not be
 * obtained: a warning, and the check runs on first use.
 */
export async function checkStartupIdentity(
  provider: TokenProvider,
  log: (line: string) => void,
  timeoutMs: number = STARTUP_TOKEN_TIMEOUT_MS,
): Promise<"verified" | "skipped"> {
  let timer: NodeJS.Timeout | undefined;
  const attempt = provider.getToken();
  try {
    const outcome = await Promise.race([
      attempt,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (outcome !== TIMED_OUT) return "verified";
    // The request is still out. Whatever it does later belongs to nobody, and an unhandled
    // rejection would end the process this function just decided to let start.
    attempt.catch(() => undefined);
    log(
      `warning: the token endpoint did not answer within ${timeoutMs} ms at startup, so the check that the Graph token ` +
        "carries only Sites.Selected was skipped and will run on first use.",
    );
    return "skipped";
  } catch (error) {
    if (error instanceof UnexpectedTokenRolesError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    log(
      `warning: could not obtain a Graph token at startup, so the check that it carries only Sites.Selected ` +
        `was skipped and will run on first use. ${detail}`,
    );
    return "skipped";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
