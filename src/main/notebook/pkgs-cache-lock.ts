// A readers–writer lock guarding the SHARED conda package cache (<root>/runtime/pkgs), keyed by root.
//
// The env-scoped install/create locks (see runtime-service's EnvLock) deliberately let operations on
// DIFFERENT environments run in parallel — but they all read/hard-link from the one shared pkgs cache.
// A corrupt-cache repair that REMOVES entries from that cache must not run while another env's
// micromamba is mid-create/install against it. So:
//   - a normal create/install takes the cache SHARED (many run concurrently, preserving env-parallelism)
//   - the corrupt-cache clean takes it EXCLUSIVE (waits for in-flight shared holders to drain, and
//     blocks new ones until it finishes), so it never deletes a package another process is using.
//
// In-process only (one lock per cache path within this main process); micromamba's own on-disk pkgs
// lockfile still guards against other OS processes.

type CacheLockState = {
  readers: number
  // Resolves when the current exclusive holder releases; undefined when no writer holds/awaits.
  writer: Promise<void> | undefined
  // FIFO of waiters (readers and the writer) so acquisition is fair and a writer can't be starved.
  queue: Array<() => void>
}

const locks = new Map<string, CacheLockState>()

const stateFor = (key: string): CacheLockState => {
  let state = locks.get(key)
  if (!state) {
    state = { readers: 0, writer: undefined, queue: [] }
    locks.set(key, state)
  }
  return state
}

// Runs the next waiter(s): if a writer is at the head it runs alone; otherwise all leading readers run.
const pump = (state: CacheLockState): void => {
  if (state.writer !== undefined || state.readers > 0) return
  const next = state.queue.shift()
  if (next) next()
}

// Acquire the cache SHARED (concurrent with other shared holders, excluded by an exclusive holder).
export const withSharedCacheLock = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const state = stateFor(key)
  // Wait behind any writer that is holding or queued (writer-preference avoids reader starvation).
  if (state.writer !== undefined || state.queue.length > 0) {
    await new Promise<void>((resolve) => state.queue.push(resolve))
  }
  state.readers += 1
  try {
    return await fn()
  } finally {
    state.readers -= 1
    pump(state)
  }
}

// Acquire the cache EXCLUSIVE: no readers and no other writer run for the duration of fn.
export const withExclusiveCacheLock = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const state = stateFor(key)
  if (state.writer !== undefined || state.readers > 0 || state.queue.length > 0) {
    await new Promise<void>((resolve) => state.queue.push(resolve))
  }
  let release!: () => void
  state.writer = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    return await fn()
  } finally {
    const held = state.writer
    state.writer = undefined
    release()
    void held
    pump(state)
  }
}

const withCacheLocks = async <T>(
  keys: string[],
  acquireLock: <R>(key: string, operation: () => Promise<R>) => Promise<R>,
  fn: () => Promise<T>
): Promise<T> => {
  const ordered = [...new Set(keys)].sort()
  const acquire = (index: number): Promise<T> =>
    index === ordered.length ? fn() : acquireLock(ordered[index], () => acquire(index + 1))
  return acquire(0)
}

// Acquires multiple physical cache identities in stable order. Normal micromamba operations can
// read the legacy root cache and write the selected short cache, so they share both identities.
export const withSharedCacheLocks = async <T>(keys: string[], fn: () => Promise<T>): Promise<T> =>
  withCacheLocks(keys, withSharedCacheLock, fn)

// Recovery can inspect and delete from both cache locations, so it excludes users of either without
// introducing a lock-order deadlock between concurrent recovery attempts.
export const withExclusiveCacheLocks = async <T>(
  keys: string[],
  fn: () => Promise<T>
): Promise<T> => withCacheLocks(keys, withExclusiveCacheLock, fn)
