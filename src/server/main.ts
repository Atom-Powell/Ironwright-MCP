import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { buildServer } from "../mcp/build-server.js";
import { loadGraphCredentials, loadStoreConnectionString } from "../config.js";
import { loadProfileDirectory } from "../profiles/registry.js";
import { createGraphClient } from "../graph/client.js";
import { clientCredentialsTokenProvider } from "../graph/token.js";
import { createMemoryStateStore } from "../store/memory.js";
import { ensureTables, tableStateStoreFromConnectionString } from "../store/table.js";
import { createScanCoordinator } from "../scan/coordinator.js";
import type { StateStore } from "../store/types.js";
import type { ToolContext } from "../tools/context.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const credentials = loadGraphCredentials(process.env);
  const connectionString = loadStoreConnectionString(process.env);

  // Everything that can fail on configuration fails here, before the port is
  // bound, so a container that cannot answer a call never reports itself healthy.
  const profiles = await loadProfileDirectory(config.profileDir);

  let store: StateStore;
  let storeKind: "azure-table" | "in-memory";
  if (connectionString === undefined) {
    store = createMemoryStateStore();
    storeKind = "in-memory";
  } else {
    const table = tableStateStoreFromConnectionString(connectionString);
    await ensureTables(table.clients);
    store = table.store;
    storeKind = "azure-table";
  }

  const graph = createGraphClient({ tokenProvider: clientCredentialsTokenProvider(credentials) });
  const now = (): Date => new Date();

  // Built once and shared by every per-request server. See src/tools/context.ts.
  const context: ToolContext = {
    profiles,
    graph,
    store,
    scans: createScanCoordinator({ client: graph, store, now }),
    now,
  };

  const app = createApp({
    serverFactory: () => buildServer({ allowWrites: config.allowWrites, context }),
  });

  const profileCount = profiles.ids().length;
  const server = app.listen(config.port, () => {
    console.log(
      `listening on port ${config.port}, writes ${config.allowWrites ? "enabled" : "disabled"}, ` +
        `${profileCount} ${profileCount === 1 ? "profile" : "profiles"} from ${config.profileDir}, ` +
        `${storeKind} store`,
    );
  });

  // A bind failure arrives as an event rather than as a rejection, so the catch
  // below cannot see it, and Node's default action for an unhandled "error"
  // event is an uncaught exception. A port already in use is a startup failure
  // like any other and the operator gets the same one-line treatment.
  //
  // The retraction is not defensive padding. A dual-stack listen binds each
  // address family separately, and a run against an occupied port was observed
  // to emit "listening" for the family that bound and only then EADDRINUSE for
  // the one that did not, so the line above really can claim a server that is
  // about to exit. The callback that printed it could not have known; this
  // handler did observe the outcome, so correcting the record is its job.
  server.on("error", (error: Error) => {
    console.error(
      `the server could not listen on port ${config.port}: ${error.message}. ` +
        "Disregard any line above reporting that it is listening: this process is exiting.",
    );
    process.exitCode = 1;
  });

  // Container Apps sends SIGTERM on scale-in and on a revision swap, and Node's
  // default action for it is immediate termination, which drops whatever requests
  // are in flight. Idle keep-alive sockets are closed explicitly because otherwise
  // they hold the server open until their own timeout, well past the platform's
  // grace period, and the process is killed anyway.
  process.on("SIGTERM", () => {
    console.log("received SIGTERM, finishing in-flight requests before exit");
    server.close(() => {
      process.exit(0);
    });
    server.closeIdleConnections();
  });
}

// The whole point of validating configuration and profiles before binding the
// port is that a misconfigured deployment fails fast with something an operator
// can act on. An unhandled top-level rejection would answer that with a raw
// stack trace and throw away the message each loader went to the trouble of
// writing, so the same handler the scan command uses applies here.
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
