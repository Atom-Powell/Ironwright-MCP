export interface ServerConfig {
  port: number;
  allowWrites: boolean;
  profileDir: string;
}

/**
 * Writes default to disabled. An operator has to opt a deployment in, which is
 * the first of the two independent write gates; the per-call confirm flag is the
 * second. Copilot Studio's DLP granularity is per-server rather than per-tool,
 * so neither gate can be delegated to the platform.
 */
export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const rawPort = env.PORT ?? "3000";
  // Matched before parsing, because parseInt stops at the first character it
  // cannot read: "3000abc" would otherwise start a server on 3000 and give an
  // operator no sign that the value they set was wrong.
  const port = /^\d+$/.test(rawPort) ? Number.parseInt(rawPort, 10) : Number.NaN;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, received "${rawPort}"`);
  }

  // Required, and checked at startup rather than on the first tool call. A
  // profile mistake does not surface as an error: it surfaces as a wrong
  // compliance finding weeks later, which is far more expensive to diagnose
  // than a deployment that refused to start.
  const profileDir = env.IW_PROFILE_DIR?.trim();
  if (profileDir === undefined || profileDir.length === 0) {
    throw new Error(
      "IW_PROFILE_DIR is required: it names the directory holding this deployment's profile files. " +
        "Profiles are deployment configuration and are never committed, so there is no default to fall back to.",
    );
  }

  return { port, allowWrites: env.IW_ALLOW_WRITES === "true", profileDir };
}
