import { afterEach, expect, it, vi } from 'vitest'
import { dirname, join } from 'node:path'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createProjectDbClient } from '../projects/prisma-client'
import * as fs from 'node:fs/promises'
import { sha256 } from '../artifacts/provenance-canonical'
import { createUploadVersionReference } from '../../shared/uploads'
import {
  createLinearConversationGraph,
  forkEditedConversationMessage
} from '../../shared/conversation-graph'
import {
  createProvenanceTestFixture,
  createArtifactVersionRequest
} from '../artifacts/provenance-test-fixtures'
import { createPngInlineSource } from '../artifacts/artifact-test-fixtures'
import { ReviewRepository } from '../reviewer/repository'
import { SessionRepository } from '../session-persistence/repository'
import { SessionProjectionRepository } from '../session-persistence/projection'
import { SessionPersistenceCoordinator } from '../session-persistence/coordinator'
import { ManagedFileIndexRepository } from '../project-files/repository'
import { ProvenanceMessageSnapshotRepository } from '../artifacts/provenance-message-snapshot'
import { SessionPackageService } from './service'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { UploadRepository } from '../uploads/repository'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>())
}))

const fixtures: Awaited<ReturnType<typeof createProvenanceTestFixture>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()))
})

const importedFixture = async (
  withUpload = false,
  withArtifact = false,
  separateConfig = false
): Promise<{
  source: Awaited<ReturnType<typeof createProvenanceTestFixture>>
  target: Awaited<ReturnType<typeof createProvenanceTestFixture>>
  service: SessionPackageService
  identity: { projectId: string; sessionId: string }
  sessions: SessionRepository
  coordinator: SessionPersistenceCoordinator
  content: string
  archive: string
}> => {
  const source = await createProvenanceTestFixture()
  const target = await createProvenanceTestFixture()
  fixtures.push(source, target)
  const configRoot = separateConfig ? join(target.storageRoot, 'configuration') : target.storageRoot
  await mkdir(configRoot, { recursive: true })
  await source.client.project.create({ data: { id: 'source', name: 'Source' } })
  await target.client.project.create({ data: { id: 'target', name: 'Destination' } })
  if (withUpload) {
    const key = 'uploads/source/upstream/upload-1/versions/version-1/content'
    await mkdir(dirname(join(source.storageRoot, key)), { recursive: true })
    await writeFile(join(source.storageRoot, key), 'Input data')
    await source.client.fileOriginSession.create({
      data: { projectId: 'source', sessionId: 'upstream' }
    })
    await source.client.uploadFile.create({
      data: {
        id: 'upload-1',
        projectId: 'source',
        sessionId: 'upstream',
        filename: 'input.txt',
        originalFilename: 'input.txt',
        versions: {
          create: {
            id: 'version-1',
            versionNumber: 1,
            state: 'ready',
            contentStorageKey: key,
            filename: 'input.txt',
            originalFilename: 'input.txt',
            sizeBytes: 10n,
            checksum: sha256('Input data')
          }
        }
      }
    })
    await source.client.uploadFile.update({
      where: { id: 'upload-1' },
      data: { currentVersionId: 'version-1' }
    })
  }
  await new SessionRepository(source.storageRoot).saveSession({
    id: 'original',
    projectId: 'source',
    title: 'Research',
    cwd: '',
    status: 'idle',
    messages: withUpload
      ? [
          {
            id: 'question',
            role: 'user',
            content: 'Use this input',
            status: 'complete',
            eventIds: [],
            createdAt: 1,
            updatedAt: 1,
            uploads: [
              {
                id: 'upload-1',
                versionId: 'version-1',
                versionNumber: 1,
                sessionId: 'upstream',
                name: 'input.txt',
                originalName: 'input.txt',
                size: 10,
                path: createUploadVersionReference('version-1', {
                  projectId: 'source',
                  sessionId: 'upstream',
                  fileId: 'upload-1'
                }),
                checksum: sha256('Input data')
              }
            ]
          }
        ]
      : [],
    createdAt: 1,
    updatedAt: 2
  })
  const notebook = join(source.storageRoot, 'notebooks', 'source', 'original', 'data')
  await mkdir(notebook, { recursive: true })
  await writeFile(join(notebook, 'result.txt'), 'Research result')
  if (withArtifact) {
    await source.compatibilityRepository.writePendingFile({
      projectId: 'source',
      sessionId: 'original',
      runId: 'artifact-run-1',
      filename: 'plot.png',
      mimeType: 'image/png',
      source: createPngInlineSource('Research plot')
    })
    const version = await source.repository.createVersion(
      createArtifactVersionRequest({
        projectId: 'source',
        appSessionId: 'original',
        artifactStorageSessionId: 'original'
      })
    )
    await new ReviewRepository(async () => source.client, {
      snapshotStorageRoot: source.storageRoot
    }).createReview({
      projectId: 'source',
      sessionId: 'original',
      turnMessageId: 'question',
      lifecycle: 'complete',
      outcome: 'flagged',
      scope: {
        turnMessageId: 'question',
        blocks: [],
        artifactVersionIds: [version.versionId],
        sourceDocumentVersionIds: []
      },
      scopeSnapshot: []
    })
  }
  const archive = join(source.storageRoot, 'research.science')
  const exporter = new SessionPackageService({
    storageRoot: source.storageRoot,
    getClient: async () => source.client
  })
  await exporter.exportTo({ projectId: 'source', sessionId: 'original' }, archive)
  await exporter.close()
  const service = new SessionPackageService({
    configRoot,
    storageRoot: target.storageRoot,
    getClient: async () => target.client
  })
  const identity = await service.importFrom(archive, undefined, undefined, undefined, {
    projectId: 'target'
  })
  const sessions = new SessionRepository(
    configRoot,
    {},
    new SessionProjectionRepository(async () => target.client)
  )
  const coordinator = new SessionPersistenceCoordinator(
    sessions,
    new ManagedFileIndexRepository(
      async () => target.client,
      target.storageRoot,
      new ManagedFileVersionService({
        storageRoot: target.storageRoot,
        getClient: async () => target.client
      }),
      new UploadRepository(target.storageRoot, { getClient: async () => target.client })
    ),
    undefined,
    new ProvenanceMessageSnapshotRepository({
      storageRoot: target.storageRoot,
      getClient: async () => target.client
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (session) => service.prepareSessionDeletion(session)
  )
  const content = join(
    target.storageRoot,
    'notebooks',
    identity.projectId,
    identity.sessionId,
    'data',
    'result.txt'
  )
  return { source, target, service, identity, sessions, coordinator, content, archive }
}

it.each(['receipt', 'manifest', 'missing-receipt'] as const)(
  'deletes the conversation but retains unverifiable package evidence (%s)',
  async (fault) => {
    const { service, identity, sessions, coordinator, content, target } =
      await importedFixture(true)
    const evidence = join(
      target.storageRoot,
      'artifacts',
      identity.projectId,
      identity.sessionId,
      '.session-package'
    )
    const damaged =
      fault === 'manifest'
        ? join(evidence, 'source', 'manifest.json')
        : join(evidence, 'receipt.json')
    if (fault === 'missing-receipt') await rm(damaged)
    else await writeFile(damaged, '{invalid')
    const session = await sessions.loadSession(identity.projectId, identity.sessionId)
    const versions = await target.client.uploadVersion.count()
    await expect(
      coordinator.deleteSession(identity.projectId, identity.sessionId)
    ).resolves.toBeUndefined()
    expect(await sessions.loadSession(identity.projectId, identity.sessionId)).toBeUndefined()
    await service.recover({ collectDeletedPackages: true })
    expect(await readFile(content, 'utf8')).toBe('Research result')
    expect(await target.client.uploadVersion.count()).toBe(versions)
    const journal = JSON.parse(
      await readFile(
        join(
          target.storageRoot,
          'session-package-cleanup',
          `${session!.packageOrigin!.importId}.json`
        ),
        'utf8'
      )
    )
    expect(journal).toMatchObject({ retainOnly: true, identities: [], directories: [] })
  }
)

it('collects a deleted imported package at startup without deleting its project or exported archive', async () => {
  const { service, identity, sessions, coordinator, content, archive, target } =
    await importedFixture()
  await sessions.saveManifest({ lastSessionId: identity.sessionId })
  await coordinator.deleteSession(identity.projectId, identity.sessionId)
  expect(await sessions.loadSession(identity.projectId, identity.sessionId)).toBeUndefined()
  expect(await readFile(content, 'utf8')).toBe('Research result')
  await service.close()
  const restarted = new SessionPackageService({
    storageRoot: target.storageRoot,
    getClient: async () => target.client
  })
  // Reconnection/import recovery after runtime hydration must never perform collection.
  await restarted.recover()
  expect(await readFile(content, 'utf8')).toBe('Research result')
  await restarted.recover({ collectDeletedPackages: true })
  await expect(stat(content)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(restarted.readOrigin(identity)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(
    await target.client.project.findUnique({ where: { id: identity.projectId } })
  ).not.toBeNull()
  expect(await target.client.fileOriginSession.count({ where: identity })).toBe(0)
  expect(
    await target.client.session.findUnique({ where: { id: identity.sessionId } })
  ).toMatchObject({ deletedAtMs: expect.any(BigInt) })
  expect((await stat(archive)).size).toBeGreaterThan(0)
  await restarted.recover({ collectDeletedPackages: true })
  await restarted.close()
})

it('removes native Version rows and retained upstream scopes as one import', async () => {
  const { service, identity, coordinator, target } = await importedFixture(true)
  const origin = await service.readOrigin(identity)
  expect(await target.client.uploadVersion.count()).toBe(1)
  await coordinator.deleteSession(identity.projectId, identity.sessionId)
  await service.recover({ collectDeletedPackages: true })
  expect(await target.client.uploadVersion.count()).toBe(0)
  expect(await target.client.uploadFile.count()).toBe(0)
  expect(await target.client.fileOriginSession.count()).toBe(0)
  await expect(
    stat(join(target.storageRoot, 'artifacts', 'target', origin.identities.upstream))
  ).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(
    stat(
      join(
        target.storageRoot,
        origin.files.find((file) => file.sourceStorageKey.startsWith('uploads/'))!.localStorageKey
      )
    )
  ).rejects.toMatchObject({ code: 'ENOENT' })
  await service.close()
})

it('keeps cleanup intent in the configuration root when research data uses another root', async () => {
  const { service, identity, coordinator, target, content } = await importedFixture(
    false,
    false,
    true
  )
  await coordinator.deleteSession(identity.projectId, identity.sessionId)
  await expect(stat(join(target.storageRoot, 'session-package-cleanup'))).rejects.toMatchObject({
    code: 'ENOENT'
  })
  const options = service.options
  expect(await readdir(join(options.configRoot!, 'session-package-cleanup'))).toHaveLength(1)
  await service.close()
  const restarted = new SessionPackageService(options)
  await restarted.recover({ collectDeletedPackages: true })
  await expect(stat(content)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(join(options.configRoot!, 'session-package-cleanup'))).toEqual([])
  await restarted.close()
})

it('collects Artifact and Review graphs transactionally with their source evidence', async () => {
  const { service, identity, coordinator, target } = await importedFixture(false, true)
  expect(await target.client.artifactVersion.count()).toBe(1)
  expect(await target.client.reviewScopeSnapshot.count()).toBe(1)
  await coordinator.deleteSession(identity.projectId, identity.sessionId)
  await service.recover({ collectDeletedPackages: true })
  expect(await target.client.artifactVersion.count()).toBe(0)
  expect(await target.client.artifactLineage.count()).toBe(0)
  expect(await target.client.reviewScopeSnapshot.count()).toBe(0)
  expect(await target.client.review.count()).toBe(0)
  expect(await target.client.fileOriginSession.count()).toBe(0)
  await service.close()
})

it.each([
  'branch',
  'database',
  'notebook',
  'unreadable',
  'quarantine',
  'ownership',
  'task'
] as const)(
  'retains the whole package when an external %s reference or uncertainty exists',
  async (kind) => {
    const { service, identity, coordinator, target, sessions, content } =
      await importedFixture(true)
    const origin = await service.readOrigin(identity)
    const versionId = origin.identities['version-1']
    // References can be added after deletion and before the next launch.
    await coordinator.deleteSession(identity.projectId, identity.sessionId)
    if (kind === 'branch') {
      const graph = forkEditedConversationMessage(
        createLinearConversationGraph({
          sessionId: 'other',
          createdAt: 1,
          updatedAt: 2,
          messages: [
            {
              id: 'question',
              role: 'user',
              content: `Use ${versionId}`,
              status: 'complete',
              createdAt: 1,
              updatedAt: 1,
              eventIds: []
            }
          ]
        }),
        'question',
        'No reference in this branch',
        3
      )
      await sessions.saveSession({
        id: 'other',
        projectId: 'target',
        title: 'Other research',
        cwd: '',
        status: 'idle',
        messages: [],
        conversationGraph: graph,
        createdAt: 1,
        updatedAt: 3
      })
    } else if (kind === 'database') {
      await target.client.project.update({
        where: { id: 'target' },
        data: { agentContext: `Use ${versionId}` }
      })
    } else if (kind === 'notebook') {
      await mkdir(join(target.storageRoot, 'notebooks', 'target', 'other'), { recursive: true })
    } else if (kind === 'task') {
      await writeFile(
        join(target.storageRoot, 'task-runs.json'),
        JSON.stringify({ version: 1, runs: [{ output: versionId }] })
      )
    } else if (kind === 'unreadable' || kind === 'quarantine') {
      await mkdir(join(target.storageRoot, 'sessions', 'target'), { recursive: true })
      await writeFile(
        join(
          target.storageRoot,
          'sessions',
          'target',
          kind === 'unreadable' ? 'other.json' : 'other.json.invalid'
        ),
        'Unverifiable history'
      )
    }
    if (kind === 'ownership')
      await writeFile(
        join(
          target.storageRoot,
          'notebooks',
          'target',
          identity.sessionId,
          '.session-package-owner'
        ),
        'another owner'
      )
    await service.recover({ collectDeletedPackages: true })
    expect(await readFile(content, 'utf8')).toBe('Research result')
    expect(await target.client.uploadVersion.count()).toBe(1)
    expect((await service.readOrigin(identity)).sourceManifest.source.projectId).toBe('source')
    expect(await readdir(join(target.storageRoot, 'session-package-cleanup'))).toHaveLength(1)
    await service.close()
  }
)

it.each(['transaction', 'partial-files', 'final-directory'] as const)(
  'retries cleanup after a %s failure',
  async (boundary) => {
    const { service, identity, coordinator, target, content } = await importedFixture()
    await coordinator.deleteSession(identity.projectId, identity.sessionId)
    const realRm = fs.rm
    if (boundary === 'transaction')
      vi.spyOn(target.client, '$transaction').mockRejectedValueOnce(
        new Error('Database unavailable')
      )
    else
      vi.spyOn(fs, 'rm').mockImplementation(async (path, options) => {
        const value = String(path)
        const isFinalDirectory = dirname(value).endsWith('session-package-trash')
        if (
          value.includes('session-package-trash') &&
          (boundary === 'final-directory'
            ? isFinalDirectory
            : value.includes(`notebooks-${identity.sessionId}`))
        ) {
          if (boundary === 'partial-files')
            await realRm(join(value, '.session-package-owner'), { force: true })
          throw new Error('Injected filesystem failure')
        }
        return realRm(path, options)
      })
    await service.recover({ collectDeletedPackages: true })
    expect(await readdir(join(target.storageRoot, 'session-package-cleanup'))).toHaveLength(1)
    if (boundary === 'transaction') expect(await readFile(content, 'utf8')).toBe('Research result')
    vi.restoreAllMocks()
    await service.close()
    const restarted = new SessionPackageService({
      storageRoot: target.storageRoot,
      getClient: async () => target.client
    })
    await restarted.recover({ collectDeletedPackages: true })
    expect(await readdir(join(target.storageRoot, 'session-package-cleanup'))).toEqual([])
    await expect(stat(content)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(target.storageRoot, 'session-package-trash'))).toEqual([])
    await restarted.close()
  }
)

it('keeps live authority after a failed deletion and refuses a replaced directory link', async () => {
  const { service, identity, coordinator, target, content, sessions } = await importedFixture()
  const saved = await sessions.loadSession(identity.projectId, identity.sessionId)
  vi.spyOn(sessions, 'deleteSession').mockRejectedValueOnce(new Error('Deletion failed'))
  await expect(coordinator.deleteSession(identity.projectId, identity.sessionId)).rejects.toThrow(
    'Deletion failed'
  )
  await service.recover({ collectDeletedPackages: true })
  expect((await sessions.loadSession(identity.projectId, identity.sessionId))?.id).toBe(saved?.id)
  expect(await readFile(content, 'utf8')).toBe('Research result')
  vi.restoreAllMocks()
  await coordinator.deleteSession(identity.projectId, identity.sessionId)
  const owned = dirname(dirname(content))
  const outside = join(target.storageRoot, 'unowned')
  await mkdir(outside)
  await writeFile(join(outside, '.session-package-owner'), saved!.packageOrigin!.importId)
  await writeFile(join(outside, 'keep.txt'), 'Do not remove')
  await rm(owned, { recursive: true })
  await symlink(outside, owned, process.platform === 'win32' ? 'junction' : 'dir')
  await service.recover({ collectDeletedPackages: true })
  expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('Do not remove')
  expect(await target.client.fileOriginSession.count({ where: identity })).toBe(1)
  await service.close()
})

it('does not let an empty Task journal or a Project ownership receipt prevent collection', async () => {
  const { service, identity, coordinator, target, content } = await importedFixture()
  await writeFile(
    join(target.storageRoot, 'task-runs.json'),
    JSON.stringify({ version: 1, runs: [] })
  )
  const evidence = join(target.storageRoot, 'execution-file-evidence')
  await mkdir(evidence)
  await writeFile(join(evidence, '.project-ownership-target.json'), '{}')
  await coordinator.deleteSession(identity.projectId, identity.sessionId)
  await service.recover({ collectDeletedPackages: true })
  await expect(stat(content)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(evidence, '.project-ownership-target.json'), 'utf8')).toBe('{}')
  await service.close()
})

it.each([false, true])(
  'keeps the Session when its cleanup intent cannot be recorded durably (damaged receipt: %s)',
  async (damaged) => {
    const { service, identity, coordinator, target, sessions, content } = await importedFixture()
    if (damaged)
      await writeFile(
        join(
          target.storageRoot,
          'artifacts',
          identity.projectId,
          identity.sessionId,
          '.session-package',
          'receipt.json'
        ),
        '{invalid'
      )
    await writeFile(join(target.storageRoot, 'session-package-cleanup'), 'Occupied path')
    await expect(
      coordinator.deleteSession(identity.projectId, identity.sessionId)
    ).rejects.toThrow()
    await expect(service.recover({ collectDeletedPackages: true })).resolves.toBeUndefined()
    expect((await sessions.loadSession(identity.projectId, identity.sessionId))?.id).toBe(
      identity.sessionId
    )
    expect(await readFile(content, 'utf8')).toBe('Research result')
    await service.close()
  }
)

it('recognizes the navigation manifest while retaining a live external reference', async () => {
  // Exercise the persisted recovery boundary without a database migration: the live Session
  // reference must stop recovery before any native mutation is considered.
  const root = await mkdtemp(join(tmpdir(), 'open-science-package-navigation-'))
  const client = createProjectDbClient(root)
  const importId = randomUUID()
  const sessionId = `import-${randomUUID()}`
  const service = new SessionPackageService({ storageRoot: root, getClient: async () => client })
  try {
    vi.spyOn(client.fileOriginSession, 'findUnique').mockResolvedValue({
      projectId: 'target',
      sessionId,
      state: 'retained',
      titleSnapshot: null,
      deletedAt: new Date(),
      deletionOperationId: null,
      retainedReviewIdsJson: null,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    const sessions = new SessionRepository(root)
    await sessions.saveSession({
      id: 'other',
      projectId: 'target',
      title: sessionId,
      cwd: '',
      status: 'idle',
      messages: [],
      createdAt: 1,
      updatedAt: 1
    })
    await sessions.saveManifest({ lastSessionId: 'other' })
    await mkdir(join(root, 'artifacts', 'target', sessionId), { recursive: true })
    await writeFile(
      join(root, 'artifacts', 'target', sessionId, '.session-package-owner'),
      importId
    )
    await mkdir(join(root, 'session-package-cleanup'))
    const path = join(root, 'session-package-cleanup', `${importId}.json`)
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        importId,
        projectId: 'target',
        sessionId,
        identities: [sessionId],
        directories: [{ scope: 'artifacts', sessionId }]
      })
    )
    await service.recover({ collectDeletedPackages: true })
    expect(JSON.parse(await readFile(path, 'utf8')).retentionReason).toContain(
      'External references'
    )
    expect((await sessions.loadSession('target', 'other'))?.title).toBe(sessionId)
  } finally {
    await service.close()
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
  }
})
