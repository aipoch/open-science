import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import { createTaskCallerContext } from '../caller-context'
import { SessionRepository } from '../session-persistence/repository'
import { initDataRoot } from '../storage-root'
import {
  SessionPackageHeadless,
  type HeadlessPackageImportPreview,
  type SessionPackageHeadlessDependencies
} from './headless'
import { SessionPackageService } from './service'
import type { SessionPackagePreview, SessionPackageRequest } from '../../shared/session-package'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const fixtures: Array<Awaited<ReturnType<typeof createProvenanceTestFixture>>> = []
const owners: SessionPackageHeadless[] = []
const services: SessionPackageService[] = []
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()))
  await Promise.all(services.splice(0).map((service) => service.close()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()))
  initDataRoot(undefined)
})
const caller = createTaskCallerContext({ clientId: 'local-client' })
const scope = { projectId: 'project-1', sessionId: 'session-1' }
const preview: SessionPackagePreview = {
  title: 'Research',
  projectName: 'Project',
  branchCount: 1,
  messageCount: 0,
  fileCount: 0,
  totalBytes: 0,
  omissions: []
}
const dependencies = (
  service: SessionPackageHeadlessDependencies['service']
): SessionPackageHeadlessDependencies => ({
  service,
  assertCanStart: vi.fn(),
  withDataRootWrite: vi.fn(async (operation) => operation()),
  reserveExport: vi.fn(async () => vi.fn()),
  reserveImport: vi.fn(async () => vi.fn()),
  afterImport: vi.fn(async () => undefined)
})
const addOwner = (deps: SessionPackageHeadlessDependencies): SessionPackageHeadless => {
  const owner = new SessionPackageHeadless(deps)
  owners.push(owner)
  return owner
}
const realFixture = async (): Promise<{
  fixture: Awaited<ReturnType<typeof createProvenanceTestFixture>>
  service: SessionPackageService
  owner: SessionPackageHeadless
  deps: SessionPackageHeadlessDependencies
}> => {
  const fixture = await createProvenanceTestFixture()
  fixtures.push(fixture)
  initDataRoot(fixture.storageRoot)
  await fixture.client.project.create({ data: { id: scope.projectId, name: 'Research Project' } })
  await new SessionRepository(fixture.storageRoot).saveSession({
    ...scope,
    id: scope.sessionId,
    title: 'Research',
    cwd: '',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    messages: [
      {
        id: 'message',
        role: 'user',
        content: 'An offline scientific observation.',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
    ]
  })
  await mkdir(join(fixture.storageRoot, 'notebooks', scope.projectId, scope.sessionId, 'data'), {
    recursive: true
  })
  await writeFile(
    join(fixture.storageRoot, 'notebooks', scope.projectId, scope.sessionId, 'data', 'data.csv'),
    'sample,value\na,1\n'
  )
  const service = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  services.push(service)
  const deps = dependencies(service)
  return { fixture, service, deps, owner: addOwner(deps) }
}
const stubImport = (): SessionPackageHeadlessDependencies['service'] => ({
  exportTo: vi.fn(async (_scope, path) => {
    await writeFile(path, 'exported archive')
    return preview
  }),
  importFrom: vi.fn(async (_path, signal, _progress, confirm) => {
    await confirm!(preview, signal!)
    signal!.throwIfAborted()
    return { projectId: 'target', sessionId: 'imported' }
  })
})
const stubFixture = async (): Promise<{
  path: string
  root: string
  service: ReturnType<typeof stubImport>
  deps: SessionPackageHeadlessDependencies
  owner: SessionPackageHeadless
}> => {
  const fixture = await createProvenanceTestFixture()
  fixtures.push(fixture)
  const path = join(fixture.storageRoot, 'source.science')
  await writeFile(path, 'archive')
  const service = stubImport()
  const deps = dependencies(service)
  return { path, root: fixture.storageRoot, service, deps, owner: addOwner(deps) }
}

describe('headless package transfers', () => {
  it('round-trips a real .science package through explicit preflight and commit without executing history', async () => {
    const source = await realFixture()
    const destination = join(source.fixture.storageRoot, 'research.science')
    await source.owner.call('export', { ...scope, filePath: destination }, caller)
    expect(source.deps.reserveExport).toHaveBeenCalledWith(scope, expect.any(AbortSignal))
    const exportedBytes = await readFile(destination)
    const target = await realFixture()
    const before = await target.fixture.client.session.count()
    const inspection = (await target.owner.call(
      'preflightImport',
      { filePath: destination, target: { projectId: scope.projectId } },
      caller
    )) as HeadlessPackageImportPreview
    expect(inspection.preview).toMatchObject({ title: 'Research', messageCount: 1 })
    expect(await target.fixture.client.session.count()).toBe(before)
    expect(target.deps.afterImport).not.toHaveBeenCalled()
    // The reviewed package is already in the existing service's private validated staging.
    await writeFile(destination, 'changed after preflight')
    const imported = (await target.owner.call(
      'commitImport',
      { preflightId: inspection.preflightId },
      caller
    )) as SessionPackageRequest
    const session = await new SessionRepository(target.fixture.storageRoot).loadSession(
      imported.projectId,
      imported.sessionId
    )
    expect(session?.packageOrigin).toBeDefined()
    expect(session?.messages[0].content).toBe('An offline scientific observation.')
    expect(target.deps.afterImport).toHaveBeenCalledOnce()
    expect(target.deps.afterImport).toHaveBeenCalledWith(
      { projectId: imported.projectId, sessionId: imported.sessionId },
      caller.lifecycleClientId,
      false
    )
    expect(
      await target.owner.call('commitImport', { preflightId: inspection.preflightId }, caller)
    ).toMatchObject(imported)
    expect(await target.fixture.client.session.count()).toBe(before + 1)
    const forwarded = join(target.fixture.storageRoot, 'forwarded.science')
    const importedScope = { projectId: imported.projectId, sessionId: imported.sessionId }
    await target.owner.call('export', { ...importedScope, filePath: forwarded }, caller)
    expect(await target.service.inspect(forwarded)).toMatchObject({
      title: 'Research',
      messageCount: 1
    })
    expect(exportedBytes.length).toBeGreaterThan(0)
    await expect(
      target.owner.call('export', { ...importedScope, filePath: forwarded }, caller)
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(await target.service.inspect(forwarded)).toMatchObject({ title: 'Research' })
  }, 60_000)

  it('rejects anonymous, revoked and remote callers before any file or service operation', async () => {
    const f = await stubFixture()
    for (const context of [
      undefined,
      createTaskCallerContext({ location: 'remote' }),
      createTaskCallerContext({ isAuthorizationCurrent: () => false })
    ]) {
      await expect(
        f.owner.call(
          'preflightImport',
          { filePath: f.path, target: { projectId: 'target' } },
          context
        )
      ).rejects.toMatchObject({
        code: context?.location === 'remote' ? 'unsupported_location' : 'unauthorized'
      })
    }
    expect(f.service.importFrom).not.toHaveBeenCalled()
  })

  it('requires explicit paths and destinations, and provides no sensitive-export bypass', async () => {
    const f = await stubFixture()
    await expect(
      f.owner.call('preflightImport', { filePath: f.path, target: {} }, caller)
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      f.owner.call(
        'preflightImport',
        { filePath: 'relative.science', target: { projectId: 'target' } },
        caller
      )
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      f.owner.call('export', { ...scope, filePath: f.path, allowSensitiveContent: true }, caller)
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(f.service.importFrom).not.toHaveBeenCalled()
    expect(f.service.exportTo).not.toHaveBeenCalled()
  })

  it('holds the import reservation through review, binds commit to the caller and releases on cancellation', async () => {
    const f = await stubFixture()
    const release = vi.fn()
    vi.mocked(f.deps.reserveImport).mockResolvedValue(release)
    const inspected = (await f.owner.call(
      'preflightImport',
      { filePath: f.path, target: { projectId: 'target' } },
      caller
    )) as HeadlessPackageImportPreview
    expect(release).not.toHaveBeenCalled()
    expect(f.owner.hasActiveTransfer()).toBe(true)
    await expect(
      f.owner.call('preflightImport', { filePath: f.path, target: { projectId: 'target' } }, caller)
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(
      f.owner.call(
        'commitImport',
        { preflightId: inspected.preflightId },
        createTaskCallerContext({ clientId: 'another-client' })
      )
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(
      await f.owner.call('cancelImport', { preflightId: inspected.preflightId }, caller)
    ).toEqual({ cancelled: true })
    expect(release).toHaveBeenCalledOnce()
    expect(f.deps.afterImport).not.toHaveBeenCalled()
    expect(f.owner.hasActiveTransfer()).toBe(false)
  })

  it('expires previews without publishing or retaining their import lock', async () => {
    const f = await stubFixture()
    f.deps.previewLifetimeMs = 10
    const owner = addOwner(f.deps)
    const release = vi.fn()
    vi.mocked(f.deps.reserveImport).mockResolvedValue(release)
    const inspected = (await owner.call(
      'preflightImport',
      { filePath: f.path, target: { projectId: 'target' } },
      caller
    )) as HeadlessPackageImportPreview
    await vi.waitFor(() => expect(owner.hasActiveTransfer()).toBe(false))
    await expect(
      owner.call('commitImport', { preflightId: inspected.preflightId }, caller)
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(release).toHaveBeenCalledOnce()
    expect(f.deps.afterImport).not.toHaveBeenCalled()
  })

  it('rechecks authorization at commit and closes unfinished preflights cleanly', async () => {
    const f = await stubFixture()
    let authorized = true
    const context = createTaskCallerContext({
      clientId: 'revocable',
      isAuthorizationCurrent: () => authorized
    })
    const inspected = (await f.owner.call(
      'preflightImport',
      { filePath: f.path, target: { projectId: 'target' } },
      context
    )) as HeadlessPackageImportPreview
    authorized = false
    await expect(
      f.owner.call('commitImport', { preflightId: inspected.preflightId }, context)
    ).rejects.toMatchObject({ code: 'unauthorized' })
    await f.owner.close()
    expect(f.owner.hasActiveTransfer()).toBe(false)
    expect(f.deps.afterImport).not.toHaveBeenCalled()
  })

  it('publishes exclusively even if another file appears after export starts', async () => {
    const f = await stubFixture()
    const destination = join(f.root, 'result.science')
    vi.mocked(f.service.exportTo).mockImplementation(async (_scope, temporary) => {
      await writeFile(temporary, 'archive')
      await writeFile(destination, 'user file')
      return preview
    })
    await expect(
      f.owner.call('export', { ...scope, filePath: destination }, caller)
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(await readFile(destination, 'utf8')).toBe('user file')
  })

  it('does not publish an exported file when authorization is revoked during snapshotting', async () => {
    const f = await stubFixture()
    const destination = join(f.root, 'result.science')
    let authorized = true
    const context = createTaskCallerContext({ isAuthorizationCurrent: () => authorized })
    vi.mocked(f.service.exportTo).mockImplementation(async (_scope, temporary) => {
      await writeFile(temporary, 'archive')
      authorized = false
      return preview
    })
    await expect(
      f.owner.call('export', { ...scope, filePath: destination }, context)
    ).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves committed success when UI notification delivery fails', async () => {
    const f = await stubFixture()
    vi.mocked(f.deps.afterImport).mockRejectedValue(new Error('UI unavailable'))
    const inspected = (await f.owner.call(
      'preflightImport',
      { filePath: f.path, target: { projectName: 'New Project' } },
      caller
    )) as HeadlessPackageImportPreview
    expect(
      await f.owner.call('commitImport', { preflightId: inspected.preflightId }, caller)
    ).toMatchObject({ projectId: 'target', sessionId: 'imported' })
    expect(f.deps.reserveImport).not.toHaveBeenCalled()
  })
})

const { configureTestElectronHost } = await import('../../../test/runtime-host')
await configureTestElectronHost(await import('electron'))
