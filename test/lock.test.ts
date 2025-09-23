import { describe, expect, it } from "vitest";
import { LocalStorageMutex, MemoryStorage } from "../src/lock.js";

const BASE_OPTIONS = {
  lockTtlMs: 200,
  acquireTimeoutMs: 100,
  retryDelayMs: 5,
  retryJitterMs: 0,
  heartbeatIntervalFraction: 0.5
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("LocalStorageMutex", () => {
  it("serializes critical sections", async () => {
    const storage = new MemoryStorage();
    const mutex = new LocalStorageMutex({
      storage,
      key: "test:lock",
      fenceKey: "test:fence",
      channelName: "test:channel",
      options: BASE_OPTIONS
    });

    const events: string[] = [];

    const first = mutex.runExclusive(async () => {
      events.push("first:start");
      await sleep(20);
      events.push("first:end");
    });

    let secondStarted = false;
    const second = mutex.runExclusive(async () => {
      secondStarted = true;
      events.push("second:start");
      await sleep(5);
      events.push("second:end");
    });

    // Give the second contender a chance to try to acquire the lock.
    await sleep(10);
    expect(secondStarted).toBe(false);
    expect(events).toEqual(["first:start"]);

    await first;
    await second;

    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end"
    ]);
  });

  it("times out if the lock remains held", async () => {
    const storage = new MemoryStorage();
    const mutex = new LocalStorageMutex({
      storage,
      key: "timeout:lock",
      fenceKey: "timeout:fence",
      channelName: "timeout:channel",
      options: {
        ...BASE_OPTIONS,
        acquireTimeoutMs: 30
      }
    });

    const holder = mutex.runExclusive(async () => {
      await sleep(50);
    });

    await sleep(5);

    await expect(
      mutex.runExclusive(async () => {
        // no-op
      })
    ).rejects.toThrow(/Timed out/);

    await holder;
  });
});
