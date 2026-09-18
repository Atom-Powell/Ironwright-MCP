import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { buildServer } from "../mcp/build-server.js";
import { loadGraphCredentials, loadGrantedSiteUrl, loadShutdownDeadlineMs, loadStoreConnectionString } from "../config.js";
import { loadProfileDirectory } from "../profiles/registry.js";
import { createGraphClient } from "../graph/client.js";
import { clientCredentialsTokenProvider } from "../graph/token.js";
import { createMemoryStateStore } from "../store/memory.js";
import { ensureTables, tableStateStoreFromConnectionString } from "../store/table.js";
import { createScanCoordinator } from "../scan/coordinator.js";
import type { StateStore } from "../store/types.js";
import type { ToolContext } from "../tools/context.js";

/**
 * The surface `installShutdown` needs from `http.Server`: draining, closing
 * idle sockets, and the connection count read at the deadline. Kept narrow
 * rather than importing `http.Server` itself, so a test can supply a fake
 * without standing up a real socket.
 */
export interface ShutdownServer {
  close(callback: (error?: Error) => void): void;
  closeIdleConnections(): void;
  connections: number;
}

export interface ShutdownDependencies {
  server: ShutdownServer;
  deadlineMs: number;
  exit: (code: number) => void;
  log: (message: string) => void;
}

/**
 * Builds and returns the SIGTERM handler rather than registering it directly,
 * so a test can invoke the returned function and observe what it does without
 * sending a real signal to the test runner's own process. `runReconcile`
 * takes its workbook reader the same way, for the same reason: the dependency
 * that would otherwise be unreachable from a test becomes an argument.
 *
 * The drain (`server.close`'s callback) and the deadline timer race each
 * other. Whichever finishes first exits the process; `settled` stops the
 * other from exiting a second time when it eventually fires too, since
 * `server.close`'s callback still runs once an outstanding request finishes
 * even after the deadline has already exited, and clearing the timer stops it
 * firing once the drain has already exited. Two exits is not just noise: it
 * would race a second `process.exit(0)` against whatever cleanup the first
 * one started.
 */
export function installShutdown({ server, deadlineMs, exit, log }: ShutdownDependencies): () => void {
  return (): void => {
    let settled = false;

    function finish(code: number): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      exit(code);
    }

    log("received SIGTERM, finishing in-flight requests before exit");

    const timer = setTimeout(() => {
      // Read at the moment the deadline actually fires, from the server's own
      // count, rather than a counter this code maintains: a count this code
      // maintains is a count it can get wrong, and a shutdown message that
      // lies about what it abandoned is worse than one that says nothing.
      const outstanding = server.connections;
      log(
        `shutdown deadline of ${deadlineMs}ms reached with ${outstanding} ${
          outstanding === 1 ? "request" : "requests"
        } still in flight, exiting`,
      );
      finish(0);
    }, deadlineMs);

    server.close(() => {
      finish(0);
    });

    // Idle keep-alive sockets are closed explicitly because otherwise they
    // hold the server open until their own timeout, well past the platform's
    // grace period, and the process is killed anyway.
    server.closeIdleConnections();
  };
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const credentials = loadGraphCredentials(process.env);
  const grantedSiteUrl = loadGrantedSiteUrl(process.env);
  const connectionString = loadStoreConnectionString(process.env);
  const shutdownDeadlineMs = loadShutdownDeadlineMs(process.env);

  // Everything that can fail on configuration fails here, before the port is
  // bound, so a container that cannot answer a call never reports itself healthy.
  const profiles = await loadProfileDirectory(config.profileDir, grantedSiteUrl);

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
    grantedSiteUrl,
  };

  const app = createApp({
    serverFactory: () => buildServer({ allowWrites: config.allowWrites, context }),
  });

  const profileCount = profiles.ids().length;
  const server = app.listen(config.port, () => {
    // Express calls this callback on failure as well as on success, so it
    // cannot assume it is being called because the port was bound. Its
    // `app.listen` registers the callback as `server.once("error", done)`
    // alongside the listening handler (express 5.2.1,
    // node_modules/express/lib/application.js:598-606), which is why a plain
    // `http.Server` behaves differently here: against an occupied port a plain
    // server never calls this at all, and express calls it with the error.
    //
    // Measured against an occupied port, `server.listening` is false at this
    // point and true on a real bind, so the callback has an observable for the
    // thing it is about to claim. This is a suppression rather than a
    // retraction on purpose: the line never prints falsely, so there is nothing
    // to take back, and the error handler below is left as the only account of
    // what went wrong.
    if (!server.listening) return;

    console.log(
      `listening on port ${config.port}, site ${grantedSiteUrl}, writes ${config.allowWrites ? "enabled" : "disabled"}, ` +
        `${profileCount} ${profileCount === 1 ? "profile" : "profiles"} from ${config.profileDir}, ` +
        `${storeKind} store`,
    );
  });

  // Without this, a bind failure was silent and the process exited 0: a
  // container that never bound its port reporting success to the platform that
  // was about to route traffic to it. Measured, not inferred. The failure is
  // not an uncaught exception, which is what an unhandled "error" event would
  // normally be, because express has already registered a listener for it by
  // the mechanism described above, and that listener only logs the optimistic
  // line.
  //
  // `server.listening` separates the two kinds of error this one handler sees.
  // Before the bind, an error means the server never started and the process
  // must fail. After it, `net.Server` still emits "error" for accept failures
  // such as EMFILE, and those say nothing about startup: the server did listen,
  // it is still running, and setting `exitCode` there would do nothing but
  // stain a later clean shutdown with a failure that had already been survived.
  server.on("error", (error: Error) => {
    if (server.listening) {
      console.error(`the server hit an error on port ${config.port}: ${error.message}`);
      return;
    }

    console.error(`the server could not listen on port ${config.port}: ${error.message}`);
    process.exitCode = 1;
  });

  // Container Apps sends SIGTERM on scale-in and on a revision swap, and Node's
  // default action for it is immediate termination, which drops whatever requests
  // are in flight. installShutdown bounds the drain to shutdownDeadlineMs so a
  // request that never completes cannot hold the process open past the
  // platform's own grace period.
  process.on("SIGTERM", installShutdown({ server, deadlineMs: shutdownDeadlineMs, exit: process.exit, log: console.log }));
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
