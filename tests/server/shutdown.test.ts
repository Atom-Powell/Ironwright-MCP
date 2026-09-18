import { createServer, get as httpGet } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { installShutdown, type ShutdownServer } from "../../src/server/shutdown.js";

interface FakeServerOptions {
  connections: number;
  closeNeverCompletes?: boolean;
  closeCompletesAfterMs?: number;
  getConnectionsFails?: boolean;
  getConnectionsNeverCompletes?: boolean;
}

interface FakeServer extends ShutdownServer {
  idleConnectionsClosed: boolean;
}

/**
 * The shape installShutdown needs from http.Server, faked so the race
 * orderings can be observed without a real socket or a real signal to this
 * process. This fake must not invent anything installShutdown reads back as
 * data (a `connections` count with no runtime equivalent is exactly how the
 * previous version of this file hid the `server.connections` defect): every
 * field here mirrors a real method on `http.Server`, and the one case that
 * actually proves the reported number is real runs against a live
 * `http.createServer()` below, not this fake.
 */
function fakeHttpServer(options: FakeServerOptions): FakeServer {
  return {
    idleConnectionsClosed: false,
    close(callback: (error?: Error) => void): void {
      if (options.closeNeverCompletes) return;
      setTimeout(() => callback(), options.closeCompletesAfterMs ?? 0);
    },
    closeIdleConnections(): void {
      this.idleConnectionsClosed = true;
    },
    getConnections(callback: (error: Error | null, count: number) => void): void {
      // Real getConnections defers its callback rather than calling back
      // inline; mirrored here so a test cannot pass only because the fake
      // happened to resolve synchronously where the real server does not.
      if (options.getConnectionsNeverCompletes) return;
      setTimeout(() => {
        if (options.getConnectionsFails) {
          callback(new Error("boom"), 0);
          return;
        }
        callback(null, options.connections);
      }, 0);
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("installShutdown", () => {
  it("exits after the deadline when a request never completes", async () => {
    const server = fakeHttpServer({ closeNeverCompletes: true, connections: 1 });
    const exits: number[] = [];
    const logs: string[] = [];

    const shutdown = installShutdown({ server, deadlineMs: 20, exit: (c) => exits.push(c), log: (l) => logs.push(l) });
    shutdown();
    await delay(60);

    expect(exits).toEqual([0]);
    expect(logs.join("\n")).toContain("shutdown deadline of 20ms reached with the drain not complete");
    expect(logs.join("\n")).toContain("1 connection was still open");
  });

  it("names the count in the plural when more than one connection is open", async () => {
    const server = fakeHttpServer({ closeNeverCompletes: true, connections: 3 });
    const logs: string[] = [];

    installShutdown({ server, deadlineMs: 20, exit: () => {}, log: (l) => logs.push(l) })();
    await delay(60);

    expect(logs.join("\n")).toContain("3 connections were still open");
  });

  it("logs the deadline line synchronously, before the count is even requested", async () => {
    // The production exit terminates the process inside the timer callback, so
    // a deadline line that waits on anything asynchronous is never printed at
    // all. This pins the ordering that makes the line survive: it is already on
    // the log when the callback has yielded nothing else.
    const server = fakeHttpServer({ closeNeverCompletes: true, connections: 1, getConnectionsNeverCompletes: true });
    const logs: string[] = [];

    installShutdown({ server, deadlineMs: 5, exit: () => {}, log: (l) => logs.push(l) })();
    await delay(30);

    expect(logs[1]).toContain("shutdown deadline of 5ms reached with the drain not complete");
  });

  it("ignores a second SIGTERM arriving during the drain", async () => {
    // A second invocation used to build a fresh closure whose server.close
    // called back at once with ERR_SERVER_NOT_RUNNING, exiting immediately and
    // abandoning the drain with no deadline line. This asserts the first
    // shutdown still owns the outcome.
    const server = fakeHttpServer({ closeNeverCompletes: true, connections: 1 });
    const exits: number[] = [];
    const logs: string[] = [];

    const shutdown = installShutdown({ server, deadlineMs: 30, exit: (c) => exits.push(c), log: (l) => logs.push(l) });
    shutdown();
    shutdown();

    expect(exits).toEqual([]);
    expect(logs.filter((l) => l.includes("SIGTERM"))).toHaveLength(1);

    await delay(80);
    expect(exits).toEqual([0]);
  });

  it("exits as soon as the drain finishes, without waiting for the deadline", async () => {
    const server = fakeHttpServer({ closeCompletesAfterMs: 5, connections: 0 });
    const exits: number[] = [];

    installShutdown({ server, deadlineMs: 5_000, exit: (c) => exits.push(c), log: () => {} })();
    await delay(40);

    expect(exits).toEqual([0]);
  });

  it("exits once when the drain finishes just after the deadline", async () => {
    const server = fakeHttpServer({ closeCompletesAfterMs: 30, connections: 1 });
    const exits: number[] = [];

    installShutdown({ server, deadlineMs: 10, exit: (c) => exits.push(c), log: () => {} })();
    await delay(80);

    expect(exits).toEqual([0]);
  });

  it("closes idle connections so keep-alive sockets do not hold the drain open", () => {
    const server = fakeHttpServer({ closeCompletesAfterMs: 1, connections: 0 });
    installShutdown({ server, deadlineMs: 1_000, exit: () => {}, log: () => {} })();

    expect(server.idleConnectionsClosed).toBe(true);
  });

  it("logs that shutdown began before draining", () => {
    const server = fakeHttpServer({ closeCompletesAfterMs: 1, connections: 0 });
    const logs: string[] = [];

    installShutdown({ server, deadlineMs: 1_000, exit: () => {}, log: (l) => logs.push(l) })();

    expect(logs[0]).toContain("SIGTERM");
  });

  it("reports no figure, rather than a wrong one, when the connection count cannot be read", async () => {
    const server = fakeHttpServer({ closeNeverCompletes: true, connections: 1, getConnectionsFails: true });
    const logs: string[] = [];

    installShutdown({ server, deadlineMs: 20, exit: () => {}, log: (l) => logs.push(l) })();
    await delay(60);

    const deadlineLog = logs.join("\n");
    expect(deadlineLog).toContain("drain not complete");
    expect(deadlineLog).not.toMatch(/\d+ connections?/);
  });

  it("exits exactly once even when getConnections never calls back", async () => {
    const server = fakeHttpServer({ closeNeverCompletes: true, connections: 1, getConnectionsNeverCompletes: true });
    const exits: number[] = [];

    installShutdown({ server, deadlineMs: 20, exit: (c) => exits.push(c), log: () => {} })();
    await delay(60);

    // The count that never arrived must not have held exit open: a shutdown
    // path that waits on this callback before exiting has reintroduced the
    // hang the deadline exists to remove.
    expect(exits).toEqual([0]);
  });

  it("reports a real connection count from an actual http.Server", async () => {
    // The defect this guards against only exists on a real server: a fake
    // that invents its own connection count cannot fail the way
    // `server.connections` failed, which read `undefined` at runtime while
    // `@types/node` still typed it as a number. Only a live `http.Server`
    // can prove the number installShutdown reports was actually obtained
    // from the server rather than echoed from a double, so this handler
    // never responds, and a real request is left open against it, the same
    // shape as "a request that never completes" in the fake-backed test
    // above.
    const httpServer = createServer(() => {
      // No response: the request, and the connection carrying it, stay open
      // until the test destroys it below.
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const address = httpServer.address() as AddressInfo;

    const request = httpGet({ host: "127.0.0.1", port: address.port, path: "/" });
    // Destroying the request below to end the test intentionally severs the
    // connection mid-request; without this listener that surfaces as an
    // unhandled "socket hang up" rather than the expected, deliberate abort.
    request.on("error", () => {});
    await new Promise<void>((resolve) => {
      request.once("socket", (socket) => socket.once("connect", resolve));
    });

    try {
      const exits: number[] = [];
      const logs: string[] = [];
      installShutdown({
        server: httpServer,
        deadlineMs: 20,
        exit: (c) => exits.push(c),
        log: (l) => logs.push(l),
      })();
      await delay(80);

      expect(exits).toEqual([0]);
      // Both halves of the deadline output. The first sentence is the one that
      // must survive a real process.exit and is logged synchronously for that
      // reason; the count only ever reaches an exit that returns, which is what
      // this test supplies, and it is here to prove the number was read from a
      // real server rather than invented by a double.
      expect(logs[1]).toContain("shutdown deadline of 20ms reached with the drain not complete");
      expect(logs.join("\n")).toContain("1 connection was still open");
    } finally {
      request.destroy();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
