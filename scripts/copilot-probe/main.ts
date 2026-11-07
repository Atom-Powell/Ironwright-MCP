import { randomBytes } from "node:crypto";
import { createProbeApp, type ProbeAuthMode } from "./app.js";

/**
 * Starts the Copilot Studio probe server. See docs/COPILOT-STUDIO-PROBE.md.
 *
 *   PROBE_PORT              default 8787
 *   PROBE_AUTH              apikey (default), bearer, or none
 *   PROBE_API_KEY           at least 16 characters; generated and printed once if unset
 *   PROBE_API_KEY_HEADER    header name in apikey mode, default x-api-key
 *   PROBE_ALLOW_ANONYMOUS   must be 1 to start with PROBE_AUTH=none
 *
 * Binds to loopback only; a dev tunnel reaches it from there. The trace goes to
 * stdout as one JSON object per line, so redirect it to a file to keep it.
 */
function main(): void {
  const authMode = (process.env.PROBE_AUTH ?? "apikey") as ProbeAuthMode;
  if (authMode !== "apikey" && authMode !== "bearer" && authMode !== "none") {
    console.error("PROBE_AUTH must be apikey, bearer or none.");
    process.exit(1);
  }
  if (authMode === "none" && process.env.PROBE_ALLOW_ANONYMOUS !== "1") {
    console.error(
      "Refusing to start without authentication. Set PROBE_ALLOW_ANONYMOUS=1 to confirm that nothing " +
        "reachable through this server is sensitive.",
    );
    process.exit(1);
  }

  const portText = process.env.PROBE_PORT ?? "8787";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`PROBE_PORT must be a port number, got "${portText}".`);
    process.exit(1);
  }

  let apiKey = process.env.PROBE_API_KEY;
  let generated = false;
  if (authMode !== "none" && apiKey === undefined) {
    apiKey = randomBytes(24).toString("hex");
    generated = true;
  }
  const apiKeyHeader = process.env.PROBE_API_KEY_HEADER ?? "x-api-key";

  const app = createProbeApp({
    authMode,
    ...(apiKey === undefined ? {} : { apiKey }),
    apiKeyHeader,
    trace: (record) => process.stdout.write(`${JSON.stringify(record)}\n`),
  });

  app.listen(port, "127.0.0.1", () => {
    // Banner goes to stderr so a redirect of stdout keeps the trace clean.
    console.error(`Copilot probe listening on http://127.0.0.1:${port}/mcp (auth: ${authMode})`);
    if (generated) {
      console.error(
        `Generated key (shown once, copy it now, never paste it into a session): ${apiKey}\n` +
          (authMode === "apikey"
            ? `Send it in the ${apiKeyHeader} header.`
            : "Send it as an Authorization: Bearer header."),
      );
    }
  });
}

main();
