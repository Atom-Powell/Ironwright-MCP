import type { GraphClient } from "./client.js";
import { GraphRequestError } from "./errors.js";

export interface DeltaItem {
  id?: string;
  name?: string;
  size?: number;
  lastModifiedDateTime?: string;
  eTag?: string;
  parentReference?: { path?: string; driveId?: string };
  folder?: Record<string, unknown>;
  file?: Record<string, unknown>;
  root?: Record<string, unknown>;
  deleted?: { state?: string };
}

export interface DeltaPage {
  items: DeltaItem[];
  /** Present only on the final page. Its arrival is how the caller knows the enumeration finished. */
  deltaLink?: string;
}

/**
 * A stored `deltaLink` can age out of the service's change log. Graph answers
 * 410 with `resyncRequired`, and the only correct response is to discard what is
 * stored and enumerate again, which the caller does because only the caller owns
 * the inventory.
 */
export class DeltaResyncRequiredError extends Error {
  constructor(driveId: string) {
    super(
      `The stored deltaLink for drive ${driveId} is no longer valid and Graph asked for a resync. ` +
        "The stored inventory for that drive must be discarded and the drive enumerated from scratch.",
    );
    this.name = "DeltaResyncRequiredError";
  }
}

interface DeltaResponse {
  value?: DeltaItem[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

export async function* deltaPages(
  client: GraphClient,
  driveId: string,
  storedDeltaLink?: string,
): AsyncGenerator<DeltaPage, void, undefined> {
  let url = storedDeltaLink ?? `/drives/${driveId}/root/delta`;

  for (;;) {
    let response: DeltaResponse;
    try {
      response = await client.get<DeltaResponse>(url);
    } catch (error) {
      // Only a stored link can be resynced from. A 410 on a fresh enumeration
      // means something else entirely, and relabeling it would send the caller
      // to clear an inventory that was never the problem.
      if (storedDeltaLink !== undefined && error instanceof GraphRequestError && error.status === 410) {
        throw new DeltaResyncRequiredError(driveId);
      }
      throw error;
    }

    const next = response["@odata.nextLink"];
    const final = response["@odata.deltaLink"];

    if (next === undefined && final === undefined) {
      throw new Error(
        `A delta response for drive ${driveId} carried neither @odata.nextLink nor @odata.deltaLink. ` +
          "Continuing would either loop on the same page or stop with an inventory that is silently incomplete.",
      );
    }

    yield { items: response.value ?? [], ...(final === undefined ? {} : { deltaLink: final }) };

    if (final !== undefined) return;
    url = next as string;
  }
}
