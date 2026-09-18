/**
 * The SIGTERM handler lives here rather than in `src/server/main.ts` because
 * `main.ts` calls `main()` at module scope: importing it to reach a value
 * starts the server. A test that wanted `installShutdown` from there bound a
 * port inside the vitest worker, and with `IW_TABLE_CONNECTION_STRING` set it
 * awaited `ensureTables` first and made a real Azure Table call. That was only
 * invisible because a worker with no environment threw in `loadConfig` and the
 * top-level catch set an exit code vitest ignores; running the suite in the
 * deployment shell, which is exactly the shell the merge gate uses, would have
 * done both for real. Extracting the module leaves the entry point with
 * nothing importable and removes the hazard for every future test rather than
 * for the one that found it.
 */

/**
 * The surface `installShutdown` needs from `http.Server`: draining, closing
 * idle sockets, and the connection count read at the deadline. Kept narrow
 * rather than importing `http.Server` itself, so a test can supply a fake
 * without standing up a real socket.
 *
 * `getConnections`, not a `connections` property. A real `net.Server` has no
 * `connections` property at runtime; only `@types/node` still declares one,
 * a stale type left over from an API Node has since removed. Reading
 * `server.connections` in production therefore returned `undefined` while
 * `tsc` agreed it was a `number`, which is exactly how that defect shipped
 * once already: the compiler cannot be trusted here, only the runtime can.
 * Measured directly against `http.createServer()` before writing this.
 */
export interface ShutdownServer {
  close(callback: (error?: Error) => void): void;
  closeIdleConnections(): void;
  getConnections(callback: (error: Error | null, count: number) => void): void;
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
  // Held outside the returned handler so a second signal during the drain is
  // ignored rather than starting a second, independent shutdown. A fresh
  // invocation would call `server.close` on an already-closing server, whose
  // callback fires immediately with ERR_SERVER_NOT_RUNNING, and that closure's
  // own `settled` would let it exit at once: the drain would be abandoned with
  // no deadline line and no explanation. Container Apps sends one SIGTERM, so
  // this has never been observed, but the cost of the guard is a boolean.
  let started = false;

  return (): void => {
    if (started) return;
    started = true;

    let settled = false;

    function finish(code: number): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      exit(code);
    }

    log("received SIGTERM, finishing in-flight requests before exit");

    const timer = setTimeout(() => {
      // The deadline line is logged first, synchronously, because it is the
      // only part of this callback that is guaranteed to reach the operator.
      // The whole reason the deadline exists is that SIGKILL used to end the
      // process with nothing said about why, and a line that depends on an
      // asynchronous callback to be printed reproduces that silence exactly.
      // Measured against a real http.Server, a genuinely open request and the
      // real process.exit: the only output was the SIGTERM line above. No
      // deadline line at all.
      log(`shutdown deadline of ${deadlineMs}ms reached with the drain not complete, exiting`);

      // Exit is committed before anything else is attempted, so the deadline
      // guarantee cannot be lost to a synchronous throw from the call below.
      // A real net.Server cannot throw there, but this ordering removes the
      // class rather than relying on that.
      finish(0);

      // Best-effort enrichment, and honestly labelled as such: under the real
      // process.exit, finish above terminates the process and this line is
      // never reached. getConnections defers its callback through
      // process.nextTick and process.exit does not drain that queue, so the
      // count could never have been printed in production under any ordering.
      // It is kept because an injected exit that returns, which is what every
      // test supplies, still gets the count, and that is what pins the one
      // property that broke before: if a number is printed, it was read from
      // the server rather than invented, defaulted, or left over from a stale
      // count.
      //
      // Connections, not requests. A keep-alive connection can be carrying no
      // request at all or several in sequence, so this is an upper bound on
      // sockets rather than a count of work abandoned, and it says so.
      server.getConnections((error, count) => {
        if (error) return;
        log(
          `at the shutdown deadline ${count} ${count === 1 ? "connection was" : "connections were"} still open`,
        );
      });
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
