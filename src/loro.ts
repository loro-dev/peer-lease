import type { LoroDoc, Frontiers, PeerID } from "loro-crdt";
import { acquirePeerId } from "./peer-lease.js";

/**
 * Try to reuse a previous cached peer id for the given loro doc. This method may or may not assign a new PeerId.
 *
 * You must call the releaseFn when the document is closed to be able to reuse the peer id.
 *
 * You should use this after finishing the initial loading of the doc
 *
 * This will try to reuse the previous peer id cache for this document.
 * @param docId
 * @param doc
 * @returns releaseFn: a function that releases the peer id lease.
 * After releasing, doc will be assigned a new random peer id to avoid conflicts
 */
export async function tryReuseLoroPeerId(
  docId: string,
  doc: LoroDoc,
): Promise<() => void> {
  if (!isNonEmptyString(docId)) {
    throw new TypeError("tryReuseLoroPeerId expects a non-empty docId string");
  }

  if (!doc || typeof doc !== "object") {
    throw new TypeError("tryReuseLoroPeerId expects a LoroDoc instance");
  }

  const initialFrontiers = doc.frontiers();
  const initialVersion = encodeFrontiers(initialFrontiers);

  const lease = await acquirePeerId(
    docId,
    () => doc.peerIdStr,
    initialVersion,
    (left, right) => {
      if (typeof doc.cmpFrontiers !== "function") {
        return undefined;
      }

      try {
        return doc.cmpFrontiers(decodeFrontiers(left), decodeFrontiers(right));
      } catch {
        return undefined;
      }
    },
  );

  doc.setPeerId(lease.value as PeerID);

  return async () => {
    doc.setPeerId(randomU64());
    await lease.release(encodeFrontiers(doc.frontiers()));
  };
}

function randomU64(): PeerID {
  return Math.floor(
    Math.random() * Number.MAX_SAFE_INTEGER,
  ).toString() as PeerID;
}

function encodeFrontiers(frontiers: Frontiers): string {
  return JSON.stringify(frontiers);
}

function decodeFrontiers(serialized: string): Frontiers {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    const result: Frontiers = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const peer = (entry as { peer?: unknown }).peer;
      const counter = (entry as { counter?: unknown }).counter;
      if (typeof peer === "string" && typeof counter === "number") {
        result.push({ peer: peer as PeerID, counter });
      }
    }

    return result;
  } catch {
    return [];
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
