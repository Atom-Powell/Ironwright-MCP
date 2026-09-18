import { describe, expect, it } from "vitest";
import { installShutdown, type ShutdownServer } from "../../src/server/main.js";

interface FakeServerOptions {
  connections: number;
  closeNeverCompletes?: boolean;
  closeCompletesAfterMs?: number;
}

interface FakeServer extends ShutdownServer {
  idleConnectionsClosed: boolean;
}

/**
 * The shape installShutdown needs from http.Server, faked so its behavior can
 * be observed without a real socket or a real signal to this process.
 */
function fakeHttpServer(options: FakeServerOptions): FakeServer {
  return {
    connections: options.connections,
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
    const server = fakeHttpServer({ closeNeverCompletes: true, connections: 1 });
    const exits: number[] = [];
    const logs: string[] = [];

    const shutdown = installShutdown({ server, deadlineMs: 20, exit: (c) => exits.push(c), log: (l) => logs.push(l) });
    shutdown();
    await delay(60);

    expect(exits).toEqual([0]);
    expect(logs.join("\n")).toContain("1 request still in flight");
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
});
