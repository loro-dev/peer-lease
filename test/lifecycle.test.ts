import { describe, expect, it, vi } from "vitest";
import { attachPeerLeaseLifecycle } from "../src/index.js";

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

function createReleaseHandle() {
  let released = false;
  const fn = vi.fn(async () => {
    released = true;
  });

  const handle = Object.assign(fn, {
    release: vi.fn(async () => {
      released = true;
    }),
    isReleased: () => released,
    value: "peer" as const
  });

  return handle;
}

describe("attachPeerLeaseLifecycle", () => {
  it("releases synchronously on pagehide and resumes on pageshow", async () => {
    const target = createEventTarget();
    const release = createReleaseHandle();
    const onResume = vi.fn();

    const stubDoc = {
      frontiers: () => [{ peer: "peer", counter: 1 }]
    } as const;

    const originalDocument = globalThis.document;
    (globalThis as { document?: { visibilityState?: string } }).document = { visibilityState: "visible" };

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
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0][0]).toBe(JSON.stringify(stubDoc.frontiers()));

    target.emit("pageshow");
    expect(onResume).toHaveBeenCalledTimes(1);

    detach();

    target.emit("pagehide");
    expect(release).toHaveBeenCalledTimes(1);

    if (originalDocument) {
      (globalThis as { document?: typeof originalDocument }).document = originalDocument;
    } else {
      delete (globalThis as { document?: unknown }).document;
    }
  });
});
