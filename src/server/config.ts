export interface ServerConfig {
  port: number;
  allowWrites: boolean;
}

/**
 * Writes default to disabled. An operator has to opt a deployment in, which is
 * the first of the two independent write gates; the per-call confirm flag is the
 * second. Copilot Studio's DLP granularity is per-server rather than per-tool,
 * so neither gate can be delegated to the platform.
 */
export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const rawPort = env.PORT ?? "3000";
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, received "${rawPort}"`);
  }

  return { port, allowWrites: env.IW_ALLOW_WRITES === "true" };
}
