import {
  AsyncMutex,
  StorageLike,
  createLeaseStorage,
  createMutex,
} from "./lock.js";

const LOCK_KEY_PREFIX = "peer-lease:lock:";
const LOCK_FENCE_KEY_PREFIX = "peer-lease:lock:fence:";
const LOCK_CHANNEL_PREFIX = "peer-lease:lock:channel:";
const LOCK_NAME_PREFIX = "peer-lease::mutex:";
const STATE_KEY_PREFIX = "peer-lease:state:";
const PENDING_KEY_PREFIX = "peer-lease:pending:";

const LOCK_TTL_MS = 10_000;
const ACQUIRE_TIMEOUT_MS = 5_000;
const RETRY_DELAY_MS = 40;
const RETRY_JITTER_MS = 60;
const HEARTBEAT_INTERVAL_FRACTION = 0.3;
const MAX_GENERATION_ATTEMPTS = 32;
const LEASE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

interface CachedPeerId {
  id: string;
  version: string;
}

interface ActiveLeaseInfo {
  leasedAt: number;
  version: string;
}

interface LeaseState {
  available: CachedPeerId[];
  active: Record<string, ActiveLeaseInfo>;
}

type PendingReleaseEntry = CachedPeerId;

interface PendingDrainResult {
  snapshot: string | null;
  entries: PendingReleaseEntry[];
}

const storage: StorageLike = createLeaseStorage();
const mutexes = new Map<string, AsyncMutex>();
const MUTEX_OPTIONS = {
  lockTtlMs: LOCK_TTL_MS,
  acquireTimeoutMs: ACQUIRE_TIMEOUT_MS,
  retryDelayMs: RETRY_DELAY_MS,
  retryJitterMs: RETRY_JITTER_MS,
  heartbeatIntervalFraction: HEARTBEAT_INTERVAL_FRACTION,
};

function getDocMutex(docId: string): AsyncMutex {
  let mutex = mutexes.get(docId);
  if (!mutex) {
    mutex = createMutex({
      storage,
      lockKey: getLockKey(docId),
      fenceKey: getFenceKey(docId),
      channelName: getChannelName(docId),
      webLockName: getWebLockName(docId),
      options: MUTEX_OPTIONS,
    });
    mutexes.set(docId, mutex);
  }
  return mutex;
}

function withDocMutex<T>(
  docId: string,
  callback: () => T | Promise<T>,
): Promise<T> {
  return getDocMutex(docId).runExclusive(callback);
}

function getStateKey(docId: string): string {
  return STATE_KEY_PREFIX + encodeDocId(docId);
}

function getPendingKey(docId: string): string {
  return PENDING_KEY_PREFIX + encodeDocId(docId);
}

function getLockKey(docId: string): string {
  return LOCK_KEY_PREFIX + encodeDocId(docId);
}

function getFenceKey(docId: string): string {
  return LOCK_FENCE_KEY_PREFIX + encodeDocId(docId);
}

function getChannelName(docId: string): string {
  return LOCK_CHANNEL_PREFIX + encodeDocId(docId);
}

function getWebLockName(docId: string): string {
  return LOCK_NAME_PREFIX + encodeDocId(docId);
}

/**
 * Represents a peer identifier lease that must be released once the caller
 * finishes emitting operations for the given document version.
 */
interface ReleaseHandlers {
  stageRelease: (value: string, version: string) => void;
  flushRelease: (value: string, version: string) => Promise<void>;
}

export class PeerIdLease {
  readonly value: string;
  private readonly stageReleaseFn: ReleaseHandlers["stageRelease"];
  private readonly flushReleaseFn: ReleaseHandlers["flushRelease"];
  private releaseTask?: Promise<void>;
  private releaseState: "idle" | "staged" | "flushed" = "idle";

  constructor(value: string, handlers: ReleaseHandlers) {
    if (!isNonEmptyString(value)) {
      throw new TypeError("PeerIdLease requires a non-empty peer ID value");
    }

    this.value = value;
    this.stageReleaseFn = handlers.stageRelease;
    this.flushReleaseFn = handlers.flushRelease;
  }

  /**
   * Returns the peer identifier to the shared cache after confirming the
   * caller's document version. Subsequent calls reuse the same release promise
   * so callers can fire-and-forget during lifecycle events and `await` later if
   * desired.
   */
  async release(version: string): Promise<void> {
    if (!isNonEmptyString(version)) {
      throw new TypeError("release expects a non-empty version string");
    }

    if (this.releaseTask) {
      return this.releaseTask;
    }

    this.stageReleaseFn(this.value, version);
    this.releaseState = "staged";

    this.releaseTask = (async () => {
      try {
        await this.flushReleaseFn(this.value, version);
        this.releaseState = "flushed";
      } catch (error) {
        this.releaseTask = undefined;
        this.releaseState = "idle";
        throw error;
      }
    })();

    await this.releaseTask;
  }

  isReleased(): boolean {
    return this.releaseState !== "idle";
  }
}

/**
 * Acquires a peer identifier that is safe to reuse for a caller operating on
 * the provided document version of the supplied document ID. The comparator
 * must order versions so that a positive result means “left is newer than
 * right”.
 */
export async function acquirePeerId(
  docId: string,
  genFn: () => string,
  version: string,
  cmpVersion: (a: string, b: string) => number | undefined,
): Promise<PeerIdLease> {
  if (!isNonEmptyString(docId)) {
    throw new TypeError("acquirePeerId expects a non-empty docId string");
  }

  if (typeof genFn !== "function") {
    throw new TypeError("acquirePeerId expects a generator function");
  }

  if (!isNonEmptyString(version)) {
    throw new TypeError("acquirePeerId expects a non-empty version string");
  }

  if (typeof cmpVersion !== "function") {
    throw new TypeError("acquirePeerId expects a comparator function");
  }

  const value = await withState(docId, async (state) => {
    let peerId: string | undefined;

    for (let index = 0; index < state.available.length; index += 1) {
      const entry = state.available[index];
      // Only recycle peer IDs produced by a strictly older document version.
      const cmp = cmpVersion(version, entry.version);
      if (cmp != null && cmp >= 0) {
        peerId = entry.id;
        state.available.splice(index, 1);
        break;
      }
    }

    if (!peerId) {
      const used = new Set<string>();
      for (const entry of state.available) {
        used.add(entry.id);
      }
      for (const id of Object.keys(state.active)) {
        used.add(id);
      }
      peerId = generateUniquePeerId(genFn, used);
    }

    if (!isNonEmptyString(peerId)) {
      throw new Error("Failed to acquire a peer ID");
    }

    state.active[peerId] = {
      leasedAt: Date.now(),
      version,
    };
    return peerId;
  });

  return new PeerIdLease(value, createReleaseHandlers(docId));
}

export async function resetPeerLeaseState(docId?: string): Promise<void> {
  if (docId !== undefined && !isNonEmptyString(docId)) {
    throw new TypeError("resetPeerLeaseState expects a non-empty docId string");
  }

  if (docId) {
    await withDocMutex(docId, async () => {
      storage.removeItem(getStateKey(docId));
      storage.removeItem(getLockKey(docId));
      storage.removeItem(getFenceKey(docId));
      storage.removeItem(getPendingKey(docId));
    });
    return;
  }

  // Legacy reset: clear original global keys if present and flush
  // state for any docIds encountered during this session.
  storage.removeItem("peer-lease:state");
  storage.removeItem("peer-lease:lock");
  storage.removeItem("peer-lease:lock:fence");

  const knownDocIds = Array.from(mutexes.keys());
  await Promise.all(
    knownDocIds.map((id) =>
      withDocMutex(id, async () => {
        storage.removeItem(getStateKey(id));
        storage.removeItem(getLockKey(id));
        storage.removeItem(getFenceKey(id));
        storage.removeItem(getPendingKey(id));
      }),
    ),
  );
}

function createReleaseHandlers(docId: string): ReleaseHandlers {
  return {
    stageRelease: (value: string, version: string) => {
      if (!isNonEmptyString(value) || !isNonEmptyString(version)) {
        return;
      }

      stagePendingRelease(docId, { id: value, version });
    },

    flushRelease: async (value: string, version: string) => {
      if (!isNonEmptyString(value) || !isNonEmptyString(version)) {
        return;
      }

      await withState(docId, async (state) => {
        if (state.active[value] !== undefined) {
          delete state.active[value];
        }

        const existingIndex = state.available.findIndex((entry) => entry.id === value);
        if (existingIndex >= 0) {
          state.available[existingIndex] = { id: value, version };
        } else {
          state.available.push({ id: value, version });
        }
      });
    },
  };
}

async function withState<T>(
  docId: string,
  mutator: (state: LeaseState) => T | Promise<T>,
): Promise<T> {
  return withDocMutex(docId, async () => {
    const state = readState(docId);
    const pending = drainPendingReleases(docId, state);
    cleanupState(state, Date.now());
    const result = await mutator(state);
    normalizeState(state);
    writeState(docId, state);
    finalizePendingReleases(docId, pending);
    return result;
  });
}

function readState(docId: string): LeaseState {
  const raw = storage.getItem(getStateKey(docId));
  if (!raw) {
    return { available: [], active: {} };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<{
      available: unknown;
      active: unknown;
    }>;
    const available: CachedPeerId[] = [];
    if (Array.isArray(parsed.available)) {
      for (const entry of parsed.available) {
        if (!entry || typeof entry !== "object") {
          continue;
        }

        const candidate = entry as { id?: unknown; version?: unknown };
        if (
          isNonEmptyString(candidate.id) &&
          isNonEmptyString(candidate.version)
        ) {
          available.push({ id: candidate.id, version: candidate.version });
        }
      }
    }

    const active: Record<string, ActiveLeaseInfo> = {};
    if (parsed.active && typeof parsed.active === "object") {
      for (const [key, value] of Object.entries(
        parsed.active as Record<string, unknown>,
      )) {
        if (!isNonEmptyString(key) || !value || typeof value !== "object") {
          continue;
        }

        const info = value as { leasedAt?: unknown; version?: unknown };
        if (
          typeof info.leasedAt === "number" &&
          Number.isFinite(info.leasedAt) &&
          isNonEmptyString(info.version)
        ) {
          active[key] = {
            leasedAt: info.leasedAt,
            version: info.version,
          };
        }
      }
    }

    return { available, active };
  } catch {
    return { available: [], active: {} };
  }
}

function writeState(docId: string, state: LeaseState): void {
  if (state.available.length === 0 && Object.keys(state.active).length === 0) {
    storage.removeItem(getStateKey(docId));
    return;
  }

  storage.setItem(getStateKey(docId), JSON.stringify(state));
}

function stagePendingRelease(docId: string, entry: PendingReleaseEntry): void {
  const { entries: pending } = readPendingReleases(docId);
  const dedup = new Map<string, string>();

  for (const item of pending) {
    if (!item) {
      continue;
    }
    if (isNonEmptyString(item.id) && isNonEmptyString(item.version)) {
      dedup.set(item.id, item.version);
    }
  }

  if (isNonEmptyString(entry.id) && isNonEmptyString(entry.version)) {
    dedup.set(entry.id, entry.version);
  }

  writePendingReleases(
    docId,
    Array.from(dedup.entries()).map(([id, version]) => ({ id, version })),
  );
}

function readPendingReleases(docId: string): { raw: string | null; entries: PendingReleaseEntry[] } {
  const raw = storage.getItem(getPendingKey(docId));
  return { raw, entries: parsePendingEntries(raw) };
}

function writePendingReleases(docId: string, entries: PendingReleaseEntry[]): void {
  if (entries.length === 0) {
    storage.removeItem(getPendingKey(docId));
    return;
  }

  storage.setItem(getPendingKey(docId), JSON.stringify(entries));
}

function drainPendingReleases(docId: string, state: LeaseState): PendingDrainResult {
  const { raw, entries } = readPendingReleases(docId);
  if (entries.length === 0) {
    return { snapshot: raw, entries: [] };
  }

  const dedup = new Map<string, string>();
  for (const entry of entries) {
    if (!entry) {
      continue;
    }

    if (isNonEmptyString(entry.id) && isNonEmptyString(entry.version)) {
      dedup.set(entry.id, entry.version);
    }
  }

  for (const [id, version] of dedup.entries()) {
    if (state.active[id] !== undefined) {
      delete state.active[id];
    }

    const existingIndex = state.available.findIndex((entry) => entry.id === id);
    if (existingIndex >= 0) {
      state.available.splice(existingIndex, 1);
    }

    state.available.push({ id, version });
  }

  return {
    snapshot: raw,
    entries: Array.from(dedup.entries()).map(([id, version]) => ({ id, version })),
  };
}

function finalizePendingReleases(docId: string, pending: PendingDrainResult): void {
  if (pending.entries.length === 0) {
    return;
  }

  const key = getPendingKey(docId);
  const currentRaw = storage.getItem(key);

  if (currentRaw === null) {
    return;
  }

  if (pending.snapshot !== null && currentRaw === pending.snapshot) {
    storage.removeItem(key);
    return;
  }

  const remaining = parsePendingEntries(currentRaw);
  let changed = false;

  for (const entry of pending.entries) {
    const index = remaining.findIndex(
      (candidate) => candidate.id === entry.id && candidate.version === entry.version,
    );
    if (index >= 0) {
      remaining.splice(index, 1);
      changed = true;
    }
  }

  if (!changed) {
    return;
  }

  writePendingReleases(docId, remaining);
}

function parsePendingEntries(raw: string | null): PendingReleaseEntry[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    const entries: PendingReleaseEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const candidate = item as { id?: unknown; version?: unknown };
      if (isNonEmptyString(candidate.id) && isNonEmptyString(candidate.version)) {
        entries.push({ id: candidate.id, version: candidate.version });
      }
    }

    return entries;
  } catch {
    return [];
  }
}

function cleanupState(state: LeaseState, now: number): void {
  for (const [key, info] of Object.entries(state.active)) {
    if (
      !info ||
      typeof info.leasedAt !== "number" ||
      !Number.isFinite(info.leasedAt) ||
      !isNonEmptyString(info.version)
    ) {
      delete state.active[key];
      continue;
    }

    if (now - info.leasedAt >= LEASE_STALE_AFTER_MS) {
      delete state.active[key];
    }
  }
}

function normalizeState(state: LeaseState): void {
  const dedup = new Map<string, string>();

  for (const entry of state.available) {
    if (!entry) {
      continue;
    }

    if (!isNonEmptyString(entry.id) || !isNonEmptyString(entry.version)) {
      continue;
    }

    if (state.active[entry.id]) {
      continue;
    }

    dedup.set(entry.id, entry.version);
  }

  state.available = Array.from(dedup.entries()).map(([id, version]) => ({
    id,
    version,
  }));

  for (const [key, value] of Object.entries(state.active)) {
    if (
      !isNonEmptyString(key) ||
      !value ||
      typeof value.leasedAt !== "number" ||
      !Number.isFinite(value.leasedAt) ||
      !isNonEmptyString(value.version)
    ) {
      delete state.active[key];
    }
  }
}

function generateUniquePeerId(genFn: () => string, used: Set<string>): string {
  let attempt = 0;

  while (attempt < MAX_GENERATION_ATTEMPTS) {
    const candidate = genFn();
    if (!isNonEmptyString(candidate)) {
      throw new Error("Peer ID generator must return a non-empty string");
    }

    if (!used.has(candidate)) {
      return candidate;
    }

    attempt += 1;
  }

  throw new Error("Peer ID generator produced duplicate values");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function encodeDocId(docId: string): string {
  return encodeURIComponent(docId);
}
