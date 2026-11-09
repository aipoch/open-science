import { RESEARCH_VIDEO_SOURCE_FILE_LIMIT_BYTES } from '@aipoch/research-film/contracts'
import type { Stats } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, readdir, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readFileWithinLimit } from '@aipoch/durable-files'
import { z } from 'zod'

const identity = z.string().min(1).max(512)
const sourceOwner = z.object({
  provenance: z.object({ projectId: identity, sessionId: identity, branchId: identity.optional() })
})
const jobOwner = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  projectId: identity,
  appSessionId: identity
})
const uuid = z.string().uuid()
const info = async (path: string): Promise<Stats | undefined> =>
  lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
const directories = async (path: string): Promise<string[]> => {
  const stat = await info(path)
  if (!stat) return []
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Unsafe research film directory.')
  return (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
}
const readReceipt = async (path: string, limit: number): Promise<unknown> => {
  const stat = await info(path)
  if (!stat?.isFile() || stat.isSymbolicLink()) return undefined
  try {
    return JSON.parse(await readFileWithinLimit(path, limit))
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

export interface ResearchFilmLifecycle {
  withSessionStopped<T>(
    projectId: string,
    sessionId: string,
    operation: () => Promise<T>
  ): Promise<T>
  withProjectStopped<T>(projectId: string, operation: () => Promise<T>): Promise<T>
  run<T>(
    projectId: string,
    sessionId: string,
    work: (signal: AbortSignal) => Promise<T>
  ): Promise<T>
  deleteSessions(sessionIds: readonly string[]): Promise<void>
  reconcileSessions(existingSessionIds: readonly string[]): Promise<void>
}

/** Session JSON owns existence; complete-catalog reconciliation retries interrupted file cleanup. */
export function createResearchFilmLifecycle(options: {
  dataRoot(): string
}): ResearchFilmLifecycle {
  const deleted = new Set<string>()
  const stoppingSessions = new Map<string, number>()
  const stoppingProjects = new Map<string, number>()
  const active = new Set<{
    sessionId: string
    projectId: string
    controller: AbortController
    done: Promise<unknown>
  }>()
  let cleanup = Promise.resolve()

  const sweep = async (remove: (sessionId: string) => boolean, drain: boolean): Promise<void> => {
    const running = [...active].filter((job) => remove(job.sessionId))
    for (const job of running) {
      deleted.add(job.sessionId)
      job.controller.abort(new Error('Research session was deleted.'))
    }
    if (!drain && running.length)
      throw new Error('Research film cleanup is waiting for cancelled work.')
    await Promise.allSettled(running.map((job) => job.done))
    const root = options.dataRoot()
    const presentations = join(root, 'research-video-presentations')
    for (const key of await directories(presentations)) {
      if (!/^[a-f0-9]{64}$/.test(key)) continue
      const base = join(presentations, key)
      const latest = z
        .object({ id: z.string().uuid() })
        .safeParse(await readReceipt(join(base, 'latest.json'), 4096))
      for (const id of await directories(base)) {
        if (!uuid.safeParse(id).success) continue
        const directory = join(base, id)
        const parsed = sourceOwner.safeParse(
          await readReceipt(join(directory, 'session.json'), RESEARCH_VIDEO_SOURCE_FILE_LIMIT_BYTES)
        )
        if (!parsed.success) continue
        const owner = parsed.data.provenance
        const keys = [owner.branchId ?? null, null].map((branch) =>
          createHash('sha256')
            .update(JSON.stringify([owner.projectId, owner.sessionId, branch]))
            .digest('hex')
        )
        if (!keys.includes(key) || !remove(owner.sessionId)) continue
        deleted.add(owner.sessionId)
        if (latest.success && latest.data.id === id)
          await rm(join(base, 'latest.json'), { force: true })
        await rm(directory, { recursive: true, force: true })
      }
      await rm(join(base, 'deleted.json'), { force: true })
      // Preserve unrecognized files instead of recursively removing an unproven owner.
      await rmdir(base).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error
      })
    }
    const jobs = join(root, 'research-video-jobs')
    for (const id of await directories(jobs)) {
      if (!uuid.safeParse(id).success) continue
      const directory = join(jobs, id)
      const parsed = jobOwner.safeParse(await readReceipt(join(directory, 'job.json'), 1024 * 1024))
      if (parsed.success && parsed.data.id === id && remove(parsed.data.appSessionId)) {
        deleted.add(parsed.data.appSessionId)
        await rm(directory, { recursive: true, force: true })
      }
    }
  }
  const enqueue = (remove: (sessionId: string) => boolean, drain = true): Promise<void> => {
    const pending = cleanup.then(() => sweep(remove, drain))
    cleanup = pending.catch(() => {})
    return pending
  }
  const stopped = async <T>(
    barriers: Map<string, number>,
    key: string,
    matches: (job: { sessionId: string; projectId: string }) => boolean,
    operation: () => Promise<T>
  ): Promise<T> => {
    barriers.set(key, (barriers.get(key) ?? 0) + 1)
    try {
      const jobs = [...active].filter(matches)
      for (const job of jobs) job.controller.abort(new Error('Research session is being deleted.'))
      await Promise.allSettled(jobs.map((job) => job.done))
      return await operation()
    } finally {
      const remaining = barriers.get(key)! - 1
      if (remaining) barriers.set(key, remaining)
      else barriers.delete(key)
    }
  }
  return {
    withSessionStopped<T>(
      projectId: string,
      sessionId: string,
      operation: () => Promise<T>
    ): Promise<T> {
      return stopped(
        stoppingSessions,
        sessionId,
        (job) => job.projectId === projectId && job.sessionId === sessionId,
        operation
      )
    },
    withProjectStopped<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
      return stopped(stoppingProjects, projectId, (job) => job.projectId === projectId, operation)
    },
    run<T>(
      projectId: string,
      sessionId: string,
      work: (signal: AbortSignal) => Promise<T>
    ): Promise<T> {
      if (
        deleted.has(sessionId) ||
        stoppingSessions.has(sessionId) ||
        stoppingProjects.has(projectId)
      )
        return Promise.reject(new Error('Research session was deleted.'))
      const controller = new AbortController()
      const job = { sessionId, projectId, controller, done: Promise.resolve() as Promise<unknown> }
      const done = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted()
          return work(controller.signal)
        })
        .finally(() => active.delete(job))
      job.done = done
      active.add(job)
      return done
    },
    deleteSessions(sessionIds: readonly string[]): Promise<void> {
      for (const id of sessionIds) deleted.add(id)
      const ids = new Set(sessionIds)
      return enqueue((id) => ids.has(id))
    },
    reconcileSessions(existingSessionIds: readonly string[]): Promise<void> {
      const existing = new Set(existingSessionIds)
      return enqueue((id) => !existing.has(id), false)
    }
  }
}
