import { SessionProjectionRepository } from '../session-persistence/projection'
import { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import { ManagedFileIndexRepository } from '../project-files/repository'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { UploadRepository } from '../uploads/repository'
import { ProvenanceMessageSnapshotRepository } from '../artifacts/provenance-message-snapshot'
import { configureTestElectronHost } from '../../../test/runtime-host'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rm, readdir, utimes } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, expect, it, vi } from 'vitest'
import { createProvenanceTestFixture } from '../artifacts/provenance-test-fixtures'
import {
  createLinearConversationGraph,
  forkEditedConversationMessage
} from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { SessionRepository } from '../session-persistence/repository'
import { initDataRoot } from '../storage-root'
import { researchFilmScopeKey } from '../research-video/stored-presentation'
import { createResearchVideoPresentationOwner } from '../research-video/presentation'
import { SessionPackageService } from './service'
import { captureResearchFilms, validateResearchFilms } from './research-films'
import { readPackageArchive } from './archive'
import type { SessionPackageManifest, PackageSelectionSummary } from '../../shared/session-package'
import type { PackageRecords } from './records-contract'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false }
}))
const fixtures: Awaited<ReturnType<typeof createProvenanceTestFixture>>[] = []
const services: SessionPackageService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()))
  initDataRoot(undefined)
})
async function setup(): Promise<{
  root: string
  service: SessionPackageService
  repository: SessionRepository
}> {
  const fixture = await createProvenanceTestFixture()
  fixtures.push(fixture)
  initDataRoot(fixture.storageRoot)
  await fixture.client.project.create({ data: { id: 'project', name: 'Research' } })
  const repository = new SessionRepository(fixture.storageRoot)
  await repository.saveSession({
    id: 'session',
    projectId: 'project',
    title: 'Evidence',
    cwd: '',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    conversationGraph: forkEditedConversationMessage(
      createLinearConversationGraph({
        sessionId: 'session',
        createdAt: 1,
        updatedAt: 2,
        messages: [
          {
            id: 'question',
            role: 'user',
            content: 'Study',
            status: 'complete',
            eventIds: [],
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'answer',
            role: 'agent',
            content: 'Uncertain result.',
            status: 'complete',
            eventIds: [],
            createdAt: 2,
            updatedAt: 2
          }
        ]
      }),
      'question',
      'Another question',
      3
    )
  })
  const service = new SessionPackageService({
    storageRoot: fixture.storageRoot,
    getClient: async () => fixture.client
  })
  services.push(service)
  return { root: fixture.storageRoot, service, repository }
}
async function saveFilm(
  root: string,
  session: PersistedChatSession,
  branchId?: string,
  title = 'Evidence'
): Promise<string> {
  const id = randomUUID(),
    base = join(
      root,
      'research-video-presentations',
      researchFilmScopeKey({ projectId: session.projectId, sessionId: session.id, branchId })
    ),
    directory = join(base, id)
  await mkdir(join(directory, 'output'), { recursive: true })
  await writeFile(
    join(directory, 'session.json'),
    JSON.stringify({
      provenance: { projectId: session.projectId, sessionId: session.id, branchId }
    })
  )
  await writeFile(
    join(directory, 'output/player.html'),
    `<html><body>${title}<audio controls></audio></body></html>`
  )
  await writeFile(
    join(directory, 'output/sources.zip'),
    zipSync({ 'video.json': Buffer.from(JSON.stringify({ title })) })
  )
  await writeFile(join(base, 'latest.json'), JSON.stringify({ id, title, duration: 3 }))
  return directory
}
const include = async (): Promise<{
  excludedStorageKeys: string[]
  includePdfNotes: boolean
  includeResearchFilms: boolean
}> => ({ excludedStorageKeys: [], includePdfNotes: false, includeResearchFilms: true })
async function unpack(
  archive: string,
  directory: string
): Promise<{ manifest: SessionPackageManifest; records: PackageRecords }> {
  await mkdir(directory)
  const manifest = await readPackageArchive(archive, directory)
  const records = JSON.parse(
    await readFile(join(directory, 'records.json'), 'utf8')
  ) as PackageRecords
  return { manifest, records }
}

it('hides absent or incomplete films and defaults completed films to excluded', async () => {
  const f = await setup(),
    session = (await f.repository.loadSession('project', 'session'))!
  let summary: PackageSelectionSummary | undefined
  const exportSummary = async (name: string): ReturnType<typeof unpack> => {
    const path = join(f.root, `${name}.science`)
    await f.service.exportTo({ projectId: 'project', sessionId: 'session' }, path, {
      selectFiles: async (_files, _signal, next) => {
        summary = next
        return []
      }
    })
    return unpack(path, join(f.root, name))
  }
  await exportSummary('none')
  expect(summary?.researchFilms).toBeUndefined()
  const directory = await saveFilm(f.root, session, session.conversationGraph!.branches[0].id)
  const { manifest, records } = await exportSummary('default')
  expect(summary?.researchFilms).toMatchObject({ count: 1, sizeBytes: expect.any(Number) })
  expect(records.researchFilms).toBeUndefined()
  expect(manifest.requiredFeatures).not.toContain('research-film')
  await rm(join(directory, 'output/sources.zip'))
  await exportSummary('incomplete')
  expect(summary?.researchFilms).toBeUndefined()
})

it('round-trips all branches, plays without generation, forwards opt-in films and preserves them when forking', async () => {
  const f = await setup(),
    session = (await f.repository.loadSession('project', 'session'))!,
    branches = session.conversationGraph!.branches
  for (const [index, branch] of branches.entries())
    await saveFilm(f.root, session, branch.id, `Branch ${index}`)
  const archive = join(f.root, 'films.science')
  await f.service.exportTo({ projectId: 'project', sessionId: 'session' }, archive, {
    selectFiles: include
  })
  const { manifest, records } = await unpack(archive, join(f.root, 'exported'))
  expect(records.researchFilms).toHaveLength(branches.length)
  expect(manifest.requiredFeatures).toContain('research-film')
  await rm(join(f.root, 'research-video-presentations'), { recursive: true })
  const imported = await f.service.importFrom(archive)
  const origin = await f.service.readOrigin(imported)
  const acquireUse = vi.fn(),
    generate = vi.fn(),
    writeScreenplay = vi.fn()
  const owner = createResearchVideoPresentationOwner({
    dataRoot: () => f.root,
    loadSession: (p, s) => f.repository.loadSession(p, s),
    loadImportedFilm: (r) => f.service.readResearchFilm(r),
    models: { acquireUse } as never,
    generate,
    writeScreenplay,
    engineDirectory: ''
  })
  try {
    for (const [index, branch] of branches.entries()) {
      const status = await owner.status({ ...imported, branchId: origin.identities[branch.id] })
      expect(status.result?.title).toBe(`Branch ${index}`)
      expect(await readFile(status.result!.playerPath, 'utf8')).toContain(`Branch ${index}`)
    }
    expect(acquireUse).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
    expect(writeScreenplay).not.toHaveBeenCalled()
  } finally {
    await owner.close()
  }
  const forwarded = join(f.root, 'forwarded.science')
  await f.service.exportTo(imported, forwarded, { selectFiles: include })
  expect((await unpack(forwarded, join(f.root, 'forwarded'))).records.researchFilms).toEqual(
    records.researchFilms
  )
  const excluded = join(f.root, 'excluded.science')
  await f.service.exportTo(imported, excluded)
  const omitted = await unpack(excluded, join(f.root, 'excluded'))
  expect(omitted.records.researchFilms).toBeUndefined()
  expect(
    omitted.manifest.inventory.some((file) => file.storageKey?.includes('.research-films'))
  ).toBe(false)
  const fork = await f.service.fork(imported)
  expect((await f.service.readResearchFilm(fork))?.title).toBeDefined()
  const importedSession = (await f.repository.loadSession(imported.projectId, imported.sessionId))!
  const branchId = origin.identities[branches[0].id]
  const local = await saveFilm(f.root, importedSession, branchId, 'Updated film')
  await f.service.exportTo(imported, join(f.root, 'updated.science'), { selectFiles: include })
  const updated = await unpack(join(f.root, 'updated.science'), join(f.root, 'updated'))
  expect(
    updated.records.researchFilms?.find((film) => film.branchId === branches[0].id)?.title
  ).toBe('Updated film')
  expect(await readFile(join(local, 'output/player.html'), 'utf8')).toContain('Updated film')
  for (const mutate of [
    (m: SessionPackageManifest) => {
      m.requiredFeatures = m.requiredFeatures?.filter((feature) => feature !== 'research-film')
    },
    (m: SessionPackageManifest) => {
      m.inventory = m.inventory.filter(
        (entry) => entry.storageKey !== records.researchFilms![0].playerStorageKey
      )
    }
  ]) {
    const invalid = structuredClone(manifest)
    mutate(invalid)
    expect(() => validateResearchFilms(records, invalid, session)).toThrow()
  }
  const wrong = structuredClone(records)
  wrong.researchFilms![0].playerStorageKey = 'artifacts/another/session/.research-films/player.html'
  expect(() => validateResearchFilms(wrong, manifest, session)).toThrow('ownership')
  const invalidBranch = structuredClone(records)
  invalidBranch.researchFilms![0].branchId = 'missing'
  expect(() => validateResearchFilms(invalidBranch, manifest, session)).toThrow('branch')
}, 60_000)

await configureTestElectronHost(await import('electron'))

it('chooses the newest local completion per branch, including legacy unscoped receipts', async () => {
  const f = await setup(),
    session = (await f.repository.loadSession('project', 'session'))!
  const branchId = session.conversationGraph!.branches[0].id
  const explicit = await saveFilm(f.root, session, branchId, 'Older')
  const legacy = await saveFilm(f.root, session, undefined, 'Newer')
  await writeFile(
    join(legacy, 'session.json'),
    JSON.stringify({
      provenance: { projectId: session.projectId, sessionId: session.id, branchId }
    })
  )
  await utimes(join(dirname(explicit), 'latest.json'), 1, 1)
  const captured = await captureResearchFilms(f.root, session)
  expect(captured.films).toHaveLength(1)
  expect(captured.films[0].title).toBe('Newer')
})

it('rejects a film changed during selection without replacing the previous export', async () => {
  const f = await setup(),
    session = (await f.repository.loadSession('project', 'session'))!
  const directory = await saveFilm(f.root, session, session.conversationGraph!.branches[0].id)
  const archive = join(f.root, 'previous.science')
  await writeFile(archive, 'previous')
  await expect(
    f.service.exportTo({ projectId: 'project', sessionId: 'session' }, archive, {
      selectFiles: async () => {
        await writeFile(join(directory, 'output/player.html'), 'Changed film')
        return include()
      }
    })
  ).rejects.toThrow('changed during export')
  expect(await readFile(archive, 'utf8')).toBe('previous')
})

it('rolls back imported film files on cancellation and collects them through existing deletion recovery', async () => {
  const f = await setup(),
    session = (await f.repository.loadSession('project', 'session'))!
  const local = await saveFilm(f.root, session, session.conversationGraph!.branches[0].id)
  const archive = join(f.root, 'films.science')
  await f.service.exportTo({ projectId: 'project', sessionId: 'session' }, archive, {
    selectFiles: include
  })
  const before = await readdir(join(f.root, 'artifacts')).catch(() => [])
  const controller = new AbortController()
  await expect(
    f.service.importFrom(archive, controller.signal, (progress) => {
      if (progress.importStage === 'verify-files') controller.abort(new Error('cancelled import'))
    })
  ).rejects.toThrow('cancelled import')
  expect(await readdir(join(f.root, 'artifacts')).catch(() => [])).toEqual(before)
  const imported = await f.service.importFrom(archive)
  const player = await f.service.readResearchFilm({
    ...imported,
    branchId: (await f.service.readOrigin(imported)).identities[
      session.conversationGraph!.branches[0].id
    ]
  })
  expect(player).toBeDefined()
  const getClient = f.service.options.getClient
  const versions = new ManagedFileVersionService({ storageRoot: f.root, getClient })
  const coordinator = new SessionPersistenceCoordinator(
    new SessionRepository(f.root, {}, new SessionProjectionRepository(getClient)),
    new ManagedFileIndexRepository(
      getClient,
      f.root,
      versions,
      new UploadRepository(f.root, { getClient })
    ),
    undefined,
    new ProvenanceMessageSnapshotRepository({ storageRoot: f.root, getClient }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (session) => f.service.prepareSessionDeletion(session)
  )
  await coordinator.deleteSession(imported.projectId, imported.sessionId)
  await f.service.recover({ collectDeletedPackages: true })
  await expect(readFile(player!.playerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await readFile(archive)).length).toBeGreaterThan(0)
  expect((await readFile(join(local, 'output/player.html'))).length).toBeGreaterThan(0)
}, 60_000)
