# peer-lease

`@loro-dev/peer-lease` is a TypeScript library for safely reusing CRDT peer IDs without collisions.

## Installation

```sh
pnpm add @loro-dev/peer-lease
# or
npm install @loro-dev/peer-lease
```

## Usage

```ts
import { LoroDoc } from "loro-crdt";
import { acquirePeerId, tryReuseLoroPeerId } from "@loro-dev/peer-lease";

const doc = new LoroDoc();
// ... Import local data into doc first
const lease = await acquirePeerId(
  "doc-123",
  () => new LoroDoc().peerIdStr,
  JSON.stringify(doc.frontiers()),
  (a, b) => {
    const fA = JSON.parse(a);
    const fB = JSON.parse(b);
    return doc.cmpFrontiers(fA, fB);
  },
);

try {
  console.log("Using peer", lease.value);
  doc.setPeerId(lease.value);
  // use doc here...
} finally {
  await lease.release(JSON.stringify(doc.frontiers()));
  // Or use FinalizeRegistry to release the lease
  // Note: release can be invoked exactly once; a second call throws.
}

// Later, when you reopen the same document, try to reuse the cached peer id
const release = await tryReuseLoroPeerId("doc-123", doc);
try {
  // doc.peerIdStr now matches the previously leased id when the cache is still valid
} finally {
  release();
}
```

The first argument is the document identifier that scopes locking and cache entries, ensuring leases only coordinate with peers working on the same document.

`acquirePeerId` first tries to coordinate through the [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API). When that API is unavailable it falls back to a localStorage-backed mutex with a TTL, heartbeat refresh, and release notifications. A released ID is cached together with the document version that produced it and is only handed out when the caller proves their version has advanced, preventing stale edits from reusing a peer ID.

`tryReuseLoroPeerId(docId, doc)` wraps the caching flow so you can reopen a document and automatically load the most recent peer ID if the stored frontiers prove the local state is up to date. The returned release function must be called once the session ends; it updates the cache with the latest frontiers and assigns a fresh random peer ID to avoid conflicts on future loads.

## Coordination strategy

- **Lock negotiation** – Calls use `navigator.locks.request` in supporting browsers so the lease state is mutated under an exclusive Web Lock. Fallback tabs use a fencing localStorage record with TTL heartbeats, and wake waiters via `storage` events plus a `BroadcastChannel`.
- **Version gating** – Every lease carries document metadata. We only recycle a peer ID after the releasing tab supplies the version it used, and a future caller provides a strictly newer version according to the supplied comparator. This stops pre-load editing sessions from replaying IDs once the real document snapshot arrives.
- **Explicit release** – A lease is only recycled when the releasing tab provides its final version metadata. If a tab crashes or never releases, the ID stays reserved so it cannot be handed out again accidentally; any lease left active for 24 hours is simply discarded instead of being returned to the available pool.

### Lock implementation details

When Web Locks are available the mutex is just a thin wrapper around `navigator.locks.request`, enforcing an acquire timeout. In browsers without that API we fall back to a localStorage-backed mutex that writes a JSON record containing a token, fence, and expiry. The holder extends the expiry with a heartbeat (a `setInterval` that calls `refresh`) so long tasks don’t lose the lock, while waiters observe the fence value and `storage`/`BroadcastChannel` notifications to wake up promptly. If the tab crashes the record expires after `lockTtlMs`, letting another peer take over without manual cleanup.

The mutex implementation is exported so advanced users can coordinate other shared state:

```ts
import { createMutex, type AsyncMutex } from "@loro-dev/peer-lease";

const mutex: AsyncMutex = createMutex({
  storage: window.localStorage,
  lockKey: "my-lock",
  fenceKey: "my-lock:fence",
  channelName: "my-lock:channel",
  webLockName: "my-lock:web",
  options: {
    lockTtlMs: 10_000,
    acquireTimeoutMs: 5_000,
    retryDelayMs: 40,
    retryJitterMs: 60,
  },
});

await mutex.runExclusive(async () => {
  // critical section
});
```

You can reuse the same mutex that `acquirePeerId` does by passing the document id to keep coordination scoped per document.

## Development

- `pnpm install` – install dependencies
- `pnpm build` – produce ESM/CJS/d.ts bundles via tsdown
- `pnpm dev` – run tsdown in watch mode
- `pnpm test` – run Vitest
- `pnpm lint` – run oxlint
- `pnpm typecheck` – run the TypeScript compiler without emitting files
- `pnpm check` – type check, lint, update snapshots, and test

## Release workflow

- Push Conventional Commits to `main`; Release Please opens or updates a release PR with the changelog and semver bump.
- Merging that PR tags the release and triggers `.github/workflows/publish-on-tag.yml`, which publishes to npm using `NODE_AUTH_TOKEN` derived from the `NPM_TOKEN` secret.
- Publish provenance is enabled via `.npmrc` and `publishConfig.provenance`.

## Continuous integration

The `CI` workflow installs dependencies, lints, type-checks, runs Vitest in run mode, and builds the library on pushes and pull requests.
