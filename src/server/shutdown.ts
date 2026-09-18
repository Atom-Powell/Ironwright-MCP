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
 * The whole surface `installShutdown` needs from `http.Server`: draining, and
 * closing idle sockets. Kept narrow rather than importing `http.Server`
 * itself, so a test can supply a fake without standing up a real socket, and
 * narrow enough that a fake has almost nothing it could get wrong.
 */
export interface ShutdownServer {
  close(callback: (error?: Error) => void): void;
  closeIdleConnections(): void;
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
      // Logged synchronously and before exit, because that is the only way it
      // reaches the operator at all: this callback ends in process.exit, which
      // discards the event queue rather than draining it, so anything deferred
      // from here is never printed. The whole reason the deadline exists is
      // that SIGKILL used to end the process with nothing said about why, and
      // a line that waits on a callback reproduces that silence exactly. It
      // did: measured against a real http.Server, a genuinely open request and
      // the real process.exit, the only output was the SIGTERM line above.
      log(`shutdown deadline of ${deadlineMs}ms reached with the drain not complete, exiting`);

      // No count of what was abandoned, which is the surprising part, so:
      // Node's only runtime source for the number of open sockets is
      // getConnections, and it answers on a deferred callback that the exit
      // below discards. The number is not obtainable here, by any ordering,
      // and this project does not state a figure it could not read. Reaching
      // for one is what produced both of this function's shipped defects: a
      // `server.connections` property that does not exist at runtime, and then
      // a deadline line buried inside getConnections' callback that never
      // printed. Do not add a count back without a synchronous API to read it
      // from.
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
