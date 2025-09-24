import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquirePeerId, resetPeerLeaseState } from "../src/index.js";

const cmpVersion = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true });
const DOC_ID = "doc";
const OTHER_DOC_ID = "doc-other";

describe("acquirePeerId", () => {
  beforeEach(async () => {
    await Promise.all([
      resetPeerLeaseState(DOC_ID),
      resetPeerLeaseState(OTHER_DOC_ID),
    ]);
  });

  afterEach(async () => {
    await Promise.all([
      resetPeerLeaseState(DOC_ID),
      resetPeerLeaseState(OTHER_DOC_ID),
    ]);
  });

  it("generates a new peer ID when none are cached", async () => {
    const lease = await acquirePeerId(DOC_ID, () => "peer-1", "1", cmpVersion);

    expect(lease.value).toBe("peer-1");
    await lease.release("2");
  });

  it("reuses released peer IDs when the caller version has advanced", async () => {
    let counter = 0;
    const genFn = vi.fn(() => `peer-${counter++}`);

    const firstLease = await acquirePeerId(DOC_ID, genFn, "1", cmpVersion);
    await firstLease.release("2");

    const secondLease = await acquirePeerId(DOC_ID, genFn, "3", cmpVersion);

    expect(secondLease.value).toBe(firstLease.value);
    expect(genFn).toHaveBeenCalledTimes(1);
    await secondLease.release("4");
  });

  it("does not reuse an active peer ID", async () => {
    let counter = 0;
    const genFn = () => `peer-${counter++}`;

    const firstLease = await acquirePeerId(DOC_ID, genFn, "10", cmpVersion);
    const secondLease = await acquirePeerId(DOC_ID, genFn, "11", cmpVersion);

    expect(secondLease.value).not.toBe(firstLease.value);

    await Promise.all([firstLease.release("12"), secondLease.release("13")]);
  });

  it("throws when release is called more than once", async () => {
    const lease = await acquirePeerId(DOC_ID, () => "stable", "1", cmpVersion);

    await lease.release("2");
    await expect(lease.release("2")).rejects.toThrow(/only be called once/);
  });

  it("rejects release attempts without a version", async () => {
    const lease = await acquirePeerId(DOC_ID, () => "alpha", "1", cmpVersion);

    await expect(lease.release("")).rejects.toThrow(/non-empty version string/);

    await lease.release("2");
  });

  it("does not reuse cached IDs when the comparator returns undefined", async () => {
    let counter = 0;
    const genFn = vi.fn(() => `peer-${counter++}`);

    const lease = await acquirePeerId(DOC_ID, genFn, "1", () => undefined);
    await lease.release("2");

    const next = await acquirePeerId(DOC_ID, genFn, "3", () => undefined);

    expect(next.value).toBe("peer-1");
    expect(genFn).toHaveBeenCalledTimes(2);
    await next.release("4");
  });

  it("drops cached leases after resetPeerLeaseState", async () => {
    let counter = 0;
    const genFn = vi.fn(() => `peer-${counter++}`);

    const lease = await acquirePeerId(DOC_ID, genFn, "1", cmpVersion);
    await lease.release("2");

    await resetPeerLeaseState(DOC_ID);

    const next = await acquirePeerId(DOC_ID, genFn, "3", cmpVersion);

    expect(next.value).toBe("peer-1");
    expect(genFn).toHaveBeenCalledTimes(2);
    await next.release("4");
  });

  it("generates a new ID when the version has not advanced", async () => {
    const genFn = vi.fn(() => "generated");

    const lease = await acquirePeerId(DOC_ID, () => "seed", "1", cmpVersion);
    await lease.release("2");

    const next = await acquirePeerId(DOC_ID, genFn, "2", cmpVersion);

    expect(next.value).toBe("seed");
    expect(genFn).toHaveBeenCalledTimes(0);
    await next.release("3");
  });

  it("keeps leases isolated per document id", async () => {
    let counter = 0;
    const genFn = vi.fn(() => `peer-${counter++}`);

    const docLease = await acquirePeerId(DOC_ID, genFn, "1", cmpVersion);
    await docLease.release("2");

    const otherLease = await acquirePeerId(
      OTHER_DOC_ID,
      genFn,
      "1",
      cmpVersion,
    );

    expect(otherLease.value).toBe("peer-1");
    expect(otherLease.value).not.toBe(docLease.value);
    expect(genFn).toHaveBeenCalledTimes(2);

    await otherLease.release("2");
  });

  it("throws when the generator returns an empty string", async () => {
    await expect(
      acquirePeerId(DOC_ID, () => "", "1", cmpVersion),
    ).rejects.toThrow(/non-empty/);
  });
});
