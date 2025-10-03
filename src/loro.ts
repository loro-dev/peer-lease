import type { LoroDoc, PeerID } from "loro-crdt";
import { acquirePeerId, PeerIdLease } from "./peer-lease.js";

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
export type LoroPeerIdReleaseHandle = {
  release: () => Promise<void>;
  isReleased: () => boolean;
  value: PeerID;
};

export async function tryReuseLoroPeerId(
  docId: string,
  doc: LoroDoc,
): Promise<LoroPeerIdReleaseHandle> {
  if (!isNonEmptyString(docId)) {
    throw new TypeError("tryReuseLoroPeerId expects a non-empty docId string");
  }

  if (!doc || typeof doc !== "object") {
    throw new TypeError("tryReuseLoroPeerId expects a LoroDoc instance");
  }

  const lease = await acquirePeerId(
    docId,
    () => doc.peerIdStr,
    peer => doc.version().get(peer as PeerID)?.toString() ?? "0",
    (left, right) => {
      return parseInt(left) - parseInt(right)
    },
  );

  doc.setPeerId(lease.value as PeerID);
  return createReleaseHandle(doc, lease);
}

function createReleaseHandle(doc: LoroDoc, lease: PeerIdLease): LoroPeerIdReleaseHandle {
  let version = doc.version().get(lease.value as PeerID)?.toString() ?? "0";

  const unsub = doc.subscribeLocalUpdates(() => {
    version = doc.version().get(lease.value as PeerID)?.toString() ?? "0";
  });

  const releaseAsync = (): Promise<void> => {
    unsub();
    return lease.release(version);
  };

  return {
    release: releaseAsync,
    isReleased: () => lease.isReleased(),
    value: lease.value as PeerID
  }
}


function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
