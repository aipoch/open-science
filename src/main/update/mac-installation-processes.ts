import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { DarwinProcessIdentity } from '@aipoch/process-tree-native'
import { UpdateLifecycleError } from '../../shared/update'

const requireNative = createRequire(__filename)
type Native = Pick<
  typeof import('@aipoch/process-tree-native'),
  | 'listDarwinProcesses'
  | 'getDarwinProcessExecutable'
  | 'getDarwinProcessArguments'
  | 'signalDarwinProcess'
>
type OwnedProcess = DarwinProcessIdentity & { executablePath: string }
export class MacInstallationProcessError extends UpdateLifecycleError {
  constructor(
    readonly stage: string,
    cause?: unknown
  ) {
    super('installation-busy', `Installation process handling failed (${stage}).`, undefined, {
      cause
    })
  }
}
const inside = (path: string, root: string): boolean => path === root || path.startsWith(root + '/')
function canonicalManagedLoop(path: string): string | undefined {
  if (!isAbsolute(path)) return undefined
  let existing = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      return join(realpathSync(existing), ...missing)
    } catch (error) {
      // A live kernel can outlast the bundle's removal during replacement. Only ENOENT permits
      // normalizing the exact shipped path from its existing parent; denial/IO errors stay unknown.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(existing) === existing)
        return undefined
      missing.unshift(basename(existing))
      existing = dirname(existing)
    }
  }
}

/** Only canonical executable identity or a verified process-generation ancestry grants close
 * authority. An installation mapping, argv substring, name, coalition or stale PID never does. */
function collectOwned(
  native: Native,
  root: string,
  retained: Map<string, OwnedProcess>
): OwnedProcess[] {
  const table = native.listDarwinProcesses()
  if (!table?.complete) throw new MacInstallationProcessError('process-table-incomplete')
  const current = table.processes.flatMap((identity): OwnedProcess[] => {
    const executablePath = native.getDarwinProcessExecutable(identity.pid, identity.uniqueId)
    return executablePath ? [{ ...identity, executablePath }] : []
  })
  const owned = new Map<string, OwnedProcess>()
  const foreign = (row: OwnedProcess): boolean => {
    if (!/\.app\//i.test(row.executablePath) || inside(row.executablePath, root)) return false
    // Python/R may live inside another software bundle. This narrow exception needs verified
    // managed ancestry below AND native argv for this installation's exact shipped kernel loop.
    // Another Open-Science main/backend and arbitrary external applications remain excluded.
    if (
      !/^(?:python(?:\d+(?:\.\d+)*)?|r(?:script)?|node|electron)$/i.test(
        basename(row.executablePath)
      )
    )
      return true
    const script = native.getDarwinProcessArguments(row.pid)?.at(-1)
    if (!script) return true
    const canonical = canonicalManagedLoop(script)
    if (!canonical) return true
    if (!inside(canonical, root)) return true
    const matched = ['python_loop.py', 'r_loop.R', 'repl_loop.js'].some((name) =>
      ['app.asar.unpacked/resources/notebook', 'resources/notebook'].some((directory) => {
        return canonicalManagedLoop(join(root, 'Contents/Resources', directory, name)) === canonical
      })
    )
    return (
      !matched || native.getDarwinProcessExecutable(row.pid, row.uniqueId) !== row.executablePath
    )
  }
  for (const row of current) {
    if (!inside(row.executablePath, root) && retained.get(row.uniqueId)?.pid !== row.pid) continue
    if (foreign(row)) {
      // exec preserves uniqueId. A previously owned process that becomes another installation
      // also loses authority to lend its retained ancestry to new workers.
      retained.delete(row.uniqueId)
      continue
    }
    if (inside(row.executablePath, root) || retained.get(row.uniqueId)?.pid === row.pid)
      owned.set(row.uniqueId, row)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const row of current) {
      if (owned.has(row.uniqueId)) continue
      const parent = owned.get(row.parentUniqueId) ?? retained.get(row.parentUniqueId)
      if (!parent || (row.ppid !== parent.pid && row.ppid !== 1)) continue
      // Launching another installed app does not make that installation part of this update.
      if (foreign(row)) continue
      owned.set(row.uniqueId, row)
      changed = true
    }
  }
  for (const [generation, row] of owned) retained.set(generation, row)
  return [...owned.values()]
}

/** Requires the caller's installation-wide update lease. The existing observer publishes one
 * save/close deadline to every profile; old/unresponsive peers receive a bounded signal fallback.
 * Graceful/forced describe process exit only, never successful persistence. */
export async function closeMacInstallationProcesses(
  root: string,
  options: {
    excludedProcessIds: number[]
    timeoutMs: number
    deadlineAt?: number
    signal?: AbortSignal
  }
): Promise<{ graceful: number[]; forced: number[] }> {
  options.signal?.throwIfAborted()
  if (
    !isAbsolute(root) ||
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 0 ||
    options.timeoutMs > 30_000 ||
    (options.deadlineAt !== undefined && !Number.isSafeInteger(options.deadlineAt)) ||
    !options.excludedProcessIds.every((pid) => Number.isSafeInteger(pid) && pid > 0)
  )
    throw new MacInstallationProcessError('close-input')
  // A stable native entry also invokes this after the replaceable bundle was moved away.
  // Canonicalize existing parents without treating the missing application as an idle proof.
  let existing = resolve(root)
  const missing: string[] = []
  while (true) {
    try {
      root = join(realpathSync(existing), ...missing)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(existing) === existing)
        throw error
      missing.unshift(basename(existing))
      existing = dirname(existing)
    }
  }
  const deadlineAt = options.deadlineAt ?? Date.now() + options.timeoutMs + 1000
  const native = requireNative('@aipoch/process-tree-native') as Native
  const excluded = new Set([process.pid, ...options.excludedProcessIds])
  const retained = new Map<string, OwnedProcess>()
  const forced = new Set<string>()
  const term = new Set<string>()
  // Leave time for verified force and reap within the caller's original shared budget.
  const forceAt = Math.min(Date.now() + options.timeoutMs, deadlineAt - 500)
  const termAt = Math.max(Date.now(), forceAt - 500)
  const targets = (): OwnedProcess[] =>
    collectOwned(native, root, retained).filter((row) => !excluded.has(row.pid))
  const pause = (): Promise<void> =>
    new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, Math.min(50, deadlineAt - Date.now())))
    )
  try {
    while (true) {
      // Once close begins it must settle before cancellation/restart can reuse the installation.
      // Aborting the owner does not abandon an in-flight native shutdown.
      if (Date.now() >= deadlineAt) throw new MacInstallationProcessError('close-deadline')
      const live = targets()
      if (!live.length) {
        options.signal?.throwIfAborted()
        return {
          graceful: [...retained.values()]
            .filter((row) => !excluded.has(row.pid) && !forced.has(row.uniqueId))
            .map((row) => row.pid),
          forced: [...retained.values()]
            .filter((row) => forced.has(row.uniqueId))
            .map((row) => row.pid)
        }
      }
      for (const row of live) {
        if (Date.now() >= forceAt) {
          if (native.signalDarwinProcess(row.pid, row.uniqueId, 9, row.executablePath))
            forced.add(row.uniqueId)
        } else if (Date.now() >= termAt && !term.has(row.uniqueId)) {
          native.signalDarwinProcess(row.pid, row.uniqueId, 15, row.executablePath)
          term.add(row.uniqueId)
        }
      }
      await pause()
    }
  } catch (cause) {
    if (cause instanceof MacInstallationProcessError) throw cause
    throw new MacInstallationProcessError('verified-close', cause)
  }
}

/** Startup recovery has no backend connection yet. Its claimed installation owner first
 * republishes a fresh close deadline, so existing Desktops use the same save protocol. This
 * closes only verified installation objects and then proves occupancy before feeding ShipIt. */
export async function prepareMacRecoveryProcesses(
  root: string,
  options: {
    excludedProcessIds: number[]
    deadlineAt: number
    signal?: AbortSignal
  }
): Promise<{ graceful: number[]; forced: number[] }> {
  options.signal?.throwIfAborted()
  const remaining = options.deadlineAt - Date.now()
  if (remaining <= 0) throw new MacInstallationProcessError('recovery-close-deadline')
  const result = await closeMacInstallationProcesses(root, {
    excludedProcessIds: options.excludedProcessIds,
    timeoutMs: Math.max(0, Math.min(30_000, remaining - 500)),
    deadlineAt: options.deadlineAt,
    signal: options.signal
  })
  // Saving/closing has the existing 20s budget. Read-only verification gets a separate bounded
  // budget (two ps/lsof attempts + native fallback), so a slow lsof cannot shorten peer saving.
  const timeout = AbortSignal.timeout(35_000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const { inspectInstallationProcessesAsync } = await import('./installation-occupancy')
  const excluded = new Set([process.pid, ...options.excludedProcessIds])
  const occupants = (await inspectInstallationProcessesAsync(root, signal)).filter(
    (pid) => !excluded.has(pid)
  )
  if (occupants.length) throw new MacInstallationProcessError('recovery-remaining-occupants')
  return result
}
