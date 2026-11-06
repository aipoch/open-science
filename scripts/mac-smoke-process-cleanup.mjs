/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { isAbsolute, resolve } from 'node:path'

// NSWorkspace owns runtime launch; the stable entry's POSIX group does not own that process tree.
// Retain native birth identities while the runtime is alive, including descendants that later
// reparent. A recycled PID or another installation can never borrow this cleanup authority.
export const createMacSmokeProcessCleanup = (native, installationRoot) => {
  if (!isAbsolute(installationRoot) || resolve(installationRoot) === '/')
    throw new Error('An isolated runtime installation is required for smoke cleanup')
  const owned = new Map()
  const unresolved = new Map()
  const excluded = new Map()
  let snapshot = []
  const foreignApp = (path) => {
    const match = typeof path === 'string' ? /^(.*?\.app)(?:\/|$)/i.exec(path) : undefined
    return Boolean(match && match[1] !== installationRoot)
  }
  const revoke = (row) => {
    excluded.set(row.uniqueId, row)
    let changed
    do {
      changed = false
      for (const child of [...snapshot, ...owned.values(), ...unresolved.values()]) {
        if (!excluded.has(child.uniqueId) && excluded.has(child.parentUniqueId)) {
          excluded.set(child.uniqueId, child)
          changed = true
        }
      }
    } while (changed)
    for (const id of excluded.keys()) {
      owned.delete(id)
      unresolved.delete(id)
    }
  }
  const capture = () => {
    const table = native.listDarwinProcesses()
    if (!table || !Array.isArray(table.processes) || !table.complete)
      throw new Error('Smoke process ownership snapshot is incomplete')
    snapshot = table.processes
    const paths = new Map()
    for (const row of snapshot) {
      let path
      try {
        path = native.getDarwinProcessExecutable(row.pid, row.uniqueId)
      } catch {
        continue
      }
      if (path) paths.set(row.uniqueId, path)
      if (
        foreignApp(path) &&
        (owned.has(row.uniqueId) ||
          unresolved.has(row.uniqueId) ||
          owned.has(row.parentUniqueId) ||
          unresolved.has(row.parentUniqueId))
      ) {
        revoke(row)
      }
    }
    // Apply every exclusion before granting new ancestry. Retained children are revoked too,
    // including children reparented after an owned generation execs into another application.
    for (const row of snapshot) if (excluded.has(row.parentUniqueId)) revoke(row)
    for (const row of snapshot) {
      const path = paths.get(row.uniqueId)
      if (excluded.has(row.uniqueId)) continue
      if (path && (owned.has(row.uniqueId) || path.startsWith(installationRoot + '/')))
        owned.set(row.uniqueId, { ...row, executable: path })
    }
    let changed
    do {
      changed = false
      for (const row of snapshot) {
        if (excluded.has(row.uniqueId) || owned.has(row.uniqueId)) continue
        const parent = owned.get(row.parentUniqueId) || unresolved.get(row.parentUniqueId)
        if (parent?.pid !== row.ppid) continue
        if (foreignApp(paths.get(row.uniqueId))) {
          revoke(row)
          changed = true
          continue
        }
        if (!paths.has(row.uniqueId)) {
          if (!unresolved.has(row.uniqueId)) {
            unresolved.set(row.uniqueId, row)
            changed = true
          }
          continue
        }
        unresolved.delete(row.uniqueId)
        owned.set(row.uniqueId, { ...row, executable: paths.get(row.uniqueId) })
        changed = true
      }
    } while (changed)
    return [...owned.values()]
  }
  const live = (row) => {
    if (!owned.has(row.uniqueId)) return false
    const now = native.getDarwinProcess(row.pid)
    if (now?.uniqueId !== row.uniqueId) return false
    try {
      const path = native.getDarwinProcessExecutable(row.pid, row.uniqueId)
      if (foreignApp(path)) {
        revoke(row)
        return false
      }
      if (!path) return true // Alive with unknown executable is never evidence of successful cleanup.
      return true // This generation is alive; a changed executable is retried, never called exited.
    } catch {
      return true
    }
  }
  const unresolvedAlive = () =>
    [...unresolved.values()].some(
      (row) => native.getDarwinProcess(row.pid)?.uniqueId === row.uniqueId
    )
  const excludedOwnedAlive = () =>
    [...excluded.values()].some(
      (row) => native.getDarwinProcess(row.pid)?.uniqueId === row.uniqueId
    )
  const reap = async ({ timeoutMs = 10000 } = {}) => {
    const deadline = Date.now() + timeoutMs
    do {
      capture()
      const current = [...owned.values()].filter(live)
      if (excludedOwnedAlive())
        throw new Error(
          'Smoke cleanup crossed another application boundary; retain the isolated root'
        )
      if (!current.length && !unresolvedAlive()) return
      // Kill current captured generations only. Descendants retain their own exact executable,
      // even when it is a system Python/Node/Shell outside the installation directory.
      for (const row of current) {
        try {
          if (
            owned.has(row.uniqueId) &&
            native.getDarwinProcessExecutable(row.pid, row.uniqueId) === row.executable
          )
            native.signalDarwinProcess(row.pid, row.uniqueId, 9, row.executable)
        } catch {
          /* Retry until this exact exiting generation disappears or the bounded cleanup fails. */
        }
      }
      await new Promise((done) => setTimeout(done, 25))
    } while (Date.now() < deadline)
    if ([...owned.values()].some(live) || unresolvedAlive() || excludedOwnedAlive())
      throw new Error('Verified smoke runtime processes survived cleanup')
  }
  return { capture, reap }
}
