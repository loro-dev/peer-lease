import type { LoroDoc, Frontiers } from "loro-crdt";
import type { LoroPeerIdReleaseHandle } from "./loro.js";

interface LifecycleEventTarget {
  addEventListener(type: string, listener: (event: PageTransitionEventLike) => void, options?: unknown): void;
  removeEventListener(type: string, listener: (event: PageTransitionEventLike) => void, options?: unknown): void;
}

interface PageTransitionEventLike {
  type?: string;
  persisted?: boolean;
}

interface DocumentLike extends LifecycleEventTarget {
  visibilityState?: string;
}

export interface PeerLeaseLifecycleOptions {
  release: LoroPeerIdReleaseHandle;
  doc: Pick<LoroDoc, "frontiers">;
  onResume?: (event: PageTransitionEventLike) => void | Promise<void>;
  onFreeze?: (event: PageTransitionEventLike) => void | Promise<void>;
  target?: LifecycleEventTarget;
  captureFrontiers?: () => Frontiers | string;
}

export function attachPeerLeaseLifecycle(options: PeerLeaseLifecycleOptions): () => void {
  const { release } = options;
  if (!release || typeof release !== "function") {
    throw new TypeError("attachPeerLeaseLifecycle requires a release handle function");
  }

  const pageTarget = options.target ?? getDefaultLifecycleTarget();
  const visibilityTarget = options.target ?? getDefaultVisibilityTarget();

  if (!pageTarget && !visibilityTarget) {
    return () => {
      /* no-op */
    };
  }

  let stagedVersion: string | undefined;

  const stageFrontiers = (): void => {
    if (stagedVersion || release.isReleased()) {
      return;
    }

    const raw = options.captureFrontiers ? options.captureFrontiers() : options.doc.frontiers();
    stagedVersion = encodeFrontiersInput(raw);
  };

  const handlePageHide = (event: PageTransitionEventLike): void => {
    stageFrontiers();
    const version = stagedVersion ?? encodeFrontiersInput(options.doc.frontiers());
    stagedVersion = version;

    invokeRelease(release, version);

    if (event.persisted && options.onFreeze) {
      options.onFreeze(event);
    }
  };

  const handlePageShow = (event: PageTransitionEventLike): void => {
    stagedVersion = undefined;

    if (release.isReleased() && options.onResume) {
      options.onResume(event);
    }
  };

  const handleVisibilityChange = (_event: PageTransitionEventLike): void => {
    const doc = getDocument();
    if (!doc || doc.visibilityState !== "hidden") {
      return;
    }
    stageFrontiers();
  };

  const detachFns: Array<() => void> = [];

  if (pageTarget) {
    pageTarget.addEventListener("pagehide", handlePageHide);
    pageTarget.addEventListener("pageshow", handlePageShow);
    detachFns.push(() => {
      pageTarget.removeEventListener("pagehide", handlePageHide);
      pageTarget.removeEventListener("pageshow", handlePageShow);
    });
  }

  if (visibilityTarget) {
    visibilityTarget.addEventListener(
      "visibilitychange",
      handleVisibilityChange as (event: PageTransitionEventLike) => void,
    );
    detachFns.push(() => {
      visibilityTarget.removeEventListener(
        "visibilitychange",
        handleVisibilityChange as (event: PageTransitionEventLike) => void,
      );
    });
  }

  return () => {
    for (const detach of detachFns) {
      detach();
    }
  };
}

function getDefaultLifecycleTarget(): LifecycleEventTarget | null {
  const candidate = globalThis as unknown as { addEventListener?: LifecycleEventTarget["addEventListener"]; removeEventListener?: LifecycleEventTarget["removeEventListener"]; };
  if (typeof candidate?.addEventListener !== "function" || typeof candidate?.removeEventListener !== "function") {
    return null;
  }
  return candidate as LifecycleEventTarget;
}

function getDefaultVisibilityTarget(): LifecycleEventTarget | null {
  const doc = getDocument();
  if (
    doc &&
    typeof doc.addEventListener === "function" &&
    typeof doc.removeEventListener === "function"
  ) {
    return doc;
  }
  return getDefaultLifecycleTarget();
}

function encodeFrontiersInput(frontiers: Frontiers | string): string {
  if (typeof frontiers === "string") {
    return frontiers;
  }

  return JSON.stringify(frontiers);
}

function invokeRelease(release: LoroPeerIdReleaseHandle, version: string): void {
  try {
    const result = release(version);
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      (result as Promise<unknown>).catch(() => {
        // Swallow errors in lifecycle handlers; callers can await release() elsewhere to observe failures.
      });
    }
  } catch {
    // Ignore synchronous errors to keep lifecycle handlers resilient.
  }
}

function getDocument(): DocumentLike | null {
  const candidate = (globalThis as { document?: DocumentLike }).document;
  if (!candidate) {
    return null;
  }
  return candidate;
}
