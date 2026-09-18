import { createServer, get as httpGet } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { installShutdown, type ShutdownServer } from "../../src/server/shutdown.js";

interface FakeServerOptions {
  closeNeverCompletes?: boolean;
  closeCompletesAfterMs?: number;
}

interface FakeServer extends ShutdownServer {
  idleConnectionsClosed: boolean;
}

/**
 * The shape installShutdown needs from http.Server, faked so the race
 * orderings can be observed without a real socket or a real signal to this
 * process. The fake hands installShutdown no data at all, only timing, which
 * is deliberate: the one thing a fake cannot be trusted with is a value the
 * code under test reads back and reports, and that is exactly how an earlier
 * version of this file hid a count read from a `server.connections` property
 * that does not exist at runtime. Nothing here answers a question; each method
 * only decides when, or whether, a callback fires.
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
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("installShutdown", () => {
  it("exits after the deadline when a request never completes", async () => {
    const server = fakeHttpServer({ closeNeverCompletes: true });
    const exits: number[] = [];
    const logs: string[] = [];

    const shutdown = installShutdown({ server, deadlineMs: 20, exit: (c) => exits.push(c), log: (l) => logs.push(l) });
    shutdown();
    await delay(60);

    expect(exits).toEqual([0]);
    expect(logs.join("\n")).toContain("shutdown deadline of 20ms reached with the drain not complete");
  });

  it("has already logged the deadline line by the moment it calls exit", async () => {
    // In production `exit` is process.exit, which discards the event queue, so
    // a deadline line logged after it, or from any callback scheduled by this
    // handler, is never printed. A previous version was, and printed nothing.
    // Nothing observable distinguishes the two orderings once the dust has
    // settled, so this asserts at the only moment that can tell them apart:
    // inside exit itself, where the log either already carries the line or the
    // operator was never going to see it.
    const server = fakeHttpServer({ closeNeverCompletes: true });
    const logs: string[] = [];
    let logsAtExit: string[] = [];

    installShutdown({
      server,
      deadlineMs: 5,
      exit: () => {
        logsAtExit = [...logs];
      },
      log: (l) => logs.push(l),
    })();
    await delay(30);

    expect(logsAtExit[1]).toContain("shutdown deadline of 5ms reached with the drain not complete");
  });

  it("states no figure for what it abandoned", async () => {
    // Node offers no synchronous count of open sockets, so there is no number
    // this line could have read. It must therefore not carry one, and the
    // deadline value it does print is the only digits allowed through.
    const server = fakeHttpServer({ closeNeverCompletes: true });
    const logs: string[] = [];

    installShutdown({ server, deadlineMs: 20, exit: () => {}, log: (l) => logs.push(l) })();
    await delay(60);

    const deadlineLog = logs[1] ?? "";
    expect(deadlineLog).toContain("drain not complete");
    expect(deadlineLog.replace("20ms", "")).not.toMatch(/\d/);
  });

  it("ignores a second SIGTERM arriving during the drain", async () => {
    // A second invocation used to build a fresh closure whose server.close
    // called back at once with ERR_SERVER_NOT_RUNNING, exiting immediately and
    // abandoning the drain with no deadline line. This asserts the first
    // shutdown still owns the outcome.
    const server = fakeHttpServer({ closeNeverCompletes: true });
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
    const server = fakeHttpServer({ closeCompletesAfterMs: 5 });
    const exits: number[] = [];

    installShutdown({ server, deadlineMs: 5_000, exit: (c) => exits.push(c), log: () => {} })();
    await delay(40);

    expect(exits).toEqual([0]);
  });

  it("exits once when the drain finishes just after the deadline", async () => {
    const server = fakeHttpServer({ closeCompletesAfterMs: 30 });
    const exits: number[] = [];

    installShutdown({ server, deadlineMs: 10, exit: (c) => exits.push(c), log: () => {} })();
    await delay(80);

    expect(exits).toEqual([0]);
  });

  it("closes idle connections so keep-alive sockets do not hold the drain open", () => {
    const server = fakeHttpServer({ closeCompletesAfterMs: 1 });
    installShutdown({ server, deadlineMs: 1_000, exit: () => {}, log: () => {} })();

    expect(server.idleConnectionsClosed).toBe(true);
  });

  it("logs that shutdown began before draining", () => {
    const server = fakeHttpServer({ closeCompletesAfterMs: 1 });
    const logs: string[] = [];

    installShutdown({ server, deadlineMs: 1_000, exit: () => {}, log: (l) => logs.push(l) })();

    expect(logs[0]).toContain("SIGTERM");
  });

  it("reaches the deadline and logs it against an actual http.Server", async () => {
    // Everything above this line runs against a hand-written double, and a
    // double is written by someone with a belief about how http.Server
    // behaves. That is not a hypothetical worry here: this function has
    // shipped two defects, and the double hid both, first by inventing a
    // `connections` field the real API does not have and then by supplying an
    // `exit` that returns where the real one does not. So one case runs
    // against a live server with a genuinely open request, and it is the case
    // that matters: that `close` really does withhold its callback while a
    // request is outstanding, that the deadline therefore really is what ends
    // the process, and that the operator really is told so. This handler never
    // responds, which is what keeps the request open.
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
      // This does not guard ordering: an injected exit that returns lets a line
      // moved back after finish land in this slot anyway, which is exactly what
      // the inside-exit test above catches and this one cannot. What this proves
      // instead is the real subject of this test, that close on a genuine
      // http.Server withholds its callback while a request is outstanding, so
      // the deadline is what ends the process here rather than the drain.
      expect(logs[1]).toContain("shutdown deadline of 20ms reached with the drain not complete");
    } finally {
      request.destroy();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
