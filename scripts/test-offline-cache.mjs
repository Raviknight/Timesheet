/**
 * scripts/test-offline-cache.mjs
 *
 * Phase 3 Step 5 gate: the offline read-through cache in src/data/storage.js.
 *
 * Proves the behavior that the July cold-start outage exposed, where a failed
 * remote read was indistinguishable from genuinely empty data and the app came
 * up as an empty shell:
 *   - a successful read is mirrored to localStorage
 *   - a failing read retries, then serves the mirror instead of the fallback
 *   - a key served from the mirror is marked stale and refuses writes
 *   - a later successful read clears the stale mark and re-enables writes
 *   - a genuinely empty result does NOT overwrite a good mirror
 *   - cache keys are scoped per user
 *
 * localStorage does not exist in node and the Supabase client is not reachable
 * from a test, so both are stubbed before storage.js is imported. That import
 * order matters: storage.js reads globalThis.localStorage lazily inside its
 * helpers, so the shim only has to exist before the first call.
 *
 * Run with: node scripts/test-offline-cache.mjs
 */

// --- localStorage shim, installed before importing storage.js ---------------
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: k => { store.delete(k); },
  key: i => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const {
  Store, RemoteStore, offlineCacheKey, isServingStaleData,
  staleKeyList, clearStaleMarks,
} = await import('../src/data/storage.js');

let pass = 0, fail = 0;
const eq = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  cond ? pass++ : fail++;
};
const same = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`));
  ok ? pass++ : fail++;
};

// --- stub the layers Store depends on ---------------------------------------
// getStorageMode() returns 'remote' only when a Supabase session exists. The
// test drives Store.get/set directly against a stubbed RemoteStore, so force
// remote mode by stubbing the session lookup the module already exports
// through its own behavior: easiest is to stub RemoteStore and the auth read.
const realRemoteGet = RemoteStore.get;
const realRemoteSet = RemoteStore.set;

// storage.js calls getSignedInUserId() internally, which reads a Supabase
// session from localStorage. Plant a token so getStorageMode() reports remote
// and the cache namespaces under a stable user id.
// getSignedInUserId() requires BOTH user.id and access_token before it will
// report a session, so a partial stub silently routes Store to LocalStore.
function signIn(userId) {
  store.set(
    'sb-kijumyxoiacvqlqqwqon-auth-token',
    JSON.stringify({ user: { id: userId }, access_token: 'test-token' })
  );
}

const KEY = 'ts:pays';
const FRESH = [{ date: '2026-09-01', gross: 100 }];
const NEWER = [{ date: '2026-09-15', gross: 200 }];

signIn('user-a');

// --- 1. successful read mirrors to the cache --------------------------------
console.log('\n== 1. successful read populates the mirror ==');
RemoteStore.get = async () => FRESH;
const r1 = await Store.get(KEY, []);
same('returns fresh data', r1, FRESH);
eq('not marked stale', !isServingStaleData());
const raw = localStorage.getItem(offlineCacheKey(KEY, 'user-a'));
eq('mirror written to localStorage', raw !== null);
same('mirror holds the fresh value', JSON.parse(raw), FRESH);

// --- 2. failing read falls back to the mirror -------------------------------
console.log('\n== 2. failing read serves the mirror, not the fallback ==');
let attempts = 0;
RemoteStore.get = async (k, fallback) => {
  attempts++;
  // Mimic the real contract: swallow the error, return the caller's fallback,
  // and throw inside so the module's own catch marks the failure.
  throw new Error('simulated network failure');
};
const r2 = await Store.get(KEY, []);
same('serves cached data instead of empty fallback', r2, FRESH);
eq('retried before giving up (3 attempts)', attempts === 3);
eq('key marked stale', isServingStaleData());
same('stale list names the key', staleKeyList(), [KEY]);

// --- 3. writes are refused while stale --------------------------------------
console.log('\n== 3. stale key refuses writes ==');
let remoteSetCalled = false;
RemoteStore.set = async () => { remoteSetCalled = true; return true; };
const wrote = await Store.set(KEY, NEWER);
eq('Store.set returns false', wrote === false);
eq('RemoteStore.set never reached', remoteSetCalled === false);

// --- 4. a fresh read clears the stale mark ----------------------------------
console.log('\n== 4. recovery clears the stale mark ==');
RemoteStore.get = async () => NEWER;
const r4 = await Store.get(KEY, []);
same('returns the newer data', r4, NEWER);
eq('no longer stale', !isServingStaleData());
const wrote2 = await Store.set(KEY, NEWER);
eq('writes allowed again', wrote2 === true && remoteSetCalled === true);
same('mirror refreshed', JSON.parse(localStorage.getItem(offlineCacheKey(KEY, 'user-a'))), NEWER);

// --- 5. a genuinely empty result must not clobber the mirror ----------------
console.log('\n== 5. empty result does not overwrite a good mirror ==');
// RemoteStore signals "no rows" by returning the caller's fallback object by
// identity. The cache must treat that as "nothing to mirror".
const emptyFallback = [];
RemoteStore.get = async (k, fallback) => fallback;
const r5 = await Store.get(KEY, emptyFallback);
same('returns the empty fallback', r5, []);
same('mirror still holds the last real data',
  JSON.parse(localStorage.getItem(offlineCacheKey(KEY, 'user-a'))), NEWER);

// --- 6. cache keys are scoped per user --------------------------------------
console.log('\n== 6. per-user cache isolation ==');
eq('different users get different keys',
  offlineCacheKey(KEY, 'user-a') !== offlineCacheKey(KEY, 'user-b'));
eq('key includes the user id', offlineCacheKey(KEY, 'user-b').includes('user-b'));
signIn('user-b');
clearStaleMarks();
RemoteStore.get = async (k, fallback) => { throw new Error('down'); };
const r6 = await Store.get(KEY, emptyFallback);
same('user-b sees no cache from user-a, gets fallback', r6, []);

// --- restore ---------------------------------------------------------------
RemoteStore.get = realRemoteGet;
RemoteStore.set = realRemoteSet;

console.log(`\n--- ${pass} pass, ${fail} fail ---`);
if (fail > 0) process.exit(1);
console.log('All offline-cache self-tests passed.');
