import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { composeApplicationRuntime } from '../application-runtime'
import { disconnectProjectDbClient } from '../projects/prisma-client'
import { SessionRepository } from '../session-persistence/repository'
import { initDataRoot } from '../storage-root'
import { composeBackgroundResults } from './background-results'

configureTestRuntimeMetadata()
let root: string
let dispose: (() => Promise<void>) | undefined

afterEach(async () => {
  await dispose?.()
  await disconnectProjectDbClient()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  if (root) await rm(root, { recursive: true, force: true })
})

it('uses identity-only startup and periodic recovery while preserving admissions made during the scan', async () => {
  root = await mkdtemp(join(tmpdir(), 'background-result-catalog-'))
  vi.stubEnv('OPEN_SCIENCE_CONFIG_ROOT', root)
  initDataRoot(root)
  const directory = join(root, 'sessions', 'project')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'history.json'), 'conversation body must not be parsed')
  const bodyReads = vi.fn((path: string) => readFile(path, 'utf8'))
  let duringScan: (() => Promise<void>) | undefined
  const repository = new SessionRepository(root, {
    readSessionFile: bodyReads,
    readDirectoryEntries: async (path) => {
      const entries = await readdir(path, { withFileTypes: true })
      if (path === join(root, 'sessions') && duringScan) {
        const work = duringScan
        duringScan = undefined
        await work()
      }
      return entries
    }
  })
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const runtime = await composeApplicationRuntime((modules) =>
    composeBackgroundResults({
      modules,
      applicationEvents: { publish: () => undefined },
      runtimeRef: { current: undefined },
      resolveSessionAgentTarget: async () => {
        throw new Error('Unexpected target resolution')
      },
      getSessionRepository: () => repository,
      getSessionPersistenceCoordinator: () => ({}),
      getNotebookCommands: () => ({}),
      getJobRepository: () => ({}),
      getHostRepository: () => ({})
    } as unknown as Parameters<typeof composeBackgroundResults>[0])
  )
  dispose = () => runtime.dispose()
  const composed = runtime.interfaces
  composed.markNotebookResultAuthorityReady()
  composed.markComputeResultAuthorityReady()
  const deliveries = composed.backgroundResultDeliveryRepository
  const register = (sourceId: string, sessionId: string): ReturnType<typeof deliveries.register> =>
    deliveries.register({
      sourceKind: 'local-run',
      sourceId,
      projectId: 'project',
      sessionId
    })
  await register('owned', 'history')
  await register('orphan', 'gone')
  duringScan = async () => {
    await register('new-admission', 'not-yet-published')
  }

  await composed.backgroundResultDelivery.recover()
  expect(bodyReads).not.toHaveBeenCalled()
  expect((await deliveries.listOwnership()).map(({ id }) => id).sort()).toEqual([
    'local-run:new-admission',
    'local-run:owned'
  ])

  await register('periodic-orphan', 'also-gone')
  await vi.advanceTimersByTimeAsync(30_000)
  await vi.waitFor(async () => {
    expect((await deliveries.listOwnership()).map(({ id }) => id)).toEqual(['local-run:owned'])
  })
  expect(bodyReads).not.toHaveBeenCalled()
})
