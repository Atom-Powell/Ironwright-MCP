import type { Precondition } from "../../domain/assessment/state.js";

/**
 * The words for a list item write that was not made because its precondition
 * could not be sent or did not hold. One place, because four tools write list
 * items and each must say the same thing about the same answer from Graph.
 *
 * Each function says only what the precondition found. What else the call did
 * or did not write differs by tool and by how far the call had got, so the
 * caller adds that sentence itself.
 *
 * Ruled 2026-11-17, after the probe of the same day (L4a to L4d) showed Graph
 * enforces `If-Match` on a fields PATCH: a tool whose write is refused this
 * way refuses in turn and does not read again and retry. The item changed
 * under a decision the tool had already made, and the caller, not the server,
 * decides whether that decision still stands.
 */

/** An item whose read carried no eTag cannot be written under a precondition, so it is not written. */
export function itemWithoutEtagText(listName: string, itemId: string): string {
  return `${listName} item ${itemId} was read without an ETag, so no If-Match precondition could be sent.`;
}

/** Graph answered 412: the item is no longer the version this call read. */
export function itemChangedText(listName: string, itemId: string, etag: string): string {
  return `${listName} item ${itemId} changed after this call read it: Graph answered 412 to If-Match ${etag}.`;
}

/** The same finding as a refusal, for a tool that had written nothing when it met it. */
export function itemChangedRefusal(listName: string, itemId: string, etag: string): Precondition & { ok: false } {
  return {
    ok: false,
    expected: `${listName} item ${itemId} unchanged since this call read it`,
    observed: `the item changed: Graph answered 412 to If-Match ${etag}`,
    evidence: [{ source: "list", target: `${listName} item ${itemId}`, found: `changed since it was read with eTag ${etag}` }],
  };
}
