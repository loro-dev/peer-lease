import { describe, expect, it, vi } from "vitest";
import type { LoroDoc } from "loro-crdt";
import { attachPeerLeaseLifecycle } from "../src/index.js";
import type { LoroPeerIdReleaseHandle } from "../src/index.js";

interface ListenerEntry {
  type: string;
  listener: (event: { persisted?: boolean }) => void;
}

function createEventTarget() {
  const listeners: ListenerEntry[] = [];
  return {
    addEventListener(type: string, listener: (event: { persisted?: boolean }) => void) {
      listeners.push({ type, listener });
    },
    removeEventListener(type: string, listener: (event: { persisted?: boolean }) => void) {
      const index = listeners.findIndex((entry) => entry.type === type && entry.listener === listener);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    },
    emit(type: string, event: { persisted?: boolean } = {}) {
      for (const entry of Array.from(listeners)) {
        if (entry.type === type) {
          entry.listener(event);
        }
      }
    }
  };
}

type VitestMock = ReturnType<typeof vi.fn>;

function createReleaseHandle(): LoroPeerIdReleaseHandle {
  let released = false;
  const fn = vi.fn(async () => {
    released = true;
  });

  const handle = fn as unknown as LoroPeerIdReleaseHandle;

  handle.release = vi.fn(async () => {
    released = true;
  }) as LoroPeerIdReleaseHandle["release"];
  handle.isReleased = () => released;
  handle.value = "1" as LoroPeerIdReleaseHandle["value"];

  return handle;
}

describe("attachPeerLeaseLifecycle", () => {
  it("releases synchronously on pagehide and resumes on pageshow", async () => {
    const target = createEventTarget();
    const release = createReleaseHandle();
    const releaseMock = release as unknown as VitestMock;
    const onResume = vi.fn();

    const frontiers: ReturnType<LoroDoc["frontiers"]> = [
      { peer: "1" as `${number}`, counter: 1 },
    ];
    const stubDoc: Pick<LoroDoc, "frontiers"> = {
      frontiers: () => frontiers,
    };

    const originalDocument = globalThis.document;
    (globalThis as unknown as { document?: { visibilityState?: string } }).document = {
      visibilityState: "visible",
    };

    const detach = attachPeerLeaseLifecycle({
      release,
      doc: stubDoc,
      onResume,
      target: target as unknown as {
        addEventListener: typeof target.addEventListener;
        removeEventListener: typeof target.removeEventListener;
      }
    });

    (globalThis.document as { visibilityState: string }).visibilityState = "hidden";
    target.emit("visibilitychange");

    target.emit("pagehide");
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(releaseMock.mock.calls[0][0]).toBe(JSON.stringify(stubDoc.frontiers()));

    target.emit("pageshow");
    expect(onResume).toHaveBeenCalledTimes(1);

    detach();

    target.emit("pagehide");
    expect(releaseMock).toHaveBeenCalledTimes(1);

    if (originalDocument) {
      (globalThis as unknown as { document?: typeof originalDocument }).document = originalDocument;
    } else {
      delete (globalThis as unknown as { document?: unknown }).document;
    }
  });

  it("attaches visibility listeners to document by default", () => {
    const release = createReleaseHandle();
    const globalAdd = vi.fn();
    const globalRemove = vi.fn();
    const docAdd = vi.fn();
    const docRemove = vi.fn();

    const originalDocument = globalThis.document;
    const globalOverride = globalThis as unknown as {
      addEventListener?: typeof globalAdd;
      removeEventListener?: typeof globalRemove;
      document?: {
        addEventListener: typeof docAdd;
        removeEventListener: typeof docRemove;
        visibilityState: string;
      };
    };
    const originalGlobalAdd = globalOverride.addEventListener;
    const originalGlobalRemove = globalOverride.removeEventListener;

    globalOverride.addEventListener = globalAdd;
    globalOverride.removeEventListener = globalRemove;

    globalOverride.document = {
      addEventListener: docAdd,
      removeEventListener: docRemove,
      visibilityState: "visible",
    };

    try {
      const emptyFrontiers: ReturnType<LoroDoc["frontiers"]> = [];

      const detach = attachPeerLeaseLifecycle({
        release,
        doc: {
          frontiers: () => emptyFrontiers,
        },
      });

      expect(globalAdd).toHaveBeenCalledWith("pagehide", expect.any(Function));
      expect(globalAdd).toHaveBeenCalledWith("pageshow", expect.any(Function));
      expect(docAdd).toHaveBeenCalledWith("visibilitychange", expect.any(Function));

      detach();

      expect(docRemove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    } finally {
      if (originalGlobalAdd) {
        globalOverride.addEventListener = originalGlobalAdd;
      } else {
        delete globalOverride.addEventListener;
      }

      if (originalGlobalRemove) {
        globalOverride.removeEventListener = originalGlobalRemove;
      } else {
        delete globalOverride.removeEventListener;
      }

      if (originalDocument) {
        (globalThis as unknown as { document?: typeof originalDocument }).document = originalDocument;
      } else {
        delete (globalThis as unknown as { document?: unknown }).document;
      }
    }
  });
});
