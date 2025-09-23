import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquirePeerId, resetPeerLeaseState } from "../src/index.js";

const cmpVersion = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

describe("acquirePeerId", () => {
  beforeEach(async () => {
    await resetPeerLeaseState();
  });

  afterEach(async () => {
    await resetPeerLeaseState();
  });

  it("generates a new peer ID when none are cached", async () => {
    const lease = await acquirePeerId(() => "peer-1", "1", cmpVersion);

    expect(lease.value).toBe("peer-1");
    await lease.release("2");
  });

  it("reuses released peer IDs when the caller version has advanced", async () => {
    let counter = 0;
    const genFn = vi.fn(() => `peer-${counter++}`);

    const firstLease = await acquirePeerId(genFn, "1", cmpVersion);
    await firstLease.release("2");

    const secondLease = await acquirePeerId(genFn, "3", cmpVersion);

    expect(secondLease.value).toBe(firstLease.value);
    expect(genFn).toHaveBeenCalledTimes(1);
    await secondLease.release("4");
  });

  it("does not reuse an active peer ID", async () => {
    let counter = 0;
    const genFn = () => `peer-${counter++}`;

    const firstLease = await acquirePeerId(genFn, "10", cmpVersion);
    const secondLease = await acquirePeerId(genFn, "11", cmpVersion);

    expect(secondLease.value).not.toBe(firstLease.value);

    await Promise.all([firstLease.release("12"), secondLease.release("13")]);
  });

  it("treats release as idempotent with the same version", async () => {
    const lease = await acquirePeerId(() => "stable", "1", cmpVersion);

    await lease.release("2");
    await lease.release("2");

    const reused = await acquirePeerId(() => {
      throw new Error("generator should not be called when a cached ID exists");
    }, "3", cmpVersion);

    expect(reused.value).toBe("stable");
    await reused.release("4");
  });

  it("generates a new ID when the version has not advanced", async () => {
    const genFn = vi.fn(() => "generated");

    const lease = await acquirePeerId(() => "seed", "1", cmpVersion);
    await lease.release("2");

    const next = await acquirePeerId(genFn, "2", cmpVersion);

    expect(next.value).toBe("generated");
    expect(genFn).toHaveBeenCalledTimes(1);
    await next.release("3");
  });

  it("throws when the generator returns an empty string", async () => {
    await expect(acquirePeerId(() => "", "1", cmpVersion)).rejects.toThrow(/non-empty/);
  });
});
