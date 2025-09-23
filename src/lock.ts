export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface MutexOptions {
  lockTtlMs: number;
  acquireTimeoutMs: number;
  retryDelayMs: number;
  retryJitterMs: number;
  heartbeatIntervalFraction?: number;
}

export interface AsyncMutex {
  runExclusive<T>(callback: () => T | Promise<T>): Promise<T>;
}

export interface CreateMutexConfig {
  storage: StorageLike;
  lockKey: string;
  fenceKey: string;
  channelName: string;
  webLockName: string;
  options: MutexOptions;
}

type LockGrantedCallback<T> = (lock: LockSnapshot | undefined) => T | Promise<T>;

interface LockSnapshot {
  name: string;
  mode: "shared" | "exclusive";
}

interface LockManagerRequestOptionsLike {
  mode?: "shared" | "exclusive";
  ifAvailable?: boolean;
  steal?: boolean;
  signal?: AbortSignal;
}

interface LockManagerLike {
  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(name: string, options: LockManagerRequestOptionsLike, callback: LockGrantedCallback<T>): Promise<T>;
}

interface NavigatorWithLocks {
  locks?: LockManagerLike;
}

interface BroadcastChannelMessageEventLike {
  data: unknown;
}

export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  addEventListener?(type: "message", listener: (event: BroadcastChannelMessageEventLike) => void): void;
  removeEventListener?(type: "message", listener: (event: BroadcastChannelMessageEventLike) => void): void;
  onmessage?: (event: BroadcastChannelMessageEventLike) => void;
}

interface StorageEventLike {
  key: string | null;
}

interface GlobalEventTargetLike {
  addEventListener?(type: string, listener: (event: unknown) => void, options?: unknown): void;
  removeEventListener?(type: string, listener: (event: unknown) => void, options?: unknown): void;
}

const DEFAULT_HEARTBEAT_FRACTION = 0.3;

export class WebLocksMutex implements AsyncMutex {
  private readonly locks: LockManagerLike;
  private readonly name: string;
  private readonly timeoutMs: number;

  constructor(locks: LockManagerLike, name: string, timeoutMs: number) {
    this.locks = locks;
    this.name = name;
    this.timeoutMs = timeoutMs;
  }

  async runExclusive<T>(callback: () => T | Promise<T>): Promise<T> {
    const AbortCtrl = typeof AbortController === "function" ? AbortController : undefined;
    const controller = AbortCtrl ? new AbortCtrl() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (controller && Number.isFinite(this.timeoutMs) && this.timeoutMs > 0) {
      timer = setTimeout(() => {
        controller.abort();
      }, this.timeoutMs);
    }

    try {
      if (controller) {
        return await this.locks.request(
          this.name,
          { mode: "exclusive", signal: controller.signal },
          async () => callback()
        );
      }

      return await this.locks.request(this.name, { mode: "exclusive" }, async () => callback());
    } catch (error) {
      if (controller && isAbortError(error)) {
        throw new Error("Timed out acquiring the peer lease mutex via Web Locks", { cause: error });
      }
      throw error;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}

export class LocalStorageMutex implements AsyncMutex {
  private readonly storage: StorageLike;
  private readonly key: string;
  private readonly fenceKey: string;
  private readonly options: MutexOptions;
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly waiters = new Set<() => void>();
  private readonly broadcast: BroadcastChannelLike | null;
  private listenersAttached = false;

  constructor(config: {
    storage: StorageLike;
    key: string;
    fenceKey: string;
    channelName: string;
    options: MutexOptions;
  }) {
    this.storage = config.storage;
    this.key = config.key;
    this.fenceKey = config.fenceKey;
    this.options = config.options;
    this.broadcast = createBroadcastChannel(config.channelName);
    this.attachListeners();
  }

  async runExclusive<T>(callback: () => T | Promise<T>): Promise<T> {
    const token = randomToken();
    const deadline = Date.now() + this.options.acquireTimeoutMs;

    while (true) {
      if (this.tryAcquire(token)) {
        this.startHeartbeat(token);

        try {
          return await callback();
        } finally {
          this.stopHeartbeat();
          this.release(token);
        }
      }

      if (Date.now() >= deadline) {
        throw new Error("Timed out acquiring the peer lease mutex");
      }

      await this.waitBeforeRetry(deadline);
    }
  }

  private tryAcquire(token: string): boolean {
    const now = Date.now();
    const record = this.readLock();

    if (record && record.token !== token && record.expiresAt > now) {
      return false;
    }

    const fence = this.bumpFence(record?.fence ?? 0);

    const nextRecord: LockRecord = {
      token,
      expiresAt: now + this.options.lockTtlMs,
      fence
    };

    this.writeLock(nextRecord);
    const stored = this.readLock();
    return stored !== null && stored.token === token;
  }

  private startHeartbeat(token: string): void {
    const interval = Math.max(
      1,
      Math.floor(this.options.lockTtlMs * (this.options.heartbeatIntervalFraction ?? DEFAULT_HEARTBEAT_FRACTION))
    );

    this.heartbeat = setInterval(() => {
      try {
        if (!this.refresh(token)) {
          this.stopHeartbeat();
        }
      } catch {
        this.stopHeartbeat();
      }
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private refresh(token: string): boolean {
    const record = this.readLock();
    if (!record || record.token !== token) {
      return false;
    }

    const updated: LockRecord = {
      token,
      expiresAt: Date.now() + this.options.lockTtlMs,
      fence: this.bumpFence(record.fence)
    };

    this.writeLock(updated);
    return true;
  }

  private release(token: string): void {
    const record = this.readLock();
    if (record && record.token === token) {
      this.storage.removeItem(this.key);
      this.announceRelease();
    }
  }

  private readLock(): LockRecord | null {
    const raw = this.storage.getItem(this.key);
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<LockRecord>;
      if (
        typeof parsed?.token !== "string" ||
        typeof parsed?.expiresAt !== "number" ||
        typeof parsed?.fence !== "number"
      ) {
        this.storage.removeItem(this.key);
        return null;
      }

      return parsed as LockRecord;
    } catch {
      this.storage.removeItem(this.key);
      return null;
    }
  }

  private writeLock(record: LockRecord): void {
    this.storage.setItem(this.key, JSON.stringify(record));
    this.notifyWaiters();
  }

  private bumpFence(previousFence: number): number {
    const raw = this.storage.getItem(this.fenceKey);
    const current = raw ? Number.parseInt(raw, 10) : 0;
    const baseline = Number.isFinite(current) ? current : 0;
    const next = Math.max(baseline, previousFence) + 1;
    this.storage.setItem(this.fenceKey, String(next));
    return next;
  }

  private async waitBeforeRetry(deadline: number): Promise<void> {
    const baseDelay = this.options.retryDelayMs;
    const jitter = Math.floor(Math.random() * this.options.retryJitterMs);
    const waitMs = Math.min(baseDelay + jitter, Math.max(0, deadline - Date.now()));

    if (waitMs <= 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      const wake = () => {
        cleanup();
        resolve();
      };

      const timeout = setTimeout(() => {
        cleanup();
        resolve();
      }, waitMs);

      const cleanup = () => {
        clearTimeout(timeout);
        this.waiters.delete(wake);
      };

      this.waiters.add(wake);
    });
  }

  private notifyWaiters(): void {
    if (this.waiters.size === 0) {
      return;
    }

    const callbacks = Array.from(this.waiters);
    this.waiters.clear();
    for (const wake of callbacks) {
      try {
        wake();
      } catch {
        // Swallow errors while notifying waiters; they have their own timers.
      }
    }
  }

  private announceRelease(): void {
    this.notifyWaiters();
    try {
      this.broadcast?.postMessage({ type: "release", key: this.key });
    } catch {
      // Ignore broadcast failures.
    }
  }

  private attachListeners(): void {
    if (this.listenersAttached) {
      return;
    }

    const globalTarget = globalThis as GlobalEventTargetLike & { navigator?: NavigatorWithLocks };
    const onStorage = (event: unknown): void => {
      const storageEvent = event as StorageEventLike | null;
      if (!storageEvent || storageEvent.key !== this.key) {
        return;
      }
      this.notifyWaiters();
    };

    if (typeof globalTarget.addEventListener === "function") {
      globalTarget.addEventListener("storage", onStorage);
    }

    if (this.broadcast) {
      const handler = (event: BroadcastChannelMessageEventLike): void => {
        const data = event?.data as { type?: string; key?: string } | undefined;
        if (data?.type === "release" && data.key === this.key) {
          this.notifyWaiters();
        }
      };

      attachBroadcastListener(this.broadcast, handler);
    }

    this.listenersAttached = true;
  }
}

interface LockRecord {
  token: string;
  expiresAt: number;
  fence: number;
}

export class MemoryStorage implements StorageLike {
  private readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }
}

export function createLeaseStorage(): StorageLike {
  const existing = detectLocalStorage();
  return existing ?? new MemoryStorage();
}

export function detectLocalStorage(): StorageLike | null {
  try {
    if (typeof globalThis !== "object" || globalThis === null) {
      return null;
    }

    const candidate = (globalThis as { localStorage?: StorageLike }).localStorage;

    if (!candidate) {
      return null;
    }

    const testKey = `peer-lease:test:${randomToken()}`;
    candidate.setItem(testKey, "ok");
    candidate.removeItem(testKey);

    return {
      getItem: candidate.getItem.bind(candidate),
      setItem: candidate.setItem.bind(candidate),
      removeItem: candidate.removeItem.bind(candidate)
    };
  } catch {
    return null;
  }
}

/**
 * Creates a mutex that prefers the Web Locks API when available and falls
 * back to the localStorage implementation otherwise.
 */
export function createMutex(config: CreateMutexConfig): AsyncMutex {
  const locks = getNavigatorLocks();
  if (locks) {
    return new WebLocksMutex(locks, config.webLockName, config.options.acquireTimeoutMs);
  }

  return new LocalStorageMutex({
    storage: config.storage,
    key: config.lockKey,
    fenceKey: config.fenceKey,
    channelName: config.channelName,
    options: config.options
  });
}

function getNavigatorLocks(): LockManagerLike | null {
  try {
    const navigatorCandidate = (globalThis as { navigator?: NavigatorWithLocks }).navigator;
    const locks = navigatorCandidate?.locks;

    if (!locks || typeof locks.request !== "function") {
      return null;
    }

    return locks;
  } catch {
    return null;
  }
}

function createBroadcastChannel(name: string): BroadcastChannelLike | null {
  try {
    const globalCandidate = globalThis as unknown as { BroadcastChannel?: unknown };
    const BC = globalCandidate.BroadcastChannel as undefined | (new (name: string) => BroadcastChannelLike);
    if (!BC) {
      return null;
    }
    return new BC(name);
  } catch {
    return null;
  }
}

function attachBroadcastListener(channel: BroadcastChannelLike, handler: (event: BroadcastChannelMessageEventLike) => void): void {
  if (typeof channel.addEventListener === "function") {
    channel.addEventListener("message", handler);
    return;
  }

  // eslint-disable-next-line unicorn/prefer-add-event-listener
  channel.onmessage = handler;
}

function randomToken(): string {
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${cryptoCounter++}`;
}

let cryptoCounter = 0;

function isAbortError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError";
  }

  if (error instanceof Error && typeof error.name === "string") {
    return error.name === "AbortError";
  }

  return false;
}
