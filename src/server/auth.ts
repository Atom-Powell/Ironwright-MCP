import { timingSafeEqual } from "node:crypto";
import type express from "express";

/**
 * The server's own front door. It exists because the product is self-hosted
 * behind whatever ingress the customer chooses, and a tunnel terminates TLS
 * and nothing else, so nothing in front of this process can be relied on to
 * have checked a credential. Lifted from the Copilot Studio probe server,
 * which now uses this implementation rather than its own copy.
 *
 * Two modes carry the same shared key, because Copilot Studio's add-tool
 * dialog offers one or the other depending on probe A3's answer. Mode none
 * exists for loopback development only and the loader makes an operator say
 * so in the environment.
 */
export type InboundAuthMode = "apikey" | "bearer" | "none";

export interface InboundAuthConfig {
  mode: InboundAuthMode;
  key?: string;
  header: string;
}

export const MIN_INBOUND_KEY_LENGTH = 16;

function keysMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on unequal lengths, and a length difference is
  // itself a rejection, so check it first rather than catching.
  return a.length === b.length && timingSafeEqual(a, b);
}

function suppliedKey(req: express.Request, config: InboundAuthConfig): string | undefined {
  if (config.mode === "apikey") {
    const value = req.header(config.header);
    return value === undefined || value === "" ? undefined : value;
  }
  if (config.mode === "bearer") {
    const header = req.header("authorization");
    const match = header === undefined ? null : /^Bearer (.+)$/i.exec(header);
    return match?.[1];
  }
  return undefined;
}

/** Presence only, for a trace. The value of a credential is never recorded. */
export function credentialPresent(req: express.Request, config: InboundAuthConfig): boolean | null {
  return config.mode === "none" ? null : suppliedKey(req, config) !== undefined;
}

export function inboundAuthMiddleware(config: InboundAuthConfig): express.RequestHandler {
  if (config.mode !== "none" && (config.key === undefined || config.key.length < MIN_INBOUND_KEY_LENGTH)) {
    throw new Error(`inbound authentication needs a key of at least ${MIN_INBOUND_KEY_LENGTH} characters unless the mode is none`);
  }
  return (req, res, next) => {
    if (config.mode === "none") {
      next();
      return;
    }
    const supplied = suppliedKey(req, config);
    if (supplied !== undefined && keysMatch(supplied, config.key as string)) {
      next();
      return;
    }
    if (config.mode === "bearer") res.setHeader("WWW-Authenticate", "Bearer");
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized." }, id: null });
  };
}
