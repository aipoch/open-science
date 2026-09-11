import { AsyncLocalStorage } from 'node:async_hooks'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

// Progress is scoped to one operation, including inventory helpers used by reference bundles.
// It never changes the durable journal or substitutes for an integrity check.
const current = new AsyncLocalStorage()
export const withMigrationProgress = (callback, operation) =>
  current.run({ callback, lastKey: '', lastAt: 0 }, operation)

// The census reads names and sizes only, before any hashing or copying. Symlinks count as one
// entry and are never traversed; reference bundles count only the members they actually migrate.
export async function countMigrationEntries(root, files) {
  const totals = { entries: files ? 1 : 0, bytes: 0 }
  const visit = async (path) => {
    const entry = await lstat(path)
    totals.entries++
    if (entry.isFile()) totals.bytes += entry.size
    else if (entry.isDirectory())
      for (const name of await readdir(path)) await visit(join(path, name))
    else if (!entry.isSymbolicLink())
      throw new Error(`Unsupported special file blocks migration: ${path}`)
    await reportProgress({ phase: 'counting', path: root, completed: totals.entries })
  }
  await reportProgress({ phase: 'counting', path: root, completed: 0 }, true)
  if (files) {
    for (const path of files) {
      try {
        await visit(join(root, path))
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  } else await visit(root)
  return totals
}

export const manifestWork = (entries) => ({
  entries: entries?.length ?? 0,
  bytes: (entries ?? []).reduce((sum, entry) => sum + (entry.size ?? 0), 0)
})
const units = (summary) => summary.entries + summary.bytes
const taskId = (root, step) => JSON.stringify([root, step])

// Freeze the denominator once all roots are known. Each planned operation is weighted by its
// input bytes plus one unit per entry, including repeated verification and preserved targets.
// Opaque operations advance only on success; neither elapsed time nor native copy output is used.
export async function planMigrationWork(participants, status = 'new', onlyIfMissing = false) {
  const context = current.getStore()
  if (!context || (onlyIfMissing && context.work)) return
  const work = { tasks: new Map(), total: 1, completed: 0, entries: 0, bytes: 0, finished: false }
  for (const p of participants) {
    const original = p.work ?? manifestWork(p.original)
    const previous = p.targetWork ?? manifestWork(p.previousTarget?.original)
    work.entries += original.entries + previous.entries
    work.bytes += original.bytes + previous.bytes
    const source = units(original)
    const target = units(previous)
    const tasks = {
      ...(status === 'new' ? { original: source, 'target-original': target } : {}),
      ...(['new', 'preparing'].includes(status)
        ? {
            preflight: source + target,
            'stage-source': source + target,
            copy: source,
            'stage-verify': source,
            'stage-inventory': source,
            references: source,
            'published-inventory': source,
            sync: source,
            'prepared-source': source + target
          }
        : {}),
      publication: (p.files ? source * 2 : source) + target * 2,
      'published-root': source,
      'final-check': source * 2 + target,
      'commit-check': source * 2 + target
    }
    for (const [step, size] of Object.entries(tasks)) {
      if (!size) continue
      const weight = Math.max(1, size)
      work.tasks.set(taskId(p.to, step), { weight, completed: 0, observations: new Map() })
      work.total += weight
    }
  }
  context.work = work
  await reportProgress({ phase: 'counted' }, true)
}

// Nested reference-bundle verification gets its own scope, so its bytes cannot be counted as
// both copying and verification. Progress state is ephemeral and never enters recovery receipts.
export async function migrationWork(participant, step, operation) {
  const context = current.getStore()
  const task = context?.work?.tasks.get(taskId(participant.to, step))
  if (!task) return operation()
  const result = await current.run({ ...context, task }, operation)
  context.work.completed += task.weight - task.completed
  task.completed = task.weight
  return result
}

export function finishMigrationWork() {
  const work = current.getStore()?.work
  if (work) work.finished = true
}

export function reportProgress(event, force = false) {
  const context = current.getStore()
  if (!context) return
  if (context.work) {
    const { work, task } = context
    if (
      task &&
      event.path &&
      (event.completed !== undefined || event.processedBytes !== undefined)
    ) {
      const previous = task.observations.get(event.path) ?? { entries: 0, bytes: 0 }
      task.observations.set(event.path, {
        entries: Math.max(previous.entries, event.completed ?? 0),
        bytes: Math.max(previous.bytes, event.processedBytes ?? 0)
      })
      const observed = [...task.observations.values()].reduce((sum, item) => sum + units(item), 0)
      // Reserve the last unit until the operation (including metadata/integrity checks) succeeds.
      const completed = Math.max(task.completed, Math.min(task.weight - 1, observed))
      work.completed += completed - task.completed
      task.completed = completed
    }
    event = {
      ...event,
      overall: {
        completed: work.finished ? work.total : work.completed,
        total: work.total,
        entries: work.entries,
        bytes: work.bytes
      }
    }
  }
  const key = `${event.phase}:${event.path ?? ''}`
  const now = Date.now()
  if (
    !force &&
    event.completed !== undefined &&
    key === context.lastKey &&
    now - context.lastAt < 250
  )
    return
  context.lastKey = key
  context.lastAt = now
  // Database adapters call this synchronously inside their transaction. Preserve thrown errors.
  return context.callback(event)
}
