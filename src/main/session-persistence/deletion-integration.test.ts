import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true }
}))

import type { PersistedChatSession } from '../../shared/session-persistence'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { ManagedFileIndexRepository } from '../project-files/repository'
import { ProjectDeletionCoordinator } from '../projects/deletion-coordinator'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ProjectRepository } from '../projects/repository'
import { UploadRepository } from '../uploads/repository'
import { SessionPersistenceCoordinator } from './coordinator'
import { SessionRepository } from './repository'

const PROJECT_ID = 'project-a'
const SESSION_ID = 'session-a'

describe('managed-file deletion integration', () => {
  let storageRoot: string
  let client: PrismaClient
  let sessions: SessionRepository
  let files: ManagedFileIndexRepository
  let coordinator: SessionPersistenceCoordinator
  let uploads: UploadRepository
  let uploadPath: string
  let artifactPath: string

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-file-deletion-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    sessions = new SessionRepository(storageRoot)
    uploads = new UploadRepository(storageRoot, { getClient: () => Promise.resolve(client) })
    files = new ManagedFileIndexRepository(
      () => Promise.resolve(client),
      storageRoot,
      new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client)
      }),
      uploads
    )
    coordinator = new SessionPersistenceCoordinator(sessions, files, undefined, undefined, uploads)
    uploadPath = join(
      storageRoot,
      'uploads',
      PROJECT_ID,
      SESSION_ID,
      'upload-1',
      'versions',
      'upload-version-1',
      'content'
    )
    artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-agent',
      'result.txt'
    )

    await Promise.all([
      writeManagedFile(uploadPath, 'upload bytes'),
      writeManagedFile(artifactPath, 'artifact bytes')
    ])
    await client.project.create({ data: { id: PROJECT_ID, name: 'Project A' } })
    await client.fileOriginSession.create({
      data: { projectId: PROJECT_ID, sessionId: SESSION_ID }
    })
    await client.uploadFile.create({
      data: {
        id: 'upload-1',
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        filename: 'input.csv',
        originalFilename: 'input.csv',
        versions: {
          create: {
            id: 'upload-version-1',
            versionNumber: 1,
            state: 'ready',
            contentStorageKey: relativeStorageKey(storageRoot, uploadPath),
            filename: 'input.csv',
            originalFilename: 'input.csv',
            sizeBytes: BigInt('upload bytes'.length),
            checksum: createHash('sha256').update('upload bytes').digest('hex'),
            createdAt: new Date(100)
          }
        }
      }
    })
    await client.uploadFile.update({
      where: { id: 'upload-1' },
      data: { currentVersionId: 'upload-version-1' }
    })
    await sessions.saveSession(createSession(uploadPath, artifactPath))
    await coordinator.loadAll()
    await expect(files.getOverview(PROJECT_ID)).resolves.toMatchObject({ totalCount: 2 })
  })

  afterEach(async () => {
    await client.$disconnect()
    await rm(storageRoot, { recursive: true, force: true })
  })

  it('soft-deletes indexed rows but retains upload and artifact bytes after session deletion', async () => {
    const legacyPath = join(storageRoot, 'uploads', 'default-project', SESSION_ID, 'input.csv')
    await writeManagedFile(legacyPath, 'upload bytes')

    await coordinator.deleteSession(PROJECT_ID, SESSION_ID)

    await expect(sessions.loadAll()).resolves.toMatchObject({ sessions: [] })
    await expect(files.getOverview(PROJECT_ID)).resolves.toMatchObject({ totalCount: 0 })
    await expect(readFile(uploadPath, 'utf8')).resolves.toBe('upload bytes')
    await expect(readFile(artifactPath, 'utf8')).resolves.toBe('artifact bytes')
    await expect(readFile(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('hides Version history during Session deletion and restores the unchanged head on compensation', async () => {
    const secondStorageRef =
      'uploads/project-a/session-a/upload-1/managed-versions/vabc12345_input.csv'
    const secondPath = join(storageRoot, ...secondStorageRef.split('/'))
    const secondBytes = Buffer.from('edited upload bytes')
    await writeManagedFile(secondPath, secondBytes.toString('utf8'))
    await client.uploadVersion.create({
      data: {
        id: 'upload-version-2',
        uploadFileId: 'upload-1',
        versionNumber: 2,
        state: 'ready',
        originKind: 'user_edit',
        basedOnVersionId: 'upload-version-1',
        storageTag: 'vabc12345',
        storedFilename: 'vabc12345_input.csv',
        contentStorageKey: secondStorageRef,
        filename: 'input.csv',
        originalFilename: 'input.csv',
        sizeBytes: secondBytes.byteLength,
        checksum: createHash('sha256').update(secondBytes).digest('hex'),
        createdAt: new Date(200)
      }
    })
    await client.uploadFile.update({
      where: { id: 'upload-1' },
      data: { currentVersionId: 'upload-version-2' }
    })
    const versionService = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })
    const sessionPath = join(storageRoot, 'sessions', PROJECT_ID, `${SESSION_ID}.json`)
    let signalPrimaryRemoval!: () => void
    let releasePrimaryRemoval!: () => void
    const primaryRemovalStarted = new Promise<void>((resolve) => {
      signalPrimaryRemoval = resolve
    })
    const primaryRemovalMayFail = new Promise<void>((resolve) => {
      releasePrimaryRemoval = resolve
    })
    const failingSessions = new SessionRepository(storageRoot, {
      remove: async (path, options) => {
        if (path === sessionPath) {
          signalPrimaryRemoval()
          await primaryRemovalMayFail
          throw new Error('simulated Session authority delete failure')
        }
        await rm(path, options)
      }
    })
    const compensatingCoordinator = new SessionPersistenceCoordinator(
      failingSessions,
      files,
      undefined,
      undefined,
      new UploadRepository(storageRoot, { getClient: () => Promise.resolve(client) })
    )
    await compensatingCoordinator.loadAll()

    const deletion = compensatingCoordinator.deleteSession(PROJECT_ID, SESSION_ID)
    await primaryRemovalStarted
    await expect(
      versionService.openLatest({ source: 'upload', projectId: PROJECT_ID, fileId: 'upload-1' })
    ).rejects.toMatchObject({ code: 'FILE_DELETED' })
    await expect(
      versionService.openVersion(
        { source: 'upload', projectId: PROJECT_ID, fileId: 'upload-1' },
        'upload-version-1'
      )
    ).rejects.toMatchObject({ code: 'FILE_DELETED' })

    releasePrimaryRemoval()
    await expect(deletion).rejects.toThrow('simulated Session authority delete failure')

    const latest = await versionService.openLatest({
      source: 'upload',
      projectId: PROJECT_ID,
      fileId: 'upload-1'
    })
    const historical = await versionService.openVersion(
      { source: 'upload', projectId: PROJECT_ID, fileId: 'upload-1' },
      'upload-version-1'
    )
    try {
      expect(latest.version.id).toBe('upload-version-2')
      expect(historical.version.id).toBe('upload-version-1')
    } finally {
      await Promise.all([latest.close(), historical.close()])
    }
    await expect(
      client.uploadFile.findUniqueOrThrow({ where: { id: 'upload-1' } })
    ).resolves.toMatchObject({ currentVersionId: 'upload-version-2' })
  })

  it('deletes a recovered Session and its superseded quarantine without blocking Project deletion', async () => {
    const projectDir = join(storageRoot, 'sessions', PROJECT_ID)
    const quarantineName = `${SESSION_ID}.json.invalid-1710000000000-1`
    await writeFile(join(projectDir, quarantineName), '{older malformed authority', 'utf8')

    await expect(coordinator.deleteSession(PROJECT_ID, SESSION_ID)).resolves.toBeUndefined()

    await expect(readFile(join(projectDir, `${SESSION_ID}.json`))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(readFile(join(projectDir, quarantineName))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(files.getOverview(PROJECT_ID)).resolves.toMatchObject({ totalCount: 0 })
    await expect(coordinator.deleteProjectSessions(PROJECT_ID)).resolves.toEqual({
      status: 'completed'
    })
    await expect(readdir(projectDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('soft-deletes project rows but retains upload and artifact bytes after project deletion', async () => {
    const legacyPath = join(storageRoot, 'uploads', 'default-project', SESSION_ID, 'input.csv')
    await writeManagedFile(legacyPath, 'upload bytes')

    await coordinator.deleteProjectSessions(PROJECT_ID)

    await expect(sessions.loadAll()).resolves.toMatchObject({ sessions: [] })
    await expect(files.getOverview(PROJECT_ID)).resolves.toMatchObject({ totalCount: 0 })
    await expect(readFile(uploadPath, 'utf8')).resolves.toBe('upload bytes')
    await expect(readFile(artifactPath, 'utf8')).resolves.toBe('artifact bytes')
    await expect(readFile(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('terminal-cleans a path-only Upload from an unmarked legacy Project tombstone', async () => {
    const legacyPath = join(storageRoot, 'uploads', 'default-project', SESSION_ID, 'input.csv')
    const legacySession = createSession(uploadPath, artifactPath)
    legacySession.messages[0].uploads = [
      {
        id: 'upload-1',
        sessionId: SESSION_ID,
        name: 'input.csv',
        originalName: 'input.csv',
        path: legacyPath,
        size: 'upload bytes'.length
      }
    ]
    await writeManagedFile(legacyPath, 'upload bytes')
    const liveProjectDir = join(storageRoot, 'sessions', PROJECT_ID)
    const tombstoneDir = join(storageRoot, 'deleted-sessions', PROJECT_ID)
    await writeFile(
      join(liveProjectDir, `${SESSION_ID}.json`),
      JSON.stringify({ version: 2, session: legacySession }),
      'utf8'
    )
    await mkdir(join(storageRoot, 'deleted-sessions'), { recursive: true })
    await rename(liveProjectDir, tombstoneDir)

    await coordinator.deleteProjectSessions(PROJECT_ID)

    const durableTombstone = JSON.parse(
      await readFile(join(tombstoneDir, `${SESSION_ID}.json`), 'utf8')
    ) as { session: PersistedChatSession }
    expect(JSON.stringify(durableTombstone)).toContain('upload-version-1')
    expect(durableTombstone.session.messages[0].uploads?.[0]).not.toHaveProperty('path')
    await expect(sessions.getProjectSessionDeletionState(PROJECT_ID)).resolves.toBe('prepared')
    await expect(readFile(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(files.getOverview(PROJECT_ID)).resolves.toMatchObject({ totalCount: 0 })
  })

  it('adopts and safely completes an orphaned legacy tombstone with surviving Upload authority', async () => {
    const legacyPath = join(storageRoot, 'uploads', 'default-project', SESSION_ID, 'input.csv')
    const legacySession = createPathOnlySession(legacyPath)
    const tombstoneDir = await replaceLiveSessionWithLegacyTombstone(storageRoot, legacySession)
    await writeManagedFile(legacyPath, 'upload bytes')
    await client.uploadVersion.update({
      where: { id: 'upload-version-1' },
      data: { state: 'staging' }
    })
    await rm(uploadPath, { force: true })
    await client.session.deleteMany({ where: { projectId: PROJECT_ID } })
    await client.project.delete({ where: { id: PROJECT_ID } })
    const projects = new ProjectRepository(() => Promise.resolve(client))
    const provenanceRepository = new ArtifactProvenanceRepository({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })
    let recoveredImmutableAuthority = false
    const provenance = {
      deleteProjectProvenance: vi.fn(async (projectId: string) => {
        const version = await client.uploadVersion.findUnique({
          where: { id: 'upload-version-1' }
        })
        recoveredImmutableAuthority =
          version?.state === 'ready' && (await readFile(uploadPath, 'utf8')) === 'upload bytes'
        await provenanceRepository.deleteProjectProvenance(projectId)
      })
    }
    const projectDeletion = new ProjectDeletionCoordinator(
      projects,
      coordinator,
      undefined,
      provenance
    )

    await expect(client.project.findUnique({ where: { id: PROJECT_ID } })).resolves.toBeNull()
    await expect(
      client.projectDeletionIntent.findUnique({ where: { projectId: PROJECT_ID } })
    ).resolves.toBeNull()

    await projectDeletion.recoverPendingDeletions()

    expect(recoveredImmutableAuthority).toBe(true)
    expect(provenance.deleteProjectProvenance).toHaveBeenCalledWith(PROJECT_ID)
    await expect(readdir(tombstoneDir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(uploadPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(client.uploadFile.findUnique({ where: { id: 'upload-1' } })).resolves.toBeNull()
    await expect(
      client.uploadVersion.findUnique({ where: { id: 'upload-version-1' } })
    ).resolves.toBeNull()
    await expect(
      client.projectDeletionIntent.findUnique({ where: { projectId: PROJECT_ID } })
    ).resolves.toBeNull()
  })

  it('retains an orphan tombstone and bytes without blocking recovery when Upload authority is gone', async () => {
    const legacyPath = join(storageRoot, 'uploads', 'default-project', SESSION_ID, 'input.csv')
    const legacySession = createPathOnlySession(legacyPath)
    const tombstoneDir = await replaceLiveSessionWithLegacyTombstone(storageRoot, legacySession)
    await writeManagedFile(legacyPath, 'upload bytes')
    await client.managedFile.deleteMany({ where: { projectId: PROJECT_ID } })
    await client.uploadFile.update({
      where: { id: 'upload-1' },
      data: { currentVersionId: null }
    })
    await client.uploadVersion.deleteMany({ where: { uploadFileId: 'upload-1' } })
    await client.uploadFile.deleteMany({ where: { id: 'upload-1' } })
    await rm(uploadPath, { force: true })
    await client.session.deleteMany({ where: { projectId: PROJECT_ID } })
    await client.project.delete({ where: { id: PROJECT_ID } })
    const projects = new ProjectRepository(() => Promise.resolve(client))
    const unrelatedProject = await projects.create({ name: 'Unrelated project' })
    const unrelatedSession = createSession('', '')
    unrelatedSession.id = 'session-unrelated'
    unrelatedSession.projectId = unrelatedProject.id
    unrelatedSession.messages = []
    unrelatedSession.artifacts = []
    unrelatedSession.filesRevision = 0
    await sessions.saveSession(unrelatedSession)
    const projectDeletion = new ProjectDeletionCoordinator(
      projects,
      coordinator,
      undefined,
      new ArtifactProvenanceRepository({
        storageRoot,
        getClient: () => Promise.resolve(client)
      })
    )

    await expect(client.project.findUnique({ where: { id: PROJECT_ID } })).resolves.toBeNull()
    await expect(
      client.projectDeletionIntent.findUnique({ where: { projectId: PROJECT_ID } })
    ).resolves.toBeNull()

    await expect(projectDeletion.recoverPendingDeletions()).resolves.toBeUndefined()
    await expect(projectDeletion.recoverPendingDeletions()).resolves.toBeUndefined()
    await expect(projects.list()).resolves.toContainEqual(unrelatedProject)
    const readableSessions = await coordinator.loadAll()
    expect(
      readableSessions.sessions.find((session) => session.id === unrelatedSession.id)
    ).toBeDefined()

    await expect(sessions.getProjectSessionDeletionState(PROJECT_ID)).resolves.toBe(
      'legacy-committed'
    )
    await expect(readFile(legacyPath, 'utf8')).resolves.toBe('upload bytes')
    const retainedTombstone = JSON.parse(
      await readFile(join(tombstoneDir, `${SESSION_ID}.json`), 'utf8')
    ) as { session: PersistedChatSession }
    expect(retainedTombstone.session.messages[0].uploads?.[0]?.path).toBe(legacyPath)
    await expect(
      client.projectDeletionIntent.findUnique({ where: { projectId: PROJECT_ID } })
    ).resolves.toBeNull()
    await expect(client.uploadFile.findUnique({ where: { id: 'upload-1' } })).resolves.toBeNull()
    await expect(
      client.uploadVersion.findUnique({ where: { id: 'upload-version-1' } })
    ).resolves.toBeNull()
  })

  it('settles mixed orphan publication before retaining the tombstone and soft-deleting its index', async () => {
    const recoverableLegacyPath = join(
      storageRoot,
      'uploads',
      'default-project',
      SESSION_ID,
      'input.csv'
    )
    const missingLegacyPath = join(
      storageRoot,
      'uploads',
      'default-project',
      SESSION_ID,
      'missing.csv'
    )
    const mixedSession = createPathOnlySession(recoverableLegacyPath)
    mixedSession.messages[0].uploads!.push({
      id: 'upload-missing',
      sessionId: SESSION_ID,
      name: 'missing.csv',
      originalName: 'missing.csv',
      path: missingLegacyPath,
      size: 'missing bytes'.length
    })
    const tombstoneDir = await replaceLiveSessionWithLegacyTombstone(storageRoot, mixedSession)
    await writeManagedFile(recoverableLegacyPath, 'upload bytes')
    await writeManagedFile(missingLegacyPath, 'missing bytes')
    await client.uploadVersion.update({
      where: { id: 'upload-version-1' },
      data: { state: 'staging' }
    })
    await rm(uploadPath, { force: true })
    const projects = new ProjectRepository(() => Promise.resolve(client))
    const unrelatedProject = await projects.create({ name: 'Mixed recovery observer' })
    const unrelatedSession = createSession('', '')
    unrelatedSession.id = 'session-mixed-observer'
    unrelatedSession.projectId = unrelatedProject.id
    unrelatedSession.messages = []
    unrelatedSession.artifacts = []
    unrelatedSession.filesRevision = 0
    await sessions.saveSession(unrelatedSession)
    const projectDeletion = new ProjectDeletionCoordinator(
      projects,
      coordinator,
      undefined,
      new ArtifactProvenanceRepository({
        storageRoot,
        getClient: () => Promise.resolve(client)
      })
    )

    await expect(projectDeletion.recoverPendingDeletions()).resolves.toBeUndefined()

    await expect(sessions.getProjectSessionDeletionState(PROJECT_ID)).resolves.toBe(
      'legacy-committed'
    )
    await expect(readFile(recoverableLegacyPath, 'utf8')).resolves.toBe('upload bytes')
    await expect(readFile(missingLegacyPath, 'utf8')).resolves.toBe('missing bytes')
    await expect(readFile(join(tombstoneDir, `${SESSION_ID}.json`), 'utf8')).resolves.toContain(
      'upload-missing'
    )
    await expect(readFile(uploadPath, 'utf8')).resolves.toBe('upload bytes')
    await expect(
      client.uploadVersion.findUnique({ where: { id: 'upload-version-1' } })
    ).resolves.toMatchObject({ state: 'ready' })
    await expect(
      client.managedFile.findFirst({ where: { projectId: PROJECT_ID, deletedAt: null } })
    ).resolves.toBeNull()
    await expect(files.getOverview(PROJECT_ID)).resolves.toMatchObject({ totalCount: 0 })

    // The recovery result is not observable until every sibling publication has settled. Yield once
    // more to catch a dangling Promise that could otherwise reactivate ManagedFile after return.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(
      client.managedFile.findFirst({ where: { projectId: PROJECT_ID, deletedAt: null } })
    ).resolves.toBeNull()
    await expect(
      client.projectDeletionIntent.findUnique({ where: { projectId: PROJECT_ID } })
    ).resolves.toBeNull()

    await expect(projectDeletion.recoverPendingDeletions()).resolves.toBeUndefined()
    await expect(projects.list()).resolves.toContainEqual(unrelatedProject)
    const readableSessions = await coordinator.loadAll()
    expect(
      readableSessions.sessions.find((session) => session.id === unrelatedSession.id)
    ).toBeDefined()
  })

  it('completes an orphan tombstone when Upload authority and every byte candidate are absent', async () => {
    const legacyPath = join(storageRoot, 'uploads', 'default-project', SESSION_ID, 'input.csv')
    const tombstoneDir = await replaceLiveSessionWithLegacyTombstone(
      storageRoot,
      createPathOnlySession(legacyPath)
    )
    await client.managedFile.deleteMany({ where: { projectId: PROJECT_ID } })
    await client.uploadFile.update({
      where: { id: 'upload-1' },
      data: { currentVersionId: null }
    })
    await client.uploadVersion.deleteMany({ where: { uploadFileId: 'upload-1' } })
    await client.uploadFile.deleteMany({ where: { id: 'upload-1' } })
    await rm(uploadPath, { force: true })
    const projects = new ProjectRepository(() => Promise.resolve(client))
    const projectDeletion = new ProjectDeletionCoordinator(
      projects,
      coordinator,
      undefined,
      new ArtifactProvenanceRepository({
        storageRoot,
        getClient: () => Promise.resolve(client)
      })
    )

    await expect(projectDeletion.recoverPendingDeletions()).resolves.toBeUndefined()

    await expect(sessions.getProjectSessionDeletionState(PROJECT_ID)).resolves.toBe('absent')
    await expect(readdir(tombstoneDir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      client.projectDeletionIntent.findUnique({ where: { projectId: PROJECT_ID } })
    ).resolves.toBeNull()
  })

  it('retains an adopted intent when Upload authority lookup fails transiently', async () => {
    const legacyPath = join(storageRoot, 'uploads', 'default-project', SESSION_ID, 'input.csv')
    const tombstoneDir = await replaceLiveSessionWithLegacyTombstone(
      storageRoot,
      createPathOnlySession(legacyPath)
    )
    await writeManagedFile(legacyPath, 'upload bytes')
    const projects = new ProjectRepository(() => Promise.resolve(client))
    const failingSessions = new SessionPersistenceCoordinator(
      sessions,
      files,
      undefined,
      undefined,
      new UploadRepository(storageRoot, {
        getClient: () => Promise.reject(new Error('Upload database temporarily unavailable'))
      })
    )
    const projectDeletion = new ProjectDeletionCoordinator(
      projects,
      failingSessions,
      undefined,
      new ArtifactProvenanceRepository({
        storageRoot,
        getClient: () => Promise.resolve(client)
      })
    )

    await expect(projectDeletion.recoverPendingDeletions()).rejects.toThrow(
      'Upload database temporarily unavailable'
    )

    await expect(sessions.getProjectSessionDeletionState(PROJECT_ID)).resolves.toBe(
      'legacy-committed'
    )
    await expect(readFile(legacyPath, 'utf8')).resolves.toBe('upload bytes')
    const retainedTombstone = JSON.parse(
      await readFile(join(tombstoneDir, `${SESSION_ID}.json`), 'utf8')
    ) as { session: PersistedChatSession }
    expect(retainedTombstone.session.messages[0].uploads?.[0]?.path).toBe(legacyPath)
    await expect(
      client.projectDeletionIntent.findUnique({ where: { projectId: PROJECT_ID } })
    ).resolves.toBeTruthy()
  })

  it('retains a legacy source and aborts Project deletion when the path-free JSON save fails', async () => {
    const legacyPath = join(storageRoot, 'uploads', 'default-project', SESSION_ID, 'input.csv')
    const legacySession = createSession(uploadPath, artifactPath)
    legacySession.messages[0].uploads = [
      {
        id: 'upload-1',
        sessionId: SESSION_ID,
        name: 'input.csv',
        originalName: 'input.csv',
        path: legacyPath,
        size: 'upload bytes'.length
      }
    ]
    await writeManagedFile(legacyPath, 'upload bytes')
    await writeFile(
      join(storageRoot, 'sessions', PROJECT_ID, `${SESSION_ID}.json`),
      JSON.stringify({ version: 2, session: legacySession }),
      'utf8'
    )
    const failingSessions = new SessionRepository(storageRoot)
    vi.spyOn(failingSessions, 'saveSession').mockRejectedValue(
      new Error('session file unavailable')
    )
    const projectCoordinator = new SessionPersistenceCoordinator(
      failingSessions,
      files,
      undefined,
      undefined,
      new UploadRepository(storageRoot, { getClient: () => Promise.resolve(client) })
    )

    await expect(projectCoordinator.deleteProjectSessions(PROJECT_ID)).rejects.toThrow(
      'session file unavailable'
    )

    expect(failingSessions.saveSession).toHaveBeenCalledOnce()
    await expect(failingSessions.loadSession(PROJECT_ID, SESSION_ID)).resolves.toBeDefined()
    await expect(readFile(legacyPath, 'utf8')).resolves.toBe('upload bytes')
    await expect(files.getOverview(PROJECT_ID)).resolves.toMatchObject({ totalCount: 2 })
  })

  it('aborts Project deletion on transient Upload authority failure and succeeds on retry', async () => {
    const legacyPath = join(storageRoot, 'uploads', 'default-project', SESSION_ID, 'input.csv')
    await writeManagedFile(legacyPath, 'upload bytes')
    const getClient = vi
      .fn()
      .mockRejectedValueOnce(new Error('Upload authority unavailable.'))
      .mockResolvedValue(client)
    const retryingCoordinator = new SessionPersistenceCoordinator(
      sessions,
      files,
      undefined,
      undefined,
      new UploadRepository(storageRoot, { getClient })
    )

    await expect(retryingCoordinator.deleteProjectSessions(PROJECT_ID)).rejects.toThrow(
      'Upload authority unavailable.'
    )
    await expect(sessions.loadSession(PROJECT_ID, SESSION_ID)).resolves.toBeDefined()
    await expect(readFile(legacyPath, 'utf8')).resolves.toBe('upload bytes')
    await expect(files.getOverview(PROJECT_ID)).resolves.toMatchObject({ totalCount: 2 })

    await expect(retryingCoordinator.deleteProjectSessions(PROJECT_ID)).resolves.toEqual({
      status: 'completed'
    })
    await expect(sessions.loadSession(PROJECT_ID, SESSION_ID)).resolves.toBeUndefined()
    await expect(readFile(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(files.getOverview(PROJECT_ID)).resolves.toMatchObject({ totalCount: 0 })
  })

  it('deletes a recovered Project when valid Session JSON supersedes an older quarantine', async () => {
    const projectDir = join(storageRoot, 'sessions', PROJECT_ID)
    await writeFile(
      join(projectDir, `${SESSION_ID}.json.invalid-1710000000000-1`),
      '{older malformed authority',
      'utf8'
    )

    await expect(coordinator.deleteProjectSessions(PROJECT_ID)).resolves.toEqual({
      status: 'completed'
    })

    await expect(readdir(projectDir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(files.getOverview(PROJECT_ID)).resolves.toMatchObject({ totalCount: 0 })
  })

  it('commits Project deletion without guessing away an unsafe legacy replacement', async () => {
    const legacyPath = join(storageRoot, 'uploads', 'default-project', SESSION_ID, 'input.csv')
    await writeManagedFile(legacyPath, 'unrelated replacement bytes')

    await expect(coordinator.deleteProjectSessions(PROJECT_ID)).resolves.toEqual({
      status: 'completed'
    })

    await expect(sessions.loadSession(PROJECT_ID, SESSION_ID)).resolves.toBeUndefined()
    await expect(sessions.getProjectSessionDeletionState(PROJECT_ID)).resolves.toBe('prepared')
    await expect(readFile(legacyPath, 'utf8')).resolves.toBe('unrelated replacement bytes')
    await expect(
      client.uploadVersion.findUnique({ where: { id: 'upload-version-1' } })
    ).resolves.toBeDefined()
    await expect(files.getOverview(PROJECT_ID)).resolves.toMatchObject({ totalCount: 0 })

    // Simulate a completed provenance tail followed by tombstone-removal failure and restart. The
    // prepared marker must prevent recovery from consulting authority that the tail already removed.
    await client.managedFile.deleteMany({ where: { projectId: PROJECT_ID } })
    await client.uploadFile.update({
      where: { id: 'upload-1' },
      data: { currentVersionId: null }
    })
    await client.uploadVersion.deleteMany({ where: { uploadFileId: 'upload-1' } })
    await client.uploadFile.deleteMany({ where: { id: 'upload-1' } })
    await rm(uploadPath, { force: true })
    const recoveryCoordinator = new SessionPersistenceCoordinator(
      sessions,
      files,
      undefined,
      undefined,
      new UploadRepository(storageRoot, { getClient: () => Promise.resolve(client) })
    )

    await expect(recoveryCoordinator.deleteProjectSessions(PROJECT_ID)).resolves.toEqual({
      status: 'completed'
    })
    await expect(readFile(legacyPath, 'utf8')).resolves.toBe('unrelated replacement bytes')
  })

  it('refuses Session deletion when its JSON is unreadable even though unlink would succeed', async () => {
    const legacyPath = join(storageRoot, 'uploads', 'default-project', SESSION_ID, 'input.csv')
    const sessionPath = join(storageRoot, 'sessions', PROJECT_ID, `${SESSION_ID}.json`)
    await writeManagedFile(legacyPath, 'upload bytes')
    const unreadableSessions = new SessionRepository(storageRoot, {
      readSessionFile: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    })
    const guardedCoordinator = new SessionPersistenceCoordinator(
      unreadableSessions,
      files,
      undefined,
      undefined,
      new UploadRepository(storageRoot, { getClient: () => Promise.resolve(client) })
    )

    await expect(guardedCoordinator.deleteSession(PROJECT_ID, SESSION_ID)).rejects.toThrow(
      /cannot delete.*unreadable/i
    )

    await expect(readFile(sessionPath, 'utf8')).resolves.toContain(SESSION_ID)
    await expect(readFile(legacyPath, 'utf8')).resolves.toBe('upload bytes')
    await expect(
      client.uploadVersion.findUnique({ where: { id: 'upload-version-1' } })
    ).resolves.toBeDefined()
    await expect(rm(sessionPath)).resolves.toBeUndefined()
  })

  it('deletes malformed Project authority after terminal-cleaning readable sibling Uploads', async () => {
    const projectDir = join(storageRoot, 'sessions', PROJECT_ID)
    const sessionPath = join(projectDir, `${SESSION_ID}.json`)
    const siblingId = 'readable-session'
    const siblingLegacyPath = join(
      storageRoot,
      'uploads',
      'default-project',
      siblingId,
      'readable.csv'
    )
    const readableSibling = createSession(uploadPath, artifactPath)
    readableSibling.id = siblingId
    readableSibling.messages[0].uploads = [
      {
        id: 'readable-upload',
        sessionId: siblingId,
        name: 'readable.csv',
        originalName: 'readable.csv',
        path: siblingLegacyPath,
        size: 'readable bytes'.length
      }
    ]
    await writeManagedFile(siblingLegacyPath, 'readable bytes')
    await writeFile(
      join(projectDir, `${siblingId}.json`),
      JSON.stringify({ version: 2, session: readableSibling }),
      'utf8'
    )
    await writeFile(sessionPath, '{malformed Session JSON', 'utf8')

    await expect(coordinator.deleteProjectSessions(PROJECT_ID)).resolves.toEqual({
      status: 'completed'
    })

    await expect(readdir(projectDir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(siblingLegacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(files.getOverview(PROJECT_ID)).resolves.toMatchObject({ totalCount: 0 })
    await expect(
      client.uploadVersion.findFirst({ where: { uploadFileId: 'readable-upload', state: 'ready' } })
    ).resolves.toBeTruthy()
  })

  it('deletes the target Project without reading an unrelated unavailable Project', async () => {
    const otherSession = createSession(uploadPath, artifactPath)
    otherSession.id = 'session-b'
    otherSession.projectId = 'project-b'
    otherSession.messages = []
    otherSession.artifacts = []
    otherSession.filesRevision = 0
    await sessions.saveSession(otherSession)
    const legacyPath = join(storageRoot, 'uploads', 'default-project', SESSION_ID, 'input.csv')
    await writeManagedFile(legacyPath, 'upload bytes')
    const scopedSessions = new SessionRepository(storageRoot, {
      readSessionFile: async (filePath) => {
        if (filePath.includes(join('sessions', 'project-b'))) {
          throw Object.assign(new Error('unrelated project unavailable'), { code: 'EACCES' })
        }
        return readFile(filePath, 'utf8')
      }
    })
    const scopedCoordinator = new SessionPersistenceCoordinator(
      scopedSessions,
      files,
      undefined,
      undefined,
      new UploadRepository(storageRoot, { getClient: () => Promise.resolve(client) })
    )

    await scopedCoordinator.deleteProjectSessions(PROJECT_ID)

    await expect(sessions.loadSession(PROJECT_ID, SESSION_ID)).resolves.toBeUndefined()
    await expect(sessions.loadSession('project-b', 'session-b')).resolves.toBeDefined()
    await expect(readFile(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

const createSession = (_uploadPath: string, artifactPath: string): PersistedChatSession => ({
  id: SESSION_ID,
  projectId: PROJECT_ID,
  title: 'Deletion integration',
  cwd: '/workspace',
  status: 'idle',
  messages: [
    {
      id: 'message-user',
      role: 'user',
      content: 'Analyze the upload',
      status: 'complete',
      eventIds: [],
      uploads: [
        {
          id: 'upload-1',
          versionId: 'upload-version-1',
          versionNumber: 1,
          sessionId: SESSION_ID,
          name: 'input.csv',
          originalName: 'input.csv',
          size: 'upload bytes'.length,
          sha256: createHash('sha256').update('upload bytes').digest('hex')
        }
      ],
      createdAt: 100,
      updatedAt: 100
    }
  ],
  artifacts: [
    {
      id: 'artifact-1',
      kind: 'managed-file',
      path: artifactPath,
      name: 'result.txt'
    }
  ],
  filesRevision: 1,
  createdAt: 100,
  updatedAt: 200
})

const createPathOnlySession = (legacyPath: string): PersistedChatSession => {
  const session = createSession('', '')
  session.artifacts = []
  session.messages[0].uploads = [
    {
      id: 'upload-1',
      sessionId: SESSION_ID,
      name: 'input.csv',
      originalName: 'input.csv',
      path: legacyPath,
      size: 'upload bytes'.length
    }
  ]
  return session
}

const replaceLiveSessionWithLegacyTombstone = async (
  storageRoot: string,
  session: PersistedChatSession
): Promise<string> => {
  const liveProjectDir = join(storageRoot, 'sessions', PROJECT_ID)
  const tombstoneDir = join(storageRoot, 'deleted-sessions', PROJECT_ID)
  await rm(liveProjectDir, { recursive: true, force: true })
  await mkdir(tombstoneDir, { recursive: true })
  await writeFile(
    join(tombstoneDir, `${SESSION_ID}.json`),
    JSON.stringify({ version: 2, session }),
    'utf8'
  )
  return tombstoneDir
}

const writeManagedFile = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

const relativeStorageKey = (root: string, path: string): string =>
  path
    .slice(root.length + 1)
    .split(sep)
    .join('/')
