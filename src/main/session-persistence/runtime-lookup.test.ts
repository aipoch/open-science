import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

import type { AgentFrameworkId } from '../../shared/settings'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { createProductionDelegatedWorkComposition } from '../delegation/production-composition'
import {
  SessionSpecialistReconfiguration,
  SPECIALIST_RECONFIGURATION_PENDING_ERROR
} from '../specialist/session-reconfiguration'
import { SessionPersistenceCoordinator, type SessionFileIndex } from './coordinator'
import { SessionRepository } from './repository'
import { createSessionRuntimeLookup } from './runtime-lookup'

const fileIndex: SessionFileIndex = {
  syncSession: async () => [],
  softDeleteSession: async () => 'deleted',
  restoreSession: async () => undefined,
  softDeleteProject: async () => 'deleted',
  reconcileActiveSessions: async () => undefined,
  reconcileProjectSessions: async () => undefined,
  markReconciliationIncomplete: () => undefined
}

const session = (
  id: string,
  frameworkId: AgentFrameworkId = 'claude-code'
): PersistedChatSession => ({
  id,
  projectId: 'project-1',
  title: id,
  cwd: '/workspace',
  status: 'idle',
  agentFrameworkId: frameworkId,
  messages: [],
  createdAt: 1,
  updatedAt: 1
})

const roots: string[] = []
const createLookup = async (
  hydrate = true,
  dependencies: ConstructorParameters<typeof SessionRepository>[1] = {}
): Promise<{
  root: string
  repository: SessionRepository
  findSessions: ReturnType<typeof createSessionRuntimeLookup>
}> => {
  const root = await mkdtemp(join(tmpdir(), 'session-runtime-lookup-'))
  roots.push(root)
  const repository = new SessionRepository(root, dependencies)
  await repository.saveSession(session('current'))
  const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)
  if (hydrate) await coordinator.loadAllReadOnly()
  return { root, repository, findSessions: createSessionRuntimeLookup({ repository, coordinator }) }
}

const createSpecialist = (
  findSessions: ReturnType<typeof createSessionRuntimeLookup>
): SessionSpecialistReconfiguration =>
  new SessionSpecialistReconfiguration({
    sessionBinding: {
      resolve: async () => ({ kind: 'main' }),
      setBinding: () => undefined,
      clearSession: () => undefined
    },
    loadBinding: async (id) => (await findSessions(id))[0],
    persistBinding: async () => undefined
  })

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('runtime Session lookup', () => {
  it('shares concurrent reads but releases success and failure before delivering settlement', async () => {
    const loadSession = vi.fn().mockResolvedValue(session('current'))
    const repository = {
      loadSession,
      loadAll: vi.fn(),
      assertSessionIdentityOwnership: vi.fn().mockResolvedValue(undefined)
    }
    const findSessions = createSessionRuntimeLookup({
      repository,
      coordinator: { sessionProjectId: vi.fn().mockResolvedValue('project-1') }
    })
    await Promise.all(Array.from({ length: 16 }, () => findSessions('current')))
    expect(loadSession).toHaveBeenCalledTimes(1)
    loadSession.mockResolvedValueOnce({ ...session('current'), title: 'updated' })
    expect((await findSessions('current'))[0].title).toBe('updated')
    loadSession.mockRejectedValueOnce(new Error('read failed'))
    // Attach the retry directly to the rejection; no extra assertion microtasks hide stale entries.
    await findSessions('current').catch(() => findSessions('current'))
    expect(loadSession).toHaveBeenCalledTimes(4)
  })

  it('bounds opt-in profiling entries and does not record routine lookups', async () => {
    const { repository } = await createLookup()
    const prefix = 'open-science:persistence-runtime-lookup-'
    const names = ['catalog', 'ownership', 'read', 'targeted'].map((stage) => prefix + stage)
    try {
      vi.stubEnv('OPEN_SCIENCE_PERF_SESSION_TRACE', '1')
      const findSessions = createSessionRuntimeLookup({
        repository,
        coordinator: { sessionProjectId: async () => 'project-1' }
      })
      for (let i = 0; i < 3; i++) await findSessions('current')
      for (const name of names) expect(performance.getEntriesByName(name)).toHaveLength(1)
      for (const name of names) performance.clearMeasures(name)
      vi.stubEnv('OPEN_SCIENCE_PERF_SESSION_TRACE', '0')
      await createSessionRuntimeLookup({
        repository,
        coordinator: { sessionProjectId: async () => 'project-1' }
      })('current')
      for (const name of names) expect(performance.getEntriesByName(name)).toHaveLength(0)
    } finally {
      vi.unstubAllEnvs()
      for (const name of names) performance.clearMeasures(name)
    }
  })

  // Codex Responses and Codex Bridge share this durable framework identity and lookup.
  it.each(
    (['claude-code', 'opencode', 'codex'] as const).flatMap((frameworkId) =>
      (['Specialist admission', 'delegation settlement', 'delegation deletion'] as const).map(
        (boundary) => [frameworkId, boundary] as const
      )
    )
  )(
    '%s %s becomes ready without waiting for unrelated Session contents',
    async (frameworkId, boundary) => {
      const root = await mkdtemp(join(tmpdir(), 'session-runtime-lookup-'))
      roots.push(root)
      let holdUnrelatedReads = false
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let unrelatedReadStarted!: () => void
      const unrelatedRead = new Promise<'blocked on unrelated Session'>((resolve) => {
        unrelatedReadStarted = () => resolve('blocked on unrelated Session')
      })
      const repository = new SessionRepository(root, {
        readSessionFile: async (path) => {
          if (holdUnrelatedReads && basename(path) === 'unrelated.json') {
            unrelatedReadStarted()
            await held
          }
          return readFile(path, 'utf8')
        }
      })
      await repository.saveSession(session('current', frameworkId))
      await repository.saveSession(session('unrelated'))
      const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)
      await coordinator.loadAllReadOnly()
      const findSessions = createSessionRuntimeLookup({ repository, coordinator })
      const specialist = createSpecialist(findSessions)
      const delegation = createProductionDelegatedWorkComposition({
        dataRoot: root,
        sessions: {
          commands: coordinator,
          readSession: ({ projectId, sessionId }) => repository.loadSession(projectId, sessionId),
          findSessions
        },
        frameworks: {
          forSession: async () => {
            throw new Error('No child execution expected')
          }
        },
        resolveInput: async () => {
          throw new Error('No input resolution expected')
        },
        resolveExecutionModel: async () => {
          throw new Error('No model resolution expected')
        },
        settlementContinuations: {
          dispatch: () => {
            throw new Error('No continuation expected')
          }
        }
      })
      holdUnrelatedReads = true
      const admission =
        boundary === 'Specialist admission'
          ? specialist.assertUserPromptReady('current')
          : boundary === 'delegation settlement'
            ? delegation.root.rootTurnStarted!({
                sessionId: 'current',
                originatingPromptId: 'prompt-1'
              })
            : delegation.root.deleteSession('current')
      try {
        // Both outcomes are controlled by the filesystem gate, not wall-clock/model latency.
        await expect(Promise.race([admission.then(() => 'ready'), unrelatedRead])).resolves.toBe(
          'ready'
        )
      } finally {
        release()
        await admission
        await delegation.root.shutdown()
      }
    }
  )

  it('checks the latest durable pending binding instead of the hydration snapshot', async () => {
    const { repository, findSessions } = await createLookup()
    await repository.saveSession({
      ...session('current'),
      specialistId: 'specialist-1',
      specialistBindingPending: true
    })
    await expect(createSpecialist(findSessions).assertUserPromptReady('current')).rejects.toThrow(
      SPECIALIST_RECONFIGURATION_PENDING_ERROR
    )
  })

  it.each(['missing', 'unreadable'] as const)(
    'does not return stale contents for a %s Session',
    async (state) => {
      const { root, findSessions } = await createLookup()
      const file = join(root, 'sessions', 'project-1', 'current.json')
      if (state === 'missing') await rm(file)
      else await writeFile(file, 'invalid JSON')
      await expect(findSessions('current')).resolves.toEqual([])
    }
  )

  it('rejects a conflicting global identity introduced after hydration', async () => {
    const { root, findSessions } = await createLookup()
    await mkdir(join(root, 'sessions', 'project-2'))
    await writeFile(
      join(root, 'sessions', 'project-2', 'current.json'),
      await readFile(join(root, 'sessions', 'project-1', 'current.json'))
    )
    await expect(findSessions('current')).rejects.toThrow('already owned by another Project')
  })

  it('retains catalog discovery before hydration and returns no Session for an unsaved draft', async () => {
    const { findSessions } = await createLookup(false)
    await expect(findSessions('current')).resolves.toMatchObject([
      { id: 'current', projectId: 'project-1' }
    ])
    await expect(findSessions('unsaved')).resolves.toEqual([])
  })
  it('fails closed when a directory cannot prove the current Session has a unique owner', async () => {
    const { root, findSessions } = await createLookup(true, {
      readDirectoryEntries: async (path) => {
        if (basename(path) === 'project-2') {
          throw Object.assign(new Error('Directory access denied'), { code: 'EACCES' })
        }
        return readdir(path, { withFileTypes: true })
      }
    })
    await mkdir(join(root, 'sessions', 'project-2'))
    await expect(findSessions('current')).rejects.toThrow('global identity ownership is unreadable')
  })
})
