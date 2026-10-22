import { afterEach, expect, it, vi } from 'vitest'
import { englishNativeTranslator } from '../locale/main-process-messages'
import { composeSessionPackages, composeSessionPackageSurfaces } from './session-packages'
import { findBrowserImportPort } from '../session-package/test-helpers/browser-import-port'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import * as storageRoots from '../storage-root'
import * as projectDatabase from '../projects/prisma-client'
import { SessionRepository } from '../session-persistence/repository'
import { SessionProjectionRepository } from '../session-persistence/projection'
import {
  SessionPersistenceCoordinator,
  type SessionFileIndex
} from '../session-persistence/coordinator'
import {
  PackageImportRecoveryRequiredError,
  SessionPackageService
} from '../session-package/service'
import { join } from 'node:path'
import { readdir, stat } from 'node:fs/promises'

const native = vi.hoisted(() => ({ installQuitGuard: vi.fn() }))
vi.mock('../desktop-interaction', () => ({
  desktopInteraction: () => ({ installPackageQuitGuard: native.installQuitGuard })
}))
vi.mock('../session-package/inspection-worker-entry?nodeWorker', () => ({ default: vi.fn() }))
// Keep real archive inspection while the owner integration runs in this Node process.
vi.mock('../session-package/inspection-worker', async () => {
  const { inspectSessionPackage } = await import('../session-package/inspection')
  return { createPackageInspector: () => inspectSessionPackage }
})
const fixtures: Awaited<ReturnType<typeof createProvenanceTestFixture>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()))
})
configureTestRuntimeMetadata()

async function createPublicationFixture(): Promise<{
  target: Awaited<ReturnType<typeof createProvenanceTestFixture>>
  archive: string
  repository: SessionRepository
  owner: SessionPersistenceCoordinator
  compose: () => ReturnType<typeof composeSessionPackages>
}> {
  const source = await createProvenanceTestFixture()
  const target = await createProvenanceTestFixture()
  fixtures.push(source, target)
  storageRoots.initDataRoot(target.storageRoot)
  await source.client.project.create({ data: { id: 'source', name: 'Source' } })
  await target.client.project.create({ data: { id: 'target', name: 'Target' } })
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'original',
    projectId: 'source',
    title: 'Original title',
    cwd: '',
    status: 'idle',
    messages: [],
    createdAt: 1,
    updatedAt: 2
  })
  const archive = join(source.storageRoot, 'session.science')
  const exporter = new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client
  })
  try {
    await exporter.exportTo({ projectId: 'source', sessionId: 'original' }, archive)
  } finally {
    await exporter.close()
  }
  vi.spyOn(storageRoots, 'resolveConfigRoot').mockReturnValue(target.storageRoot)
  vi.spyOn(storageRoots, 'resolveDataRoot').mockReturnValue(target.storageRoot)
  vi.spyOn(projectDatabase, 'getProjectDbClient').mockResolvedValue(target.client)
  const repository = new SessionRepository(
    target.storageRoot,
    {},
    new SessionProjectionRepository(async () => target.client)
  )
  const owner = new SessionPersistenceCoordinator(repository, {
    syncSession: vi.fn().mockResolvedValue([]),
    softDeleteSession: vi.fn().mockResolvedValue('deletion'),
    restoreSession: vi.fn().mockResolvedValue(undefined),
    softDeleteProject: vi.fn().mockResolvedValue('deletion'),
    reconcileProjectSessions: vi.fn().mockResolvedValue(undefined),
    reconcileActiveSessions: vi.fn().mockResolvedValue(undefined),
    markReconciliationIncomplete: vi.fn()
  } satisfies SessionFileIndex)
  const compose = (): ReturnType<typeof composeSessionPackages> =>
    composeSessionPackages({
      settingsRepository: { getSettings: async () => ({}) },
      storedSettings: { pathsNormalizedAt: 1 },
      getDetectSessionExportBlockingSessions: () => () => [],
      modules: { add: (_: undefined, create: () => { capability: unknown }) => create().capability }
    } as unknown as Parameters<typeof composeSessionPackages>[0])
  return { target, archive, repository, owner, compose }
}

it('serializes the complete retained publication with normal Main metadata writes', async () => {
  const f = await createPublicationFixture()
  const composed = await f.compose()
  composed.packagePublicationOwner.current = f.owner
  const adopt = vi
    .spyOn(f.owner, 'adoptPublishedSession')
    .mockRejectedValueOnce(new Error('First adoption interrupted'))
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const reading = new Promise<void>((resolve) => {
    entered = resolve
  })
  let running: Promise<unknown> | undefined
  let writing: Promise<unknown> | undefined
  try {
    const failure = await composed.sessionPackageService
      .importFrom(f.archive, undefined, undefined, undefined, { projectId: 'target' })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PackageImportRecoveryRequiredError)
    const recovery = failure as PackageImportRecoveryRequiredError
    await composed.sessionPackageService.recover()
    expect(await readdir(join(f.target.storageRoot, 'session-package-imports'))).toEqual([])
    const { projectId, sessionId } = recovery.identity
    await f.owner.mutateSessionDetailsAuthority(projectId, sessionId, (current) => ({
      ...current,
      title: 'Previously organized title',
      pinned: true
    }))
    const load = SessionRepository.prototype.loadSessionWithDiagnostics
    let armed = true
    let heldRevision: number | undefined
    vi.spyOn(SessionRepository.prototype, 'loadSessionWithDiagnostics').mockImplementation(
      async function (this: SessionRepository, ...args) {
        const loaded = await Reflect.apply(load, this, args)
        if (armed && args[0] === projectId && args[1] === sessionId && loaded.status === 'found') {
          armed = false
          expect(args[2]).toMatchObject({ mode: 'read-only', preserveRuntimeState: true })
          expect(loaded.session).toMatchObject({
            title: 'Previously organized title',
            pinned: true
          })
          heldRevision = loaded.session.revision
          entered()
          await gate
        }
        return loaded
      }
    )
    running = recovery.resume()
    await reading
    let writerEntered = false
    // A normal Main organization mutation reads its own current authority after publication.
    writing = f.owner.mutateSessionDetailsAuthority(projectId, sessionId, (current) => {
      writerEntered = true
      return { ...current, title: 'Main newest title', pinned: true }
    })
    await f.owner.runSessionMutation('barrier-project', 'barrier-session', async () => {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    const enteredBeforeRelease = writerEntered
    if (enteredBeforeRelease) await writing
    release()
    await expect(running).resolves.toEqual(recovery.identity)
    await writing
    const after = await f.repository.loadSession(projectId, sessionId)
    expect(enteredBeforeRelease).toBe(false)
    expect(after).toMatchObject({ title: 'Main newest title', pinned: true })
    expect(after!.revision).toBe(heldRevision! + 2)
    expect(adopt).toHaveBeenCalledTimes(3)
    expect(await f.owner.sessionMetadataSnapshot()).toMatchObject({
      sessions: [expect.objectContaining({ projectId, id: sessionId, title: 'Main newest title' })]
    })
  } finally {
    release()
    await Promise.allSettled([running, writing])
    await composed.sessionPackageService.close()
  }
}, 15_000)

it('recovers startup publication before installing the live owner', async () => {
  const f = await createPublicationFixture()
  const seed = new SessionPackageService({
    storageRoot: f.target.storageRoot,
    getClient: async () => f.target.client,
    onSessionPublished: async () => {
      throw new Error('Restart before adoption')
    }
  })
  try {
    await expect(
      seed.importFrom(f.archive, undefined, undefined, undefined, { projectId: 'target' })
    ).rejects.toBeInstanceOf(PackageImportRecoveryRequiredError)
  } finally {
    await seed.close()
  }
  const adopt = vi.spyOn(f.owner, 'adoptPublishedSession')
  const composed = await f.compose()
  try {
    expect(composed.packagePublicationOwner.current).toBeUndefined()
    expect(adopt).not.toHaveBeenCalled()
    expect((await f.repository.loadAll()).sessions).toMatchObject([{ title: 'Original title' }])
    expect(await readdir(join(f.target.storageRoot, 'session-package-imports'))).toEqual([])
    composed.packagePublicationOwner.current = f.owner
    await expect(composed.sessionPackageService.importFrom(f.archive)).resolves.toMatchObject({
      projectId: expect.stringMatching(/^import-/)
    })
    // Hidden pending projects must still publish staged authority, then adopt outside the lane.
    expect(adopt).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingProjectImport: { operationId: expect.any(String) }
      })
    )
  } finally {
    await composed.sessionPackageService.close()
  }
}, 15_000)

it('preserves a running fork while retrying its live publication', async () => {
  const f = await createPublicationFixture()
  const composed = await f.compose()
  composed.packagePublicationOwner.current = f.owner
  try {
    const imported = await composed.sessionPackageService.importFrom(
      f.archive,
      undefined,
      undefined,
      undefined,
      { projectId: 'target' }
    )
    vi.spyOn(f.owner, 'adoptPublishedSession').mockRejectedValueOnce(
      new Error('Fork adoption interrupted')
    )
    const failure = await composed.sessionPackageService
      .fork(imported)
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({
      recovery: { projectId: 'target', sessionId: expect.any(String), outcome: 'committed' }
    })
    const { projectId, sessionId } = (
      failure as { recovery: { projectId: string; sessionId: string } }
    ).recovery
    const fork = await f.repository.loadSession(projectId, sessionId)
    expect(fork?.forkOrigin).toBeDefined()
    await f.owner.mutateRuntimeSession({ projectId, sessionId }, (current) => ({
      ...current,
      status: 'running'
    }))
    expect(
      await f.repository.loadSessionWithDiagnostics(projectId, sessionId, {
        mode: 'read-only',
        preserveRuntimeState: true
      })
    ).toMatchObject({ status: 'found', session: { status: 'running' } })
    await expect(composed.sessionPackageService.recover()).resolves.toBeUndefined()
    const durable = await f.repository.loadSessionWithDiagnostics(projectId, sessionId, {
      mode: 'read-only',
      preserveRuntimeState: true
    })
    expect(durable).toMatchObject({ status: 'found', session: { status: 'running' } })
  } finally {
    await composed.sessionPackageService.close()
  }
}, 15_000)

it('prevents retained recovery from recreating JSON during an actual Session deletion', async () => {
  const f = await createPublicationFixture()
  const composed = await f.compose()
  // Match the production owner's package-deletion preparation callback.
  const owner = new SessionPersistenceCoordinator(
    f.repository,
    {
      syncSession: async () => [],
      softDeleteSession: async () => 'deletion',
      restoreSession: async () => undefined,
      softDeleteProject: async () => 'deletion',
      reconcileProjectSessions: async () => undefined,
      reconcileActiveSessions: async () => undefined,
      markReconciliationIncomplete: () => undefined
    } satisfies SessionFileIndex,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (session) => composed.sessionPackageService.prepareSessionDeletion(session)
  )
  composed.packagePublicationOwner.current = owner
  const adopt = vi
    .spyOn(owner, 'adoptPublishedSession')
    .mockRejectedValueOnce(new Error('First adoption interrupted'))
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const deleting = new Promise<void>((resolve) => {
    entered = resolve
  })
  let published!: () => void
  const publication = new Promise<void>((resolve) => {
    published = resolve
  })
  let deletion: Promise<unknown> | undefined
  let running: Promise<unknown> | undefined
  try {
    const failure = await composed.sessionPackageService
      .importFrom(f.archive, undefined, undefined, undefined, { projectId: 'target' })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PackageImportRecoveryRequiredError)
    const recovery = failure as PackageImportRecoveryRequiredError
    const { projectId, sessionId } = recovery.identity
    expect((await owner.loadAll()).sessions.some((session) => session.id === sessionId)).toBe(true)
    const commitDelete = SessionProjectionRepository.prototype.commitDelete
    let armed = true
    vi.spyOn(SessionProjectionRepository.prototype, 'commitDelete').mockImplementation(
      async function (this: SessionProjectionRepository, ...args) {
        if (armed && args[0] === projectId && args[1] === sessionId) {
          armed = false
          entered()
          await gate
        }
        return Reflect.apply(commitDelete, this, args)
      }
    )
    const realAdopt = SessionPersistenceCoordinator.prototype.adoptPublishedSession.bind(owner)
    adopt.mockImplementation((value) => {
      published()
      return realAdopt(value)
    })
    deletion = owner.deleteSession(projectId, sessionId)
    await deleting
    expect(await f.repository.loadSession(projectId, sessionId)).toBeUndefined()
    running = recovery.resume().catch((error: unknown) => error)
    let timer: ReturnType<typeof setTimeout> | undefined
    // The correct path waits behind deletion. If publication enters, let that actual write
    // finish before releasing deletion so a missing-lane regression produces a durable assertion.
    await Promise.race([
      publication,
      running,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2000)
      })
    ]).finally(() => {
      if (timer) clearTimeout(timer)
    })
    release()
    await deletion
    expect(await running).toMatchObject({
      cause: expect.objectContaining({ message: 'Cannot mutate a session that has been deleted.' })
    })
    const row = await f.target.client.session.findUniqueOrThrow({ where: { id: sessionId } })
    expect(row.deletedAtMs).not.toBeNull()
    const jsonPath = join(f.target.storageRoot, 'sessions', projectId, sessionId + '.json')
    expect(
      await stat(jsonPath).then(
        () => true,
        () => false
      )
    ).toBe(false)
    expect(await f.repository.loadSession(projectId, sessionId)).toBeUndefined()
    expect(
      (await owner.sessionMetadataSnapshot()).sessions.some((session) => session.id === sessionId)
    ).toBe(false)
    expect(await readdir(join(f.target.storageRoot, 'session-package-imports'))).toHaveLength(1)
    // The committed SQLite tombstone is terminal: a later retry may finish journal cleanup.
    await expect(recovery.resume()).resolves.toEqual(recovery.identity)
    expect(await readdir(join(f.target.storageRoot, 'session-package-imports'))).toEqual([])
    expect(
      await stat(jsonPath).then(
        () => true,
        () => false
      )
    ).toBe(false)
  } finally {
    release()
    await Promise.allSettled([deletion, running])
    await composed.sessionPackageService.close()
  }
}, 15_000)

it.each(['update', 'quit'])(
  'keeps the %s guard active while browser receipt is in progress',
  async (kind) => {
    const lifecycle = { isActive: () => false, close: async () => {} }
    // No export/import is started: unrelated repository dependencies are never called.
    const surfaces = composeSessionPackageSurfaces({
      declareElectronAdapter: (name, install) => {
        if (name === 'session-package-quit-guard') install()
      },
      sessionPackageDesktopLifecycle: lifecycle,
      packageHandoffHeld: { current: false },
      translate: englishNativeTranslator
    } as Parameters<typeof composeSessionPackageSurfaces>[0])
    const canBlockQuit = native.installQuitGuard.mock.calls[0][0] as () => boolean
    const opening = surfaces.browserPackageImport.begin(
      'open-science://import?' +
        new URLSearchParams({
          version: '1',
          origin: 'https://example.com',
          secret: 'ab'.repeat(32),
          port: String(await findBrowserImportPort()),
          name: 'study.science',
          size: '5'
        })
    )
    try {
      expect(surfaces.sessionPackageDesktop.operations.active).toBe(false)
      expect(kind === 'update' ? lifecycle.isActive() : canBlockQuit()).toBe(true)
      await opening
      expect(lifecycle.isActive()).toBe(true)
      await lifecycle.close()
      expect(lifecycle.isActive()).toBe(false)
      expect(canBlockQuit()).toBe(false)
    } finally {
      await opening
      await lifecycle.close()
    }
  }
)

it('routes receipt progress and targeted cancellation through the existing package surface', async () => {
  const lifecycle = { isActive: () => false, close: async () => {} }
  const publish = vi.fn()
  const surfaces = composeSessionPackageSurfaces({
    declareElectronAdapter: () => {},
    sessionPackageDesktopLifecycle: lifecycle,
    packageHandoffHeld: { current: false },
    applicationEvents: { publish },
    translate: englishNativeTranslator
  } as unknown as Parameters<typeof composeSessionPackageSurfaces>[0])
  try {
    await surfaces.browserPackageImport.begin(
      'open-science://import?' +
        new URLSearchParams({
          version: '1',
          origin: 'https://example.com',
          secret: 'ab'.repeat(32),
          port: String(await findBrowserImportPort()),
          name: 'study.science',
          size: '5'
        })
    )
    const snapshot = surfaces.sessionPackageDesktop.operations.snapshot!
    expect(snapshot.browserTransfers).toMatchObject([
      { filename: 'study.science', state: 'waiting', completedBytes: 0 }
    ])
    expect(publish).toHaveBeenCalledWith(
      'sessions:package-operation-changed',
      expect.objectContaining({ browserTransfers: snapshot.browserTransfers })
    )
    await surfaces.sessionPackageDesktop.respond({
      action: 'cancel-browser-transfer',
      operationId: snapshot.id,
      transferId: snapshot.browserTransfers![0].id
    })
    expect(surfaces.sessionPackageDesktop.operations.snapshot?.browserTransfers).toMatchObject([
      { state: 'cancelled' }
    ])
    expect(lifecycle.isActive()).toBe(false)
  } finally {
    await lifecycle.close()
  }
})
