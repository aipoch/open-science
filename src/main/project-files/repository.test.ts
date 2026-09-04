import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'

import type { Prisma, PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createLinearConversationGraph,
  forkEditedConversationMessage
} from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { PENDING_UPLOAD_SESSION_ID } from '../../shared/uploads'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { UploadRepository } from '../uploads/repository'
import { createManagedFileIndexRepository, ManagedFileIndexRepository } from './repository'

const PROJECT_ID = 'project-a'
const SESSION_ID = 'session-a'

const storageKey = (storageRoot: string, path: string): string =>
  relative(storageRoot, path).split(sep).join('/')
// Hosted Windows runners rebuild the migration ledger in beforeEach. The
// Windows full-test workflow's 60s CLI hook budget does not override the
// Vitest project config, so schema-backed hooks still die at 30s.
const WINDOWS_SQLITE_HOOK_TIMEOUT_MS = 120_000

const createSession = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession => ({
  id: SESSION_ID,
  projectId: PROJECT_ID,
  title: 'Analysis',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1_710_000_000_000,
  updatedAt: 1_710_000_001_000,
  filesRevision: 1,
  ...overrides
})

describe('ManagedFileIndexRepository', () => {
  let storageRoot: string
  let client: PrismaClient
  let repository: ManagedFileIndexRepository
  let uploadRepository: UploadRepository

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-project-files-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.createMany({
      data: [
        { id: PROJECT_ID, name: 'Project A' },
        { id: 'project-b', name: 'Project B' }
      ]
    })
    uploadRepository = new UploadRepository(storageRoot, {
      getClient: () => Promise.resolve(client)
    })
    repository = new ManagedFileIndexRepository(
      () => Promise.resolve(client),
      storageRoot,
      new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client)
      }),
      uploadRepository
    )
  }, WINDOWS_SQLITE_HOOK_TIMEOUT_MS)

  afterEach(async () => {
    await client.$disconnect()
    await rm(storageRoot, { recursive: true, force: true })
  }, WINDOWS_SQLITE_HOOK_TIMEOUT_MS)

  it('adopts a path-only legacy Artifact into an immutable v1 before indexing it', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'legacy.md'
    )
    await writeManagedFile(artifactPath, 'legacy artifact\n')

    const session = createSession({
      artifacts: [
        {
          id: 'legacy-artifact-1',
          kind: 'managed-file',
          path: artifactPath,
          name: 'legacy.md',
          mimeType: 'text/markdown'
        }
      ]
    })
    await repository.syncSession(session)

    const lineage = await client.artifactLineage.findUniqueOrThrow({
      where: { id: 'legacy-artifact-1' },
      include: { currentVersion: true }
    })
    expect(lineage.currentVersion).toMatchObject({
      versionNumber: 1,
      state: 'finalized',
      originKind: 'legacy',
      basedOnVersionId: null,
      checksum: createHash('sha256').update('legacy artifact\n').digest('hex')
    })
    const indexed = await client.managedFile.findUniqueOrThrow({
      where: {
        projectId_source_sourceFileId: {
          projectId: PROJECT_ID,
          source: 'artifact',
          sourceFileId: lineage.id
        }
      }
    })
    expect(indexed.sourceVersionId).toBe(lineage.currentVersionId)
    expect(indexed.storageKey).toMatch(
      /^artifacts\/project-a\/session-a\/legacy-artifact-1\/managed-versions\/v[a-z0-9]{8}_legacy\.md$/u
    )
    expect(indexed.storageKey).not.toBe(storageKey(storageRoot, artifactPath))

    await rm(artifactPath)
    await expect(repository.syncSession(session)).resolves.toEqual([])
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      artifactCount: 1,
      isIndexComplete: true
    })
  })

  it('resolves a legacy preview id collision to the scoped Artifact logical identity', async () => {
    // A legacy preview id can already belong to another Session after adoption; the filename is the
    // scoped compatibility hint, while the authoritative catalog still decides visibility and head.
    const otherArtifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      'other-session',
      'message-1',
      'other.md'
    )
    await writeManagedFile(otherArtifactPath, 'other artifact\n')
    await repository.syncSession(
      createSession({
        id: 'other-session',
        artifacts: [
          {
            id: 'legacy-artifact-1',
            kind: 'managed-file',
            path: otherArtifactPath,
            name: 'legacy.md',
            mimeType: 'text/markdown'
          }
        ]
      })
    )
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'legacy.md'
    )
    await writeManagedFile(artifactPath, 'legacy artifact\n')
    await repository.syncSession(
      createSession({
        artifacts: [
          {
            id: 'legacy-artifact-1',
            kind: 'managed-file',
            path: artifactPath,
            name: 'legacy.md',
            mimeType: 'text/markdown'
          }
        ]
      })
    )
    const lineage = await client.artifactLineage.findUniqueOrThrow({
      where: {
        projectId_sessionId_normalizedFilename: {
          projectId: PROJECT_ID,
          sessionId: SESSION_ID,
          normalizedFilename: 'legacy.md'
        }
      }
    })

    const resolved = await repository.resolveFile({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      source: 'artifact',
      fileIdHint: 'legacy-artifact-1',
      identityHint: 'legacy',
      name: 'LEGACY.md'
    })

    expect(lineage.id).not.toBe('legacy-artifact-1')
    expect(resolved).toMatchObject({
      id: lineage.id,
      source: 'artifact',
      sourceFileId: lineage.id,
      sourceVersionId: lineage.currentVersionId,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      name: 'legacy.md',
      path: `artifact-version:${PROJECT_ID}/${SESSION_ID}/${lineage.id}/${lineage.currentVersionId}`
    })
  })

  it('resolves a stable Artifact id when a legacy mention carries the viewing Session id', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'report.md'
    )
    await writeManagedFile(artifactPath, 'source artifact\n')
    await repository.syncSession(
      createSession({
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: artifactPath,
            name: 'report.md',
            mimeType: 'text/markdown'
          }
        ]
      })
    )

    await expect(
      repository.resolveFile({
        projectId: PROJECT_ID,
        sessionId: 'viewing-session',
        source: 'artifact',
        fileIdHint: 'artifact-1',
        identityHint: 'logical',
        name: 'report.md'
      })
    ).resolves.toMatchObject({
      sourceFileId: 'artifact-1',
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      name: 'report.md'
    })
  })

  it('does not publish a legacy Artifact when its persisted checksum disagrees with the source', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'legacy-mismatch.md'
    )
    await writeManagedFile(artifactPath, 'actual legacy bytes\n')

    await repository.syncSession(
      createSession({
        artifacts: [
          {
            id: 'legacy-artifact-mismatch',
            kind: 'managed-file',
            path: artifactPath,
            name: 'legacy-mismatch.md',
            sha256: createHash('sha256').update('different bytes\n').digest('hex')
          }
        ]
      })
    )

    expect(await client.artifactLineage.count({ where: { id: 'legacy-artifact-mismatch' } })).toBe(
      0
    )
    expect(await client.artifactVersion.count()).toBe(0)
  })

  it('upgrades a path-only Artifact even when the legacy projection revision already matches', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'legacy-fast-path.md'
    )
    await writeManagedFile(artifactPath, 'legacy fast path\n')
    await client.managedFile.create({
      data: {
        source: 'artifact',
        sourceFileId: 'legacy-fast-path',
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        displayName: 'legacy-fast-path.md',
        storageKey: storageKey(storageRoot, artifactPath),
        sizeBytes: BigInt(Buffer.byteLength('legacy fast path\n')),
        sortAtMs: 1n
      }
    })
    await client.managedFileSessionSync.create({
      data: {
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        filesRevision: 1,
        groupSortAtMs: 1n,
        artifactCount: 1,
        uploadCount: 0
      }
    })

    await expect(
      repository.syncSession(
        createSession({
          artifacts: [
            {
              id: 'legacy-fast-path',
              kind: 'managed-file',
              path: artifactPath,
              name: 'legacy-fast-path.md'
            }
          ]
        })
      )
    ).resolves.toEqual(['artifact'])

    await expect(
      client.artifactLineage.findUniqueOrThrow({ where: { id: 'legacy-fast-path' } })
    ).resolves.toMatchObject({ currentVersionId: expect.any(String) })
    await expect(
      client.managedFile.findUniqueOrThrow({
        where: {
          projectId_source_sourceFileId: {
            projectId: PROJECT_ID,
            source: 'artifact',
            sourceFileId: 'legacy-fast-path'
          }
        }
      })
    ).resolves.toMatchObject({ sourceVersionId: expect.any(String) })
  })

  it('indexes uploads and all finalized managed artifacts without requiring a message link', async () => {
    const uploadPath = join(storageRoot, 'uploads', 'default-project', SESSION_ID, 'input.csv')
    const linkedArtifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-agent',
      'chart.png'
    )
    const orphanArtifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-orphan',
      'notes.txt'
    )

    await Promise.all([
      writeManagedFile(uploadPath, 'a,b\n1,2'),
      writeManagedFile(linkedArtifactPath, 'png'),
      writeManagedFile(orphanArtifactPath, 'notes')
    ])

    const legacySession = createSession({
      messages: [
        {
          id: 'message-user',
          role: 'user',
          content: 'Analyze',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: 'upload-1',
              sessionId: SESSION_ID,
              name: 'input.csv',
              originalName: 'samples.csv',
              path: uploadPath,
              mimeType: 'text/csv',
              size: 7
            }
          ],
          createdAt: 1_710_000_000_100,
          updatedAt: 1_710_000_000_200
        },
        {
          id: 'message-agent',
          role: 'agent',
          content: 'Done',
          status: 'complete',
          eventIds: [],
          artifactIds: ['artifact-linked'],
          createdAt: 1_710_000_000_300,
          updatedAt: 1_710_000_000_400
        }
      ],
      artifacts: [
        {
          id: 'artifact-linked',
          kind: 'managed-file',
          path: linkedArtifactPath,
          name: 'chart.png',
          mimeType: 'image/png'
        },
        {
          id: 'artifact-orphan',
          kind: 'managed-file',
          path: orphanArtifactPath,
          name: 'notes.txt',
          mimeType: 'text/plain'
        }
      ]
    })
    const changedSources = await repository.syncSession(legacySession)
    expect(changedSources).toEqual(['artifact', 'upload'])

    await expect(repository.getOverview(PROJECT_ID)).resolves.toEqual({
      totalCount: 3,
      uploadCount: 1,
      artifactCount: 2,
      artifactGroupCount: 1,
      isIndexComplete: true
    })

    const uploads = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'uploads' },
      limit: 24
    })
    expect(uploads.items).toEqual([
      expect.objectContaining({
        source: 'upload',
        sourceFileId: 'upload-1',
        sourceVersionId: expect.any(String),
        messageId: undefined,
        name: 'samples.csv',
        path: expect.stringMatching(
          /^upload-version:project-a\/session-a\/upload-1\/[a-zA-Z0-9-]+$/u
        )
      })
    ])

    const artifacts = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
      limit: 24
    })
    expect(artifacts.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceFileId: 'artifact-linked', messageId: 'message-agent' }),
        expect.objectContaining({ sourceFileId: 'artifact-orphan', messageId: undefined })
      ])
    )

    const allFiles = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'all' },
      limit: 24
    })
    expect(allFiles.totalCount).toBe(3)
    expect(allFiles.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'upload', sourceFileId: 'upload-1' }),
        expect.objectContaining({ source: 'artifact', sourceFileId: 'artifact-linked' }),
        expect.objectContaining({ source: 'artifact', sourceFileId: 'artifact-orphan' })
      ])
    )

    await expect(
      repository.listArtifactGroups({ projectId: PROJECT_ID, limit: 10 })
    ).resolves.toEqual({
      items: [
        {
          sessionId: SESSION_ID,
          artifactCount: 2,
          originSession: { state: 'active' }
        }
      ],
      totalCount: 1,
      nextCursor: undefined
    })
  })

  it('projects the latest finalized Artifact Version instead of a stale Session descriptor', async () => {
    const lineageId = 'artifact-lineage-latest'
    const versionOneId = 'artifact-version-stale'
    const versionTwoId = 'artifact-version-latest'
    const versionOnePath = join(
      storageRoot,
      'artifacts',
      PROJECT_ID,
      SESSION_ID,
      lineageId,
      'versions',
      versionOneId,
      'content'
    )
    const versionTwoPath = join(
      storageRoot,
      'artifacts',
      PROJECT_ID,
      SESSION_ID,
      lineageId,
      'versions',
      versionTwoId,
      'content'
    )
    await Promise.all([
      writeManagedFile(versionOnePath, 'old image'),
      writeManagedFile(versionTwoPath, 'latest image')
    ])
    await client.fileOriginSession.create({
      data: { projectId: PROJECT_ID, sessionId: SESSION_ID }
    })
    await client.artifactLineage.create({
      data: {
        id: lineageId,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        normalizedFilename: 'sin.png',
        filename: 'sin.png'
      }
    })
    const createVersionData = (
      id: string,
      versionNumber: number,
      contentPath: string,
      messageId: string,
      checksumCharacter: string
    ): Prisma.ArtifactVersionUncheckedCreateInput => ({
      id,
      artifactId: lineageId,
      versionNumber,
      filename: 'sin.png',
      artifactRunId: `artifact-run-${versionNumber}`,
      writeOperationId: `write-${versionNumber}`,
      writeRequestChecksum: checksumCharacter.repeat(64),
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-segment-1',
      promptMessageId: `prompt-${versionNumber}`,
      messageId,
      state: 'finalized',
      managedVisibleAt: new Date(`2026-07-28T00:00:0${versionNumber}.500Z`),
      contentStorageKey: storageKey(storageRoot, contentPath),
      evidenceStorageKey: `artifacts/${PROJECT_ID}/${SESSION_ID}/.provenance/${lineageId}/versions/${id}/evidence.json`,
      evidenceSchemaVersion: 1,
      contentType: 'image/png',
      sizeBytes: BigInt(versionNumber === 1 ? 9 : 12),
      checksum: checksumCharacter.repeat(64),
      evidenceJson: '{"schema_version":1}',
      evidenceChecksum: checksumCharacter.toUpperCase().repeat(64),
      createdAt: new Date(`2026-07-28T00:00:0${versionNumber}.000Z`)
    })
    await client.artifactVersion.create({
      data: createVersionData(versionOneId, 1, versionOnePath, 'message-v1', 'a')
    })
    await client.artifactLineage.update({
      where: { id: lineageId },
      data: { currentVersionId: versionOneId }
    })

    // Session metadata can lag the independently committed Version catalog until the next save.
    const staleSession = createSession({
      artifacts: [
        {
          id: versionOneId,
          artifactId: lineageId,
          versionId: versionOneId,
          versionNumber: 1,
          kind: 'managed-file',
          path: versionOnePath,
          name: 'sin.png',
          mimeType: 'image/png',
          size: 9,
          mtimeMs: 1_710_000_000_100
        }
      ]
    })
    await repository.syncSession(staleSession)
    await client.artifactVersion.create({
      data: createVersionData(versionTwoId, 2, versionTwoPath, 'message-v2', 'b')
    })
    await client.artifactLineage.update({
      where: { id: lineageId },
      data: { currentVersionId: versionTwoId }
    })
    await expect(repository.syncSession(staleSession)).resolves.toContain('artifact')

    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
        limit: 10
      })
    ).resolves.toMatchObject({
      totalCount: 1,
      items: [
        {
          sourceFileId: lineageId,
          sourceVersionId: versionTwoId,
          messageId: 'message-v2',
          name: 'sin.png',
          path: `artifact-version:${PROJECT_ID}/${SESSION_ID}/${lineageId}/${versionTwoId}`,
          checksum: 'b'.repeat(64),
          size: 12
        }
      ]
    })
    await expect(
      repository.searchArtifacts({
        primaryProjectId: PROJECT_ID,
        otherProjectIds: [],
        filenameContains: 'sin.png',
        primaryLimit: 8,
        otherLimit: 0
      })
    ).resolves.toMatchObject({
      primary: {
        items: [
          {
            sourceFileId: lineageId,
            sourceVersionId: versionTwoId,
            sortAtMs: new Date('2026-07-28T00:00:02.000Z').getTime()
          }
        ]
      }
    })
  })

  it('exposes immutable uploads as project-and-session-scoped Version references', async () => {
    const uploadPath = join(
      storageRoot,
      'uploads',
      PROJECT_ID,
      SESSION_ID,
      'upload-1',
      'versions',
      'upload-version-1',
      'content'
    )
    const content = 'a,b\n1,2'
    await writeManagedFile(uploadPath, content)
    await client.fileOriginSession.create({
      data: { projectId: PROJECT_ID, sessionId: SESSION_ID }
    })
    await client.uploadFile.create({
      data: {
        id: 'upload-1',
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        filename: 'input.csv',
        originalFilename: 'samples.csv',
        versions: {
          create: {
            id: 'upload-version-1',
            versionNumber: 1,
            state: 'ready',
            contentStorageKey: storageKey(storageRoot, uploadPath),
            filename: 'input.csv',
            originalFilename: 'samples.csv',
            contentType: 'text/csv',
            sizeBytes: BigInt(Buffer.byteLength(content)),
            checksum: createHash('sha256').update(content).digest('hex')
          }
        }
      }
    })
    await client.uploadFile.update({
      where: { id: 'upload-1' },
      data: { currentVersionId: 'upload-version-1' }
    })
    await repository.syncSession(
      createSession({
        messages: [
          {
            id: 'message-user',
            role: 'user',
            content: 'Analyze',
            status: 'complete',
            eventIds: [],
            uploads: [
              {
                id: 'upload-1',
                versionId: 'upload-version-1',
                versionNumber: 1,
                sessionId: SESSION_ID,
                name: 'input.csv',
                originalName: 'samples.csv',
                size: Buffer.byteLength(content)
              }
            ],
            createdAt: 1_710_000_000_100,
            updatedAt: 1_710_000_000_200
          }
        ]
      })
    )

    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'uploads' },
        limit: 24
      })
    ).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          path: `upload-version:${PROJECT_ID}/${SESSION_ID}/upload-1/upload-version-1`
        })
      ]
    })
  })

  it('keeps the DB Upload head as the default projection when Session references an older Version', async () => {
    const uploadId = 'upload-versioned'
    const versions = await Promise.all(
      [1, 2, 3].map(async (versionNumber) => {
        const id = `upload-version-${versionNumber}`
        const content = `version ${versionNumber}\n`
        const path = join(
          storageRoot,
          'uploads',
          PROJECT_ID,
          SESSION_ID,
          uploadId,
          'versions',
          id,
          'content'
        )
        await writeManagedFile(path, content)
        return {
          id,
          versionNumber,
          state: 'ready',
          contentStorageKey: storageKey(storageRoot, path),
          filename: 'notes.md',
          originalFilename: 'notes.md',
          contentType: 'text/markdown',
          sizeBytes: BigInt(Buffer.byteLength(content)),
          checksum: createHash('sha256').update(content).digest('hex')
        }
      })
    )
    await client.fileOriginSession.create({
      data: { projectId: PROJECT_ID, sessionId: SESSION_ID }
    })
    await client.uploadFile.create({
      data: {
        id: uploadId,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        filename: 'notes.md',
        originalFilename: 'notes.md',
        currentVersionId: null,
        versions: { create: versions }
      }
    })
    await client.uploadFile.update({
      where: { id: uploadId },
      data: { currentVersionId: versions[1]!.id }
    })
    const session = createSession({
      messages: [
        {
          id: 'message-upload-v1',
          role: 'user',
          content: 'Use the original upload',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: uploadId,
              versionId: versions[0]!.id,
              versionNumber: 1,
              sessionId: SESSION_ID,
              name: 'notes.md',
              originalName: 'notes.md',
              size: Number(versions[0]!.sizeBytes)
            }
          ],
          createdAt: 1_710_000_000_100,
          updatedAt: 1_710_000_000_200
        }
      ]
    })
    await repository.syncSession(session)
    await client.uploadFile.update({
      where: { id: uploadId },
      data: { currentVersionId: versions[2]!.id }
    })

    await repository.syncSession({ ...session, filesRevision: 2 })

    await expect(
      client.managedFile.findFirstOrThrow({ where: { source: 'upload', sourceFileId: uploadId } })
    ).resolves.toMatchObject({
      sourceVersionId: versions[2]!.id,
      storageKey: versions[2]!.contentStorageKey,
      checksum: versions[2]!.checksum
    })
  })

  it('invalidates the filesRevision fast path when the native Upload head advances', async () => {
    const uploadId = 'upload-head-fast-path'
    const versions = await Promise.all(
      [1, 2].map(async (versionNumber) => {
        const id = `upload-head-fast-path-v${versionNumber}`
        const content = `version ${versionNumber}\n`
        const path = join(
          storageRoot,
          'uploads',
          PROJECT_ID,
          SESSION_ID,
          uploadId,
          'versions',
          id,
          'content'
        )
        await writeManagedFile(path, content)
        return {
          id,
          versionNumber,
          state: 'ready',
          contentStorageKey: storageKey(storageRoot, path),
          filename: 'fast-path.md',
          originalFilename: 'fast-path.md',
          contentType: 'text/markdown',
          sizeBytes: BigInt(Buffer.byteLength(content)),
          checksum: createHash('sha256').update(content).digest('hex')
        }
      })
    )
    await client.fileOriginSession.create({
      data: { projectId: PROJECT_ID, sessionId: SESSION_ID }
    })
    await client.uploadFile.create({
      data: {
        id: uploadId,
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        filename: 'fast-path.md',
        originalFilename: 'fast-path.md',
        versions: { create: versions }
      }
    })
    await client.uploadFile.update({
      where: { id: uploadId },
      data: { currentVersionId: versions[0]!.id }
    })
    const session = createSession({
      filesRevision: 7,
      messages: [
        {
          id: 'message-fast-path',
          role: 'user',
          content: 'upload',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: uploadId,
              versionId: versions[0]!.id,
              versionNumber: 1,
              sessionId: SESSION_ID,
              name: 'fast-path.md',
              originalName: 'fast-path.md',
              size: Number(versions[0]!.sizeBytes)
            }
          ],
          createdAt: 1_710_000_000_100,
          updatedAt: 1_710_000_000_200
        }
      ]
    })
    await repository.syncSession(session)
    await client.uploadFile.update({
      where: { id: uploadId },
      data: { currentVersionId: versions[1]!.id }
    })

    await expect(repository.syncSession(session)).resolves.toEqual(['upload'])
    await expect(
      client.managedFile.findFirstOrThrow({ where: { sourceFileId: uploadId } })
    ).resolves.toMatchObject({
      sourceVersionId: versions[1]!.id,
      storageKey: versions[1]!.contentStorageKey
    })
  })

  it('paginates native Upload heads by authoritative session and head sort metadata', async () => {
    await client.fileOriginSession.createMany({
      data: [
        { projectId: PROJECT_ID, sessionId: 'session-old' },
        { projectId: PROJECT_ID, sessionId: 'session-new' }
      ]
    })
    for (const input of [
      {
        fileId: 'upload-old',
        sessionId: 'session-old',
        versionId: 'upload-old-v2',
        createdAt: new Date('2026-08-13T00:00:00.000Z')
      },
      {
        fileId: 'upload-new',
        sessionId: 'session-new',
        versionId: 'upload-new-v2',
        createdAt: new Date('2026-08-14T00:00:00.000Z')
      }
    ]) {
      await client.uploadFile.create({
        data: {
          id: input.fileId,
          projectId: PROJECT_ID,
          sessionId: input.sessionId,
          filename: `${input.fileId}.txt`,
          originalFilename: `${input.fileId}.txt`,
          versions: {
            create: {
              id: input.versionId,
              versionNumber: 2,
              state: 'ready',
              contentStorageKey: `uploads/${PROJECT_ID}/${input.sessionId}/${input.versionId}`,
              filename: `${input.fileId}.txt`,
              originalFilename: `${input.fileId}.txt`,
              contentType: 'text/plain',
              sizeBytes: 2n,
              checksum: input.fileId === 'upload-new' ? 'a'.repeat(64) : 'b'.repeat(64),
              createdAt: input.createdAt
            }
          }
        }
      })
      await client.uploadFile.update({
        where: { id: input.fileId },
        data: { currentVersionId: input.versionId }
      })
    }
    await client.managedFile.createMany({
      data: [
        {
          source: 'upload',
          sourceFileId: 'upload-new',
          sourceVersionId: 'stale-new-v1',
          projectId: PROJECT_ID,
          sessionId: 'stale-session',
          displayName: 'stale-new.txt',
          storageKey: 'stale-new',
          sizeBytes: 1n,
          sortAtMs: 1n
        },
        {
          source: 'upload',
          sourceFileId: 'upload-old',
          sourceVersionId: 'stale-old-v1',
          projectId: PROJECT_ID,
          sessionId: 'stale-session',
          displayName: 'stale-old.txt',
          storageKey: 'stale-old',
          sizeBytes: 1n,
          sortAtMs: 9_999_999_999_999n
        }
      ]
    })

    const first = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'uploads' },
      limit: 1
    })
    const second = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'uploads' },
      limit: 1,
      cursor: first.nextCursor
    })

    expect(first).toMatchObject({
      items: [
        {
          sourceFileId: 'upload-new',
          sourceVersionId: 'upload-new-v2',
          sessionId: 'session-new',
          name: 'upload-new.txt'
        }
      ],
      totalCount: 2
    })
    expect(second).toMatchObject({
      items: [
        {
          sourceFileId: 'upload-old',
          sourceVersionId: 'upload-old-v2',
          sessionId: 'session-old'
        }
      ],
      totalCount: 2
    })
  })

  it('bounds large authoritative catalog pages inside SQLite on every cursor request', async () => {
    await client.fileOriginSession.create({
      data: { projectId: PROJECT_ID, sessionId: 'large-session' }
    })
    const artifacts = Array.from({ length: 125 }, (_, index) => {
      const suffix = index.toString().padStart(3, '0')
      return {
        fileId: `large-artifact-${suffix}`,
        versionId: `large-artifact-version-${suffix}`,
        filename: `large-${suffix}.txt`,
        storageKey: `large/${index}`,
        sortAtMs: BigInt(index)
      }
    })
    await client.artifactLineage.createMany({
      data: artifacts.map((artifact) => ({
        id: artifact.fileId,
        projectId: PROJECT_ID,
        sessionId: 'large-session',
        normalizedFilename: artifact.filename,
        filename: artifact.filename
      }))
    })
    await client.artifactVersion.createMany({
      data: artifacts.map((artifact) => ({
        id: artifact.versionId,
        artifactId: artifact.fileId,
        versionNumber: 1,
        filename: artifact.filename,
        originKind: 'legacy',
        state: 'finalized',
        contentStorageKey: artifact.storageKey,
        sizeBytes: 1n,
        checksum: 'a'.repeat(64)
      }))
    })
    await client.$transaction(
      artifacts.map((artifact) =>
        client.artifactLineage.update({
          where: { id: artifact.fileId },
          data: { currentVersionId: artifact.versionId }
        })
      )
    )
    await client.managedFile.createMany({
      data: artifacts.map((artifact) => ({
        source: 'artifact',
        sourceFileId: artifact.fileId,
        sourceVersionId: artifact.versionId,
        checksum: 'a'.repeat(64),
        projectId: PROJECT_ID,
        sessionId: 'large-session',
        displayName: artifact.filename,
        storageKey: artifact.storageKey,
        sizeBytes: 1n,
        sortAtMs: artifact.sortAtMs
      }))
    })
    const queryRaw = vi.spyOn(client, '$queryRaw')

    const first = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'sessionArtifacts', sessionId: 'large-session' },
      limit: 100
    })
    const second = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'sessionArtifacts', sessionId: 'large-session' },
      cursor: first.nextCursor,
      limit: 100
    })

    expect(first.items).toHaveLength(100)
    expect(second.items).toHaveLength(25)
    expect(new Set([...first.items, ...second.items].map((item) => item.sourceFileId)).size).toBe(
      125
    )
    const sqlCalls = queryRaw.mock.calls.map(([query]) =>
      'strings' in (query as object)
        ? (query as { strings: readonly string[] }).strings.join('?')
        : String(query)
    )
    expect(sqlCalls.filter((sql) => /ORDER BY[\s\S]+LIMIT/u.test(sql))).toHaveLength(2)
  })

  it('repairs a native Upload projection that copied the referencing Session scope', async () => {
    const sourceSessionId = 'session-source'
    const uploadId = 'upload-cross-session'
    const versionId = 'upload-version-cross-session'
    const uploadPath = join(
      storageRoot,
      'uploads',
      PROJECT_ID,
      sourceSessionId,
      uploadId,
      'versions',
      versionId,
      'content'
    )
    const content = 'sample,value\na,1'
    await writeManagedFile(uploadPath, content)
    await client.fileOriginSession.create({
      data: { projectId: PROJECT_ID, sessionId: sourceSessionId }
    })
    await client.uploadFile.create({
      data: {
        id: uploadId,
        projectId: PROJECT_ID,
        sessionId: sourceSessionId,
        filename: 'source.csv',
        originalFilename: 'source.csv',
        versions: {
          create: {
            id: versionId,
            versionNumber: 1,
            state: 'ready',
            contentStorageKey: storageKey(storageRoot, uploadPath),
            filename: 'source.csv',
            originalFilename: 'source.csv',
            contentType: 'text/csv',
            sizeBytes: BigInt(Buffer.byteLength(content)),
            checksum: createHash('sha256').update(content).digest('hex')
          }
        }
      }
    })
    await client.uploadFile.update({
      where: { id: uploadId },
      data: { currentVersionId: versionId }
    })
    await client.managedFile.create({
      data: {
        source: 'upload',
        sourceFileId: uploadId,
        sourceVersionId: versionId,
        projectId: PROJECT_ID,
        // This is the stale pre-repair state: the row copied the Session containing the @ reference.
        sessionId: SESSION_ID,
        displayName: 'source.csv',
        storageKey: storageKey(storageRoot, uploadPath),
        mimeType: 'text/csv',
        sizeBytes: BigInt(Buffer.byteLength(content)),
        sortAtMs: 1_710_000_000_200n
      }
    })
    await client.managedFileSessionSync.create({
      data: {
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        filesRevision: 1,
        groupSortAtMs: 1_710_000_001_000n,
        uploadCount: 1
      }
    })
    const referencingSession = createSession({
      messages: [
        {
          id: 'message-reference',
          role: 'user',
          content: 'Use the source upload',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: uploadId,
              versionId,
              versionNumber: 1,
              sessionId: sourceSessionId,
              name: 'source.csv',
              originalName: 'source.csv',
              mimeType: 'text/csv',
              size: Buffer.byteLength(content)
            }
          ],
          createdAt: 1_710_000_000_100,
          updatedAt: 1_710_000_000_200
        }
      ]
    })

    await expect(repository.syncSession(referencingSession)).resolves.toContain('upload')
    await expect(
      client.managedFileSessionSync.findUnique({
        where: { projectId_sessionId: { projectId: PROJECT_ID, sessionId: SESSION_ID } }
      })
    ).resolves.toMatchObject({ uploadCount: 0 })
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'uploads' },
        limit: 10
      })
    ).resolves.toMatchObject({
      items: [
        {
          sourceFileId: uploadId,
          sourceVersionId: versionId,
          sessionId: sourceSessionId,
          path: `upload-version:${PROJECT_ID}/${sourceSessionId}/${uploadId}/${versionId}`
        }
      ]
    })
  })

  it('repairs a legacy Upload projection that copied the referencing Session scope', async () => {
    const sourceSessionId = 'session-source-legacy'
    const uploadId = 'upload-cross-session-legacy'
    const uploadPath = join(
      storageRoot,
      'uploads',
      'default-project',
      sourceSessionId,
      'reference.pdf'
    )
    const content = 'legacy pdf bytes'
    await writeManagedFile(uploadPath, content)
    await client.managedFile.create({
      data: {
        source: 'upload',
        sourceFileId: uploadId,
        projectId: PROJECT_ID,
        // This is the stale pre-repair state: the row copied the Session containing the @ reference.
        sessionId: SESSION_ID,
        displayName: 'reference.pdf',
        storageKey: storageKey(storageRoot, uploadPath),
        mimeType: 'application/pdf',
        sizeBytes: BigInt(Buffer.byteLength(content)),
        sortAtMs: 1_710_000_000_200n
      }
    })
    await client.managedFileSessionSync.create({
      data: {
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        filesRevision: 1,
        groupSortAtMs: 1_710_000_001_000n,
        uploadCount: 1
      }
    })
    const referencingSession = createSession({
      messages: [
        {
          id: 'message-reference-legacy',
          role: 'user',
          content: 'Use the source PDF',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: uploadId,
              sessionId: sourceSessionId,
              name: 'reference.pdf',
              originalName: 'reference.pdf',
              path: uploadPath,
              mimeType: 'application/pdf',
              size: Buffer.byteLength(content)
            }
          ],
          createdAt: 1_710_000_000_100,
          updatedAt: 1_710_000_000_200
        }
      ]
    })

    await expect(repository.syncSession(referencingSession)).resolves.toContain('upload')
    await expect(
      client.managedFileSessionSync.findUnique({
        where: { projectId_sessionId: { projectId: PROJECT_ID, sessionId: SESSION_ID } }
      })
    ).resolves.toMatchObject({ uploadCount: 0 })
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'uploads' },
        limit: 10
      })
    ).resolves.toMatchObject({
      items: [
        {
          sourceFileId: uploadId,
          sourceVersionId: expect.any(String),
          sessionId: sourceSessionId,
          path: expect.stringMatching(
            /^upload-version:project-a\/session-source-legacy\/upload-cross-session-legacy\/[a-zA-Z0-9-]+$/u
          )
        }
      ]
    })
  })

  it('keeps file Versions visible after their Message Branch becomes inactive', async () => {
    const uploadPath = join(
      storageRoot,
      'uploads',
      PROJECT_ID,
      SESSION_ID,
      'upload-inactive',
      'versions',
      'upload-version-inactive',
      'content'
    )
    const artifactPath = join(
      storageRoot,
      'artifacts',
      PROJECT_ID,
      SESSION_ID,
      'artifact-lineage-inactive',
      'versions',
      'artifact-version-inactive',
      'content'
    )
    const content = 'sample,value\na,1'
    await Promise.all([
      writeManagedFile(uploadPath, content),
      writeManagedFile(artifactPath, 'inactive artifact')
    ])
    await client.fileOriginSession.create({
      data: { projectId: PROJECT_ID, sessionId: SESSION_ID }
    })
    await client.uploadFile.create({
      data: {
        id: 'upload-inactive',
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        filename: 'inactive.csv',
        originalFilename: 'inactive.csv',
        versions: {
          create: {
            id: 'upload-version-inactive',
            versionNumber: 1,
            state: 'ready',
            contentStorageKey: storageKey(storageRoot, uploadPath),
            filename: 'inactive.csv',
            originalFilename: 'inactive.csv',
            contentType: 'text/csv',
            sizeBytes: BigInt(Buffer.byteLength(content)),
            checksum: createHash('sha256').update(content).digest('hex')
          }
        }
      }
    })
    await client.uploadFile.update({
      where: { id: 'upload-inactive' },
      data: { currentVersionId: 'upload-version-inactive' }
    })
    const inactiveMessage = {
      id: 'message-inactive-upload',
      role: 'user' as const,
      content: 'Analyze the upload',
      status: 'complete' as const,
      eventIds: [],
      artifactIds: ['artifact-version-inactive'],
      uploads: [
        {
          id: 'upload-inactive',
          sessionId: SESSION_ID,
          name: 'inactive.csv',
          originalName: 'inactive.csv',
          mimeType: 'text/csv',
          size: Buffer.byteLength(content),
          versionId: 'upload-version-inactive'
        }
      ],
      createdAt: 1_710_000_000_100,
      updatedAt: 1_710_000_000_200
    }
    const originalGraph = createLinearConversationGraph({
      sessionId: SESSION_ID,
      messages: [inactiveMessage],
      createdAt: 1_710_000_000_000,
      updatedAt: 1_710_000_000_200
    })
    const activeGraph = forkEditedConversationMessage(
      originalGraph,
      inactiveMessage.id,
      'message-branch-active',
      1_710_000_000_300
    )
    await client.artifactLineage.create({
      data: {
        id: 'artifact-lineage-inactive',
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        normalizedFilename: 'inactive-result.txt',
        filename: 'inactive-result.txt'
      }
    })
    await client.artifactVersion.create({
      data: {
        id: 'artifact-version-inactive',
        artifactId: 'artifact-lineage-inactive',
        versionNumber: 1,
        filename: 'inactive-result.txt',
        artifactRunId: 'artifact-run-inactive',
        writeOperationId: 'write-inactive',
        writeRequestChecksum: 'a'.repeat(64),
        rootFrameId: 'root-frame-inactive',
        agentFrameId: 'agent-frame-inactive',
        messageBranchId: activeGraph.frames[0].activeBranchId,
        runtimeSegmentId: 'runtime-segment-inactive',
        promptMessageId: inactiveMessage.id,
        messageId: inactiveMessage.id,
        state: 'finalized',
        managedVisibleAt: new Date('2026-07-28T00:00:00.500Z'),
        contentStorageKey: storageKey(storageRoot, artifactPath),
        evidenceStorageKey:
          'artifacts/project-a/session-a/.provenance/artifact-lineage-inactive/versions/artifact-version-inactive/evidence.json',
        evidenceSchemaVersion: 1,
        contentType: 'text/plain',
        sizeBytes: BigInt(Buffer.byteLength('inactive artifact')),
        checksum: createHash('sha256').update('inactive artifact').digest('hex'),
        evidenceJson: '{"schema_version":1}',
        evidenceChecksum: 'b'.repeat(64)
      }
    })
    await client.artifactLineage.update({
      where: { id: 'artifact-lineage-inactive' },
      data: { currentVersionId: 'artifact-version-inactive' }
    })

    await repository.syncSession(
      createSession({
        messages: [],
        conversationGraph: activeGraph,
        artifacts: [
          {
            id: 'artifact-version-inactive',
            artifactId: 'artifact-lineage-inactive',
            versionId: 'artifact-version-inactive',
            versionNumber: 1,
            kind: 'managed-file',
            path: artifactPath,
            name: 'inactive-result.txt',
            mimeType: 'text/plain'
          }
        ],
        filesRevision: 2
      })
    )

    const files = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'all' },
      limit: 24
    })
    expect(files.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'upload',
          sourceVersionId: 'upload-version-inactive',
          name: 'inactive.csv'
        }),
        expect.objectContaining({
          source: 'artifact',
          sourceFileId: 'artifact-lineage-inactive',
          sourceVersionId: 'artifact-version-inactive',
          name: 'inactive-result.txt'
        })
      ])
    )
    expect(files.totalCount).toBe(2)
  })

  it('keeps the SQLite config root separate from the relocatable data root', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'open-science-project-files-data-'))
    const getClientForRoot = vi.fn(async (root: string) => {
      expect(root).toBe(storageRoot)
      return client
    })
    const dataRepository = createManagedFileIndexRepository(
      getClientForRoot,
      storageRoot,
      dataRoot,
      new ManagedFileVersionService({
        storageRoot: dataRoot,
        getClient: () => Promise.resolve(client)
      }),
      new UploadRepository(dataRoot, { getClient: () => Promise.resolve(client) })
    )
    const artifactPath = join(
      dataRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'result.txt'
    )

    try {
      await writeManagedFile(artifactPath, 'result')

      await expect(
        dataRepository.syncSession(
          createSession({
            artifacts: [
              {
                id: 'artifact-data-root',
                kind: 'managed-file',
                path: artifactPath,
                name: 'result.txt'
              }
            ]
          })
        )
      ).resolves.toEqual(['artifact'])
      await expect(dataRepository.getOverview(PROJECT_ID)).resolves.toMatchObject({
        totalCount: 1,
        artifactCount: 1,
        isIndexComplete: true
      })
      await expect(
        dataRepository.listFiles({
          projectId: PROJECT_ID,
          collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
          limit: 20
        })
      ).resolves.toMatchObject({
        items: [
          expect.objectContaining({
            path: expect.stringMatching(
              /^artifact-version:project-a\/session-a\/artifact-data-root\//u
            )
          })
        ]
      })
      expect(getClientForRoot).toHaveBeenCalledWith(storageRoot)
    } finally {
      await rm(dataRoot, { recursive: true, force: true })
    }
  })

  it('does not use a shared legacy path as cross-session logical file identity', async () => {
    const sharedPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      'legacy-shared',
      'result.txt'
    )
    await writeManagedFile(sharedPath, 'shared result')
    await repository.syncSession(
      createSession({
        artifacts: [
          { id: 'artifact-a', kind: 'managed-file', path: sharedPath, name: 'result.txt' }
        ]
      })
    )
    const duplicateSession = createSession({
      id: 'session-b',
      artifacts: [{ id: 'artifact-b', kind: 'managed-file', path: sharedPath, name: 'result.txt' }]
    })

    await expect(repository.syncSession(duplicateSession)).resolves.toEqual(['artifact'])

    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 2,
      artifactCount: 2,
      artifactGroupCount: 2,
      isIndexComplete: true
    })
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'sessionArtifacts', sessionId: 'session-b' },
        limit: 20
      })
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ sourceFileId: 'artifact-b' })],
      totalCount: 1
    })

    await repository.softDeleteSession(PROJECT_ID, SESSION_ID)
    await expect(repository.syncSession(duplicateSession)).resolves.toEqual([])
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 1,
      artifactCount: 1,
      artifactGroupCount: 1,
      isIndexComplete: true
    })
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'sessionArtifacts', sessionId: 'session-b' },
        limit: 20
      })
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ sourceFileId: 'artifact-b' })],
      totalCount: 1
    })
  })

  it('restores a soft-deleted owner without hiding another session logical file', async () => {
    const sharedPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      'legacy-shared',
      'recover.txt'
    )
    await writeManagedFile(sharedPath, 'recover owner')
    const owner = createSession({
      artifacts: [
        { id: 'artifact-owner', kind: 'managed-file', path: sharedPath, name: 'recover.txt' }
      ]
    })
    const claimant = createSession({
      id: 'session-b',
      artifacts: [
        { id: 'artifact-claimant', kind: 'managed-file', path: sharedPath, name: 'recover.txt' }
      ]
    })
    await repository.syncSession(owner)
    await repository.softDeleteSession(PROJECT_ID, SESSION_ID)

    // A complete scan proves the owner JSON survived the interrupted delete. Reconciliation must
    // restore that owner before startup sync order gives another active session a chance to claim it.
    await repository.reconcileActiveSessions([owner, claimant])
    await repository.syncSession(claimant)

    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
        limit: 20
      })
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ sourceFileId: 'artifact-owner' })],
      totalCount: 1
    })
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'sessionArtifacts', sessionId: 'session-b' },
        limit: 20
      })
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ sourceFileId: 'artifact-claimant' })],
      totalCount: 1
    })
  })

  it('skips pending uploads and artifacts during migration', async () => {
    const pendingArtifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      '.pending',
      'result.txt'
    )
    const pendingUploadPath = join(storageRoot, 'uploads', '.pending', 'input.csv')
    await Promise.all([
      writeManagedFile(pendingArtifactPath, 'pending result'),
      writeManagedFile(pendingUploadPath, 'pending upload')
    ])

    await repository.syncSession(
      createSession({
        messages: [
          {
            id: 'message-user',
            role: 'user',
            content: 'Analyze',
            status: 'complete',
            eventIds: [],
            uploads: [
              {
                id: 'upload-pending',
                sessionId: PENDING_UPLOAD_SESSION_ID,
                name: 'input.csv',
                originalName: 'input.csv',
                path: pendingUploadPath,
                size: 14
              }
            ],
            createdAt: 1,
            updatedAt: 2
          }
        ],
        artifacts: [
          {
            id: 'artifact-pending',
            kind: 'managed-file',
            path: pendingArtifactPath,
            name: 'result.txt'
          }
        ]
      })
    )

    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 0,
      isIndexComplete: true
    })
  })

  it('skips absolute paths outside the managed roots', async () => {
    const outsidePath = join(storageRoot, 'outside.txt')
    await writeManagedFile(outsidePath, 'outside')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      await repository.syncSession(
        createSession({
          artifacts: [
            { id: 'artifact-outside', kind: 'managed-file', path: outsidePath, name: 'outside.txt' }
          ]
        })
      )
    } finally {
      warn.mockRestore()
    }

    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 0,
      isIndexComplete: true
    })
  })

  it.skipIf(process.platform === 'win32')(
    'skips a managed-root symlink that resolves outside storage',
    async () => {
      const outsidePath = join(storageRoot, 'outside.txt')
      const linkedPath = join(storageRoot, 'artifacts', 'default-project', 'linked.txt')
      await writeManagedFile(outsidePath, 'outside')
      await mkdir(dirname(linkedPath), { recursive: true })
      await symlink(outsidePath, linkedPath)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

      try {
        await repository.syncSession(
          createSession({
            artifacts: [
              { id: 'artifact-linked', kind: 'managed-file', path: linkedPath, name: 'linked.txt' }
            ]
          })
        )
      } finally {
        warn.mockRestore()
      }

      await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
        totalCount: 0,
        isIndexComplete: true
      })
    }
  )

  it('soft-deletes and restores every file owned by a session', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'result.txt'
    )
    await writeManagedFile(artifactPath, 'result')
    await repository.syncSession(
      createSession({
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: artifactPath,
            name: 'result.txt'
          }
        ]
      })
    )

    const token = await repository.softDeleteSession(PROJECT_ID, SESSION_ID)
    expect((await repository.getOverview(PROJECT_ID)).totalCount).toBe(0)

    await repository.restoreSession(PROJECT_ID, SESSION_ID, token)
    expect((await repository.getOverview(PROJECT_ID)).totalCount).toBe(1)
  })

  it('soft-deletes and restores every indexed session in a project', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'result.txt'
    )
    const uploadSessionId = 'session-upload'
    const uploadPath = join(storageRoot, 'uploads', 'default-project', uploadSessionId, 'input.csv')
    await Promise.all([
      writeManagedFile(artifactPath, 'result'),
      writeManagedFile(uploadPath, 'sample,value')
    ])
    await repository.syncSession(
      createSession({
        artifacts: [
          { id: 'artifact-1', kind: 'managed-file', path: artifactPath, name: 'result.txt' }
        ]
      })
    )
    await repository.syncSession(
      createSession({
        id: uploadSessionId,
        messages: [
          {
            id: 'message-upload',
            role: 'user',
            content: 'Analyze this upload',
            status: 'complete',
            eventIds: [],
            uploads: [
              {
                id: 'upload-1',
                sessionId: uploadSessionId,
                name: 'input.csv',
                originalName: 'input.csv',
                path: uploadPath,
                size: 12
              }
            ],
            createdAt: 1_710_000_000_100,
            updatedAt: 1_710_000_000_200
          }
        ]
      })
    )
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 2,
      uploadCount: 1,
      artifactCount: 1
    })

    const token = await repository.softDeleteProject(PROJECT_ID)
    expect((await repository.getOverview(PROJECT_ID)).totalCount).toBe(0)

    await repository.restoreProject(PROJECT_ID, token)
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 2,
      uploadCount: 1,
      artifactCount: 1
    })
  })

  it('preserves incomplete state when session and project deletion are compensated', async () => {
    const sessionMissingPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'missing-session.txt'
    )
    await repository.syncSession(
      createSession({
        artifacts: [
          {
            id: 'missing-session',
            kind: 'managed-file',
            path: sessionMissingPath,
            name: 'missing-session.txt'
          }
        ]
      })
    )
    expect((await repository.getOverview(PROJECT_ID)).isIndexComplete).toBe(false)

    const sessionToken = await repository.softDeleteSession(PROJECT_ID, SESSION_ID)
    await repository.restoreSession(PROJECT_ID, SESSION_ID, sessionToken)
    expect((await repository.getOverview(PROJECT_ID)).isIndexComplete).toBe(false)

    const projectSessionId = 'session-2'
    const projectMissingPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      projectSessionId,
      'message-1',
      'missing-project.txt'
    )
    await repository.syncSession(
      createSession({
        id: projectSessionId,
        artifacts: [
          {
            id: 'missing-project',
            kind: 'managed-file',
            path: projectMissingPath,
            name: 'missing-project.txt'
          }
        ]
      })
    )

    const projectToken = await repository.softDeleteProject(PROJECT_ID)
    await repository.restoreProject(PROJECT_ID, projectToken)
    expect((await repository.getOverview(PROJECT_ID)).isIndexComplete).toBe(false)
  })

  it('does not revive stale file rows when a session deletion is compensated', async () => {
    const oldPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'old.txt'
    )
    const currentPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-2',
      'current.txt'
    )
    await Promise.all([writeManagedFile(oldPath, 'old'), writeManagedFile(currentPath, 'current')])
    await repository.syncSession(
      createSession({
        filesRevision: 1,
        artifacts: [{ id: 'old', kind: 'managed-file', path: oldPath, name: 'old.txt' }]
      })
    )
    await repository.syncSession(
      createSession({
        filesRevision: 2,
        artifacts: [{ id: 'current', kind: 'managed-file', path: currentPath, name: 'current.txt' }]
      })
    )

    const token = await repository.softDeleteSession(PROJECT_ID, SESSION_ID)
    await repository.restoreSession(PROJECT_ID, SESSION_ID, token)

    const files = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
      limit: 24
    })
    expect(files.items.map((file) => file.name)).toEqual(['current.txt'])
  })

  it('keeps an indexed revision as an idempotent no-op until the revision advances', async () => {
    const originalPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'original.txt'
    )
    const replacementPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-2',
      'replacement.txt'
    )
    await Promise.all([
      writeManagedFile(originalPath, 'original'),
      writeManagedFile(replacementPath, 'replacement')
    ])
    const original = createSession({
      filesRevision: 4,
      artifacts: [
        { id: 'original', kind: 'managed-file', path: originalPath, name: 'original.txt' }
      ]
    })
    const replacement = createSession({
      filesRevision: 4,
      artifacts: [
        {
          id: 'replacement',
          kind: 'managed-file',
          path: replacementPath,
          name: 'replacement.txt'
        }
      ]
    })

    await expect(repository.syncSession(original)).resolves.toEqual(['artifact'])
    await expect(repository.syncSession(replacement)).resolves.toEqual([])
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
        limit: 24
      })
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ sourceFileId: 'original', name: 'original.txt' })],
      totalCount: 1
    })

    await expect(repository.syncSession({ ...replacement, filesRevision: 5 })).resolves.toEqual([
      'artifact'
    ])
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
        limit: 24
      })
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ sourceFileId: 'replacement', name: 'replacement.txt' })],
      totalCount: 1
    })
  })

  it('restores session and project deletions only for their matching operation token', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'result.txt'
    )
    await writeManagedFile(artifactPath, 'result')
    await repository.syncSession(
      createSession({
        artifacts: [
          { id: 'artifact-1', kind: 'managed-file', path: artifactPath, name: 'result.txt' }
        ]
      })
    )

    const sessionToken = await repository.softDeleteSession(PROJECT_ID, SESSION_ID)
    await repository.restoreSession(PROJECT_ID, SESSION_ID, 'different-session-operation')
    expect((await repository.getOverview(PROJECT_ID)).totalCount).toBe(0)
    await repository.restoreSession(PROJECT_ID, SESSION_ID, sessionToken)
    await repository.restoreSession(PROJECT_ID, SESSION_ID, sessionToken)
    expect((await repository.getOverview(PROJECT_ID)).totalCount).toBe(1)

    const projectToken = await repository.softDeleteProject(PROJECT_ID)
    await repository.restoreProject(PROJECT_ID, 'different-project-operation')
    expect((await repository.getOverview(PROJECT_ID)).totalCount).toBe(0)
    await repository.restoreProject(PROJECT_ID, projectToken)
    await repository.restoreProject(PROJECT_ID, projectToken)
    expect((await repository.getOverview(PROJECT_ID)).totalCount).toBe(1)
  })

  it('reconciles repeated complete scans without changing the visible projection', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'result.txt'
    )
    await writeManagedFile(artifactPath, 'result')
    const session = createSession({
      artifacts: [
        { id: 'artifact-1', kind: 'managed-file', path: artifactPath, name: 'result.txt' }
      ]
    })
    await repository.syncSession(session)

    await repository.reconcileActiveSessions([session])
    await repository.reconcileActiveSessions([session])
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 1,
      isIndexComplete: true
    })

    await repository.reconcileActiveSessions([])
    await repository.reconcileActiveSessions([])
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 0,
      isIndexComplete: true
    })

    await repository.reconcileActiveSessions([session])
    await repository.reconcileActiveSessions([session])
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 1,
      isIndexComplete: true
    })
  })

  it('reconciles one Project without removing another Project files', async () => {
    const otherProjectId = 'project-b'
    const otherSessionId = 'session-b'
    const projectArtifactPath = join(
      storageRoot,
      'artifacts',
      PROJECT_ID,
      SESSION_ID,
      'message-1',
      'project-a.txt'
    )
    const otherArtifactPath = join(
      storageRoot,
      'artifacts',
      otherProjectId,
      otherSessionId,
      'message-1',
      'project-b.txt'
    )
    await Promise.all([
      writeManagedFile(projectArtifactPath, 'project a'),
      writeManagedFile(otherArtifactPath, 'project b')
    ])
    await repository.syncSession(
      createSession({
        artifacts: [
          {
            id: 'project-a-artifact',
            kind: 'managed-file',
            path: projectArtifactPath,
            name: 'project-a.txt'
          }
        ]
      })
    )
    await repository.syncSession(
      createSession({
        id: otherSessionId,
        projectId: otherProjectId,
        artifacts: [
          {
            id: 'project-b-artifact',
            kind: 'managed-file',
            path: otherArtifactPath,
            name: 'project-b.txt'
          }
        ]
      })
    )

    await repository.reconcileProjectSessions(PROJECT_ID, [])

    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({ totalCount: 0 })
    await expect(repository.getOverview(otherProjectId)).resolves.toMatchObject({ totalCount: 1 })
  })

  it('updates file ordering metadata when an indexed file changes revision', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'result.txt'
    )
    await writeManagedFile(artifactPath, 'result')
    await repository.syncSession(
      createSession({
        filesRevision: 1,
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: artifactPath,
            name: 'result.txt',
            mtimeMs: 100
          }
        ]
      })
    )
    const changedSources = await repository.syncSession(
      createSession({
        filesRevision: 2,
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: artifactPath,
            name: 'result.txt',
            mtimeMs: 900
          }
        ]
      })
    )
    expect(changedSources).toEqual(['artifact'])

    const page = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
      limit: 24
    })
    expect(page.items[0].sortAtMs).toBe(900)
  })

  it('indexes artifacts whose filesystem modification time has fractional milliseconds', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'result.txt'
    )
    await writeManagedFile(artifactPath, 'result')

    await repository.syncSession(
      createSession({
        artifacts: [
          {
            id: 'artifact-1',
            kind: 'managed-file',
            path: artifactPath,
            name: 'result.txt',
            mtimeMs: 1_784_516_769_248.2927
          }
        ]
      })
    )

    const page = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
      limit: 24
    })
    expect(page.items[0].sortAtMs).toBe(1_784_516_769_248)
  })

  it('force rebuilds missing rows even when the revision ledger matches', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'result.txt'
    )
    await writeManagedFile(artifactPath, 'result')
    const session = createSession({
      artifacts: [
        { id: 'artifact-1', kind: 'managed-file', path: artifactPath, name: 'result.txt' }
      ]
    })
    await repository.syncSession(session)
    await client.managedFile.deleteMany({ where: { projectId: PROJECT_ID } })

    await repository.syncSession(session, { force: true })

    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({ totalCount: 1 })
  })

  it('keeps artifact group ordering stable when only uploads change', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'result.txt'
    )
    const uploadPath = join(storageRoot, 'uploads', 'default-project', SESSION_ID, 'input.csv')
    await writeManagedFile(artifactPath, 'result')
    await writeManagedFile(uploadPath, 'a,b')
    const artifact = {
      id: 'artifact-1',
      kind: 'managed-file' as const,
      path: artifactPath,
      name: 'result.txt',
      mtimeMs: 100
    }
    await repository.syncSession(
      createSession({ filesRevision: 1, updatedAt: 200, artifacts: [artifact] })
    )

    const changedSources = await repository.syncSession(
      createSession({
        filesRevision: 2,
        updatedAt: 900,
        artifacts: [artifact],
        messages: [
          {
            id: 'message-user',
            role: 'user',
            content: 'Analyze',
            status: 'complete',
            eventIds: [],
            uploads: [
              {
                id: 'upload-1',
                sessionId: SESSION_ID,
                name: 'input.csv',
                originalName: 'input.csv',
                path: uploadPath,
                size: 3
              }
            ],
            createdAt: 100,
            updatedAt: 900
          }
        ]
      })
    )

    expect(changedSources).toEqual(['upload'])
    await expect(
      client.managedFileSessionSync.findUniqueOrThrow({
        where: { projectId_sessionId: { projectId: PROJECT_ID, sessionId: SESSION_ID } },
        select: { groupSortAtMs: true }
      })
    ).resolves.toEqual({ groupSortAtMs: 200n })
  })

  it('paginates equal-sort files without duplicates and rejects cross-collection cursors', async () => {
    const artifacts = await Promise.all(
      ['a', 'b', 'c'].map(async (id) => {
        const path = join(
          storageRoot,
          'artifacts',
          'default-project',
          SESSION_ID,
          'message-1',
          `${id}.txt`
        )
        await writeManagedFile(path, id)
        return { id, kind: 'managed-file' as const, path, name: `${id}.txt`, mtimeMs: 100 }
      })
    )
    await repository.syncSession(createSession({ artifacts }))

    const first = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
      limit: 2
    })
    const second = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
      cursor: first.nextCursor,
      limit: 2
    })

    expect(first.totalCount).toBe(3)
    expect(first.nextCursor).toBeDefined()
    expect(new Set([...first.items, ...second.items].map((file) => file.id)).size).toBe(3)
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'uploads' },
        cursor: first.nextCursor,
        limit: 2
      })
    ).rejects.toThrow(/cursor.*collection/i)
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'sessionArtifacts', sessionId: 'session-b' },
        cursor: first.nextCursor,
        limit: 2
      })
    ).rejects.toThrow(/cursor.*collection/i)
    await expect(
      repository.listFiles({
        projectId: 'project-b',
        collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
        cursor: first.nextCursor,
        limit: 2
      })
    ).rejects.toThrow(/cursor.*collection/i)
  })

  it('paginates the flat picker collection and binds its cursor to that collection', async () => {
    const artifacts = await Promise.all(
      ['a', 'b', 'c'].map(async (id) => {
        const path = join(
          storageRoot,
          'artifacts',
          'default-project',
          SESSION_ID,
          'message-1',
          `${id}.txt`
        )
        await writeManagedFile(path, id)
        return { id, kind: 'managed-file' as const, path, name: `${id}.txt`, mtimeMs: 100 }
      })
    )
    await repository.syncSession(createSession({ artifacts }))

    const first = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'all' },
      limit: 2
    })
    const second = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'all' },
      cursor: first.nextCursor,
      limit: 2
    })

    expect(first.nextCursor).toBeDefined()
    expect(new Set([...first.items, ...second.items].map((file) => file.id)).size).toBe(3)
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
        cursor: first.nextCursor,
        limit: 2
      })
    ).rejects.toThrow(/cursor.*collection/i)
  })

  it('paginates artifact session groups with a separate cursor', async () => {
    for (const sessionId of ['session-a', 'session-b']) {
      const path = join(
        storageRoot,
        'artifacts',
        'default-project',
        sessionId,
        'message-1',
        'result.txt'
      )
      await writeManagedFile(path, sessionId)
      await repository.syncSession(
        createSession({
          id: sessionId,
          updatedAt: 1_710_000_001_000,
          artifacts: [
            {
              id: `artifact-${sessionId}`,
              kind: 'managed-file',
              path,
              name: 'result.txt'
            }
          ]
        })
      )
    }

    const first = await repository.listArtifactGroups({ projectId: PROJECT_ID, limit: 1 })
    const second = await repository.listArtifactGroups({
      projectId: PROJECT_ID,
      cursor: first.nextCursor,
      limit: 1
    })

    expect(first.totalCount).toBe(2)
    expect(first.nextCursor).toBeDefined()
    expect(new Set([...first.items, ...second.items].map((group) => group.sessionId))).toEqual(
      new Set(['session-a', 'session-b'])
    )
    await expect(
      repository.listArtifactGroups({
        projectId: 'project-b',
        cursor: first.nextCursor,
        limit: 1
      })
    ).rejects.toThrow(/cursor.*collection/i)
  })

  it('loads all search overview counts with one database query', async () => {
    const queryRaw = vi.spyOn(client, '$queryRaw')

    await expect(
      repository.getOverview({
        projectId: PROJECT_ID,
        search: { filenameContains: 'impact' }
      })
    ).resolves.toEqual({
      totalCount: 0,
      uploadCount: 0,
      artifactCount: 0,
      artifactGroupCount: 0,
      isIndexComplete: true
    })
    expect(queryRaw).toHaveBeenCalledTimes(1)
  })

  it('searches filenames across independent collections and binds cursors to the query', async () => {
    const uploadPath = join(
      storageRoot,
      'uploads',
      'default-project',
      SESSION_ID,
      'impact-input.csv'
    )
    const sessionAFiles = [
      ['impact-a', 'Impact_Timeline.csv'],
      ['impact-b', 'impact_notes.txt'],
      ['literal', '%_literal.txt'],
      ['unicode', 'École.txt'],
      ['other', 'summary.txt']
    ] as const
    const sessionBPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      'session-b',
      'message-1',
      'IMPACT_chart.png'
    )
    await Promise.all([
      writeManagedFile(uploadPath, 'a,b'),
      writeManagedFile(sessionBPath, 'chart'),
      ...sessionAFiles.map(([id, name]) =>
        writeManagedFile(
          join(
            storageRoot,
            'artifacts',
            'default-project',
            SESSION_ID,
            'message-1',
            `${id}-${name}`
          ),
          id
        )
      )
    ])
    await repository.syncSession(
      createSession({
        messages: [
          {
            id: 'message-user',
            role: 'user',
            content: 'Analyze',
            status: 'complete',
            eventIds: [],
            uploads: [
              {
                id: 'upload-impact',
                sessionId: SESSION_ID,
                name: 'impact-input.csv',
                originalName: 'Impact_Input.csv',
                path: uploadPath,
                size: 3
              }
            ],
            createdAt: 100,
            updatedAt: 200
          }
        ],
        artifacts: sessionAFiles.map(([id, name]) => ({
          id,
          kind: 'managed-file' as const,
          path: join(
            storageRoot,
            'artifacts',
            'default-project',
            SESSION_ID,
            'message-1',
            `${id}-${name}`
          ),
          name,
          mtimeMs: 100
        }))
      })
    )
    await repository.syncSession(
      createSession({
        id: 'session-b',
        artifacts: [
          {
            id: 'impact-chart',
            kind: 'managed-file',
            path: sessionBPath,
            name: 'IMPACT_chart.png',
            mtimeMs: 100
          }
        ]
      })
    )

    const search = { filenameContains: '  ImPaCt  ' }
    await expect(repository.getOverview({ projectId: PROJECT_ID, search })).resolves.toEqual({
      totalCount: 4,
      uploadCount: 1,
      artifactCount: 3,
      artifactGroupCount: 2,
      isIndexComplete: true
    })
    const allMatches = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'all' },
      search,
      limit: 10
    })
    expect(allMatches.totalCount).toBe(4)
    expect(new Set(allMatches.items.map((file) => file.source))).toEqual(
      new Set(['artifact', 'upload'])
    )
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'uploads' },
        search,
        limit: 10
      })
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ name: 'Impact_Input.csv' })],
      totalCount: 1
    })
    const groups = await repository.listArtifactGroups({
      projectId: PROJECT_ID,
      search,
      limit: 10
    })
    expect(groups.totalCount).toBe(2)
    expect(new Map(groups.items.map((group) => [group.sessionId, group.artifactCount]))).toEqual(
      new Map([
        ['session-a', 2],
        ['session-b', 1]
      ])
    )

    const excludingSessionA = { filenameContains: 'impact', excludedSessionIds: [SESSION_ID] }
    await expect(
      repository.getOverview({ projectId: PROJECT_ID, search: excludingSessionA })
    ).resolves.toEqual({
      totalCount: 1,
      uploadCount: 0,
      artifactCount: 1,
      artifactGroupCount: 1,
      isIndexComplete: true
    })
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'all' },
        search: excludingSessionA,
        limit: 10
      })
    ).resolves.toMatchObject({
      totalCount: 1,
      items: [expect.objectContaining({ name: 'IMPACT_chart.png' })]
    })
    await expect(
      repository.listArtifactGroups({
        projectId: PROJECT_ID,
        search: excludingSessionA,
        limit: 10
      })
    ).resolves.toMatchObject({
      totalCount: 1,
      items: [expect.objectContaining({ sessionId: 'session-b' })]
    })

    const first = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
      search,
      limit: 1
    })
    expect(first.totalCount).toBe(2)
    expect(first.nextCursor).toBeDefined()
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
        search: { filenameContains: 'summary' },
        cursor: first.nextCursor,
        limit: 1
      })
    ).rejects.toThrow(/cursor.*search/i)

    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
        search: { filenameContains: '%_' },
        limit: 10
      })
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ name: '%_literal.txt' })],
      totalCount: 1
    })

    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
        search: { filenameContains: 'école' },
        limit: 10
      })
    ).resolves.toMatchObject({ items: [], totalCount: 0 })
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
        search: { filenameContains: 'ÉCOLE' },
        limit: 10
      })
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ name: 'École.txt' })],
      totalCount: 1
    })

    const groupFirst = await repository.listArtifactGroups({
      projectId: PROJECT_ID,
      search,
      limit: 1
    })
    await expect(
      repository.listArtifactGroups({
        projectId: PROJECT_ID,
        search: { filenameContains: 'summary' },
        cursor: groupFirst.nextCursor,
        limit: 1
      })
    ).rejects.toThrow(/cursor.*search/i)
  })

  it('searches generated artifacts with a primary cursor and bounded other-project results', async () => {
    const primaryFiles = [
      ['sin-old', 'sin-old.png', 100],
      ['sin-new', 'sin-new.png', 300],
      ['sin-mid', 'sin-mid.csv', 200]
    ] as const
    const otherFiles = Array.from({ length: 6 }, (_, index) => ({
      id: `sin-other-${index}`,
      name: `sin-other-${index}.png`,
      path: join(
        storageRoot,
        'artifacts',
        'project-b',
        'session-b',
        'message-1',
        `sin-other-${index}.png`
      ),
      mtimeMs: 400 - index
    }))
    const uploadPath = join(storageRoot, 'uploads', 'default-project', SESSION_ID, 'sin-input.csv')

    await Promise.all([
      ...primaryFiles.map(([id, name]) =>
        writeManagedFile(
          join(
            storageRoot,
            'artifacts',
            'default-project',
            SESSION_ID,
            'message-1',
            `${id}-${name}`
          ),
          id
        )
      ),
      ...otherFiles.map((file) => writeManagedFile(file.path, file.id)),
      writeManagedFile(uploadPath, 'upload')
    ])
    await repository.syncSession(
      createSession({
        messages: [
          {
            id: 'message-user',
            role: 'user',
            content: 'Analyze',
            status: 'complete',
            eventIds: [],
            uploads: [
              {
                id: 'sin-upload',
                sessionId: SESSION_ID,
                name: 'sin-input.csv',
                originalName: 'sin-input.csv',
                path: uploadPath,
                size: 6
              }
            ],
            createdAt: 50,
            updatedAt: 50
          }
        ],
        artifacts: primaryFiles.map(([id, name, mtimeMs]) => ({
          id,
          kind: 'managed-file' as const,
          path: join(
            storageRoot,
            'artifacts',
            'default-project',
            SESSION_ID,
            'message-1',
            `${id}-${name}`
          ),
          name,
          mtimeMs
        }))
      })
    )
    await repository.syncSession(
      createSession({
        id: 'session-b',
        projectId: 'project-b',
        artifacts: otherFiles.map((file) => ({
          id: file.id,
          kind: 'managed-file' as const,
          path: file.path,
          name: file.name,
          mtimeMs: file.mtimeMs
        }))
      })
    )

    const first = await repository.searchArtifacts({
      primaryProjectId: PROJECT_ID,
      otherProjectIds: ['project-b'],
      filenameContains: 'SIN',
      primaryLimit: 2,
      otherLimit: 5
    })

    expect(first.primary).toMatchObject({
      totalCount: 3,
      items: [
        expect.objectContaining({ name: 'sin-new.png', source: 'artifact' }),
        expect.objectContaining({ name: 'sin-mid.csv', source: 'artifact' })
      ]
    })
    expect(first.primary.nextCursor).toBeDefined()
    expect(first.other.map((item) => item.name)).toEqual(
      otherFiles.slice(0, 5).map((file) => file.name)
    )
    expect(first.isIndexComplete).toBe(true)

    await expect(
      repository.searchArtifacts({
        primaryProjectId: 'project-b',
        otherProjectIds: [],
        filenameContains: 'SIN',
        primaryLimit: 2,
        primaryCursor: first.primary.nextCursor,
        otherLimit: 0
      })
    ).rejects.toThrow(/cursor.*global artifact search/i)

    await expect(
      repository.searchArtifacts({
        primaryProjectId: PROJECT_ID,
        otherProjectIds: ['project-b'],
        primaryLimit: 2,
        otherLimit: 6
      } as never)
    ).rejects.toThrow('otherLimit must be between 0 and 5')

    await expect(
      repository.searchArtifacts({
        primaryProjectId: PROJECT_ID,
        otherProjectIds: ['project-b'],
        filenameContains: 'sin',
        primaryLimit: 2,
        primaryCursor: first.primary.nextCursor,
        otherLimit: 0
      })
    ).resolves.toMatchObject({
      primary: {
        totalCount: 3,
        items: [expect.objectContaining({ name: 'sin-old.png' })],
        nextCursor: undefined
      },
      other: []
    })

    await expect(
      repository.searchArtifacts({
        primaryProjectId: PROJECT_ID,
        otherProjectIds: ['project-b'],
        filenameContains: 'sin',
        excludedSessionIds: [SESSION_ID],
        primaryLimit: 2,
        otherLimit: 5
      })
    ).resolves.toMatchObject({
      primary: { totalCount: 0, items: [], nextCursor: undefined },
      other: otherFiles.slice(0, 5).map((file) => expect.objectContaining({ name: file.name }))
    })
  })

  it('indexes readable files while retrying an unreadable file from the same session', async () => {
    const uploadPath = join(storageRoot, 'uploads', 'default-project', SESSION_ID, 'input.csv')
    const missingArtifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'later.txt'
    )
    await writeManagedFile(uploadPath, 'a,b')
    const session = createSession({
      messages: [
        {
          id: 'message-user',
          role: 'user',
          content: 'Analyze',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: 'upload-1',
              sessionId: SESSION_ID,
              name: 'input.csv',
              originalName: 'input.csv',
              path: uploadPath,
              size: 3
            }
          ],
          createdAt: 100,
          updatedAt: 200
        }
      ],
      artifacts: [
        {
          id: 'artifact-later',
          kind: 'managed-file',
          path: missingArtifactPath,
          name: 'later.txt'
        }
      ]
    })

    await expect(repository.syncSession(session)).resolves.toEqual(['upload'])
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 1,
      uploadCount: 1,
      artifactCount: 0,
      isIndexComplete: false
    })

    await writeManagedFile(missingArtifactPath, 'ready')
    await expect(repository.syncSession(session)).resolves.toEqual(['artifact'])
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 2,
      uploadCount: 1,
      artifactCount: 1,
      isIndexComplete: true
    })
  })

  it('reports incomplete until a missing file can be indexed', async () => {
    const missingPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'later.txt'
    )
    const session = createSession({
      artifacts: [
        { id: 'artifact-later', kind: 'managed-file', path: missingPath, name: 'later.txt' }
      ]
    })

    await expect(repository.syncSession(session)).resolves.toEqual([])
    expect((await repository.getOverview(PROJECT_ID)).isIndexComplete).toBe(false)
    expect((await repository.getOverview(PROJECT_ID)).totalCount).toBe(0)

    await writeManagedFile(missingPath, 'ready')
    await repository.syncSession(session)
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 1,
      isIndexComplete: true
    })
  })

  it('reports incomplete when index access fails before the revision fast-path', async () => {
    let shouldFail = true
    const recoveringRepository = new ManagedFileIndexRepository(
      async () => {
        if (shouldFail) throw new Error('database unavailable')
        return client
      },
      storageRoot,
      new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client)
      }),
      uploadRepository
    )
    const session = createSession()

    await expect(recoveringRepository.syncSession(session)).rejects.toThrow('database unavailable')
    shouldFail = false

    await expect(recoveringRepository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      isIndexComplete: false
    })
  })

  it('soft-deletes indexed sessions that are absent from a complete startup scan', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'result.txt'
    )
    await writeManagedFile(artifactPath, 'result')
    await repository.syncSession(
      createSession({
        artifacts: [
          { id: 'artifact-1', kind: 'managed-file', path: artifactPath, name: 'result.txt' }
        ]
      })
    )

    await repository.reconcileActiveSessions([])

    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({ totalCount: 0 })
  })

  it('hides native Artifact Versions with a deleted origin Session and restores the same head', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'result.txt'
    )
    await writeManagedFile(artifactPath, 'result')
    await repository.syncSession(
      createSession({
        title: 'Retained analysis',
        artifacts: [
          {
            id: 'artifact-version-1',
            artifactId: 'artifact-lineage-1',
            versionId: 'artifact-version-1',
            versionNumber: 1,
            kind: 'managed-file',
            path: artifactPath,
            name: 'result.txt',
            sha256: 'a'.repeat(64)
          }
        ]
      })
    )
    await client.fileOriginSession.create({
      data: {
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        titleSnapshot: 'Retained analysis',
        state: 'deleted',
        deletedAt: new Date('2026-07-27T12:00:00.000Z')
      }
    })
    await client.artifactLineage.create({
      data: {
        id: 'artifact-lineage-1',
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        normalizedFilename: 'result.txt',
        filename: 'result.txt'
      }
    })
    await client.artifactVersion.create({
      data: {
        id: 'artifact-version-1',
        artifactId: 'artifact-lineage-1',
        versionNumber: 1,
        filename: 'result.txt',
        artifactRunId: 'artifact-run-1',
        writeOperationId: 'write-1',
        writeRequestChecksum: 'b'.repeat(64),
        rootFrameId: 'root-frame-1',
        agentFrameId: 'agent-frame-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-segment-1',
        promptMessageId: 'prompt-1',
        messageId: 'message-1',
        state: 'finalized',
        managedVisibleAt: new Date('2026-07-27T11:59:59.000Z'),
        contentStorageKey: storageKey(storageRoot, artifactPath),
        evidenceStorageKey:
          'artifacts/project-a/session-a/.provenance/artifact-lineage-1/versions/artifact-version-1/evidence.json',
        evidenceSchemaVersion: 1,
        contentType: 'text/plain',
        sizeBytes: 6n,
        checksum: 'a'.repeat(64),
        evidenceJson: '{"schema_version":1}',
        evidenceChecksum: 'c'.repeat(64)
      }
    })
    await client.artifactLineage.update({
      where: { id: 'artifact-lineage-1' },
      data: { currentVersionId: 'artifact-version-1' }
    })
    // Session JSON is gone and the derived row is accidentally lost. SQLite Version authority must
    // be sufficient to recreate Project Files without reconstructing identity from a filename/path.
    await client.managedFile.deleteMany({ where: { projectId: PROJECT_ID } })

    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
        limit: 20
      })
    ).resolves.toMatchObject({ items: [], totalCount: 0 })
    await expect(
      repository.searchArtifacts({
        primaryProjectId: PROJECT_ID,
        otherProjectIds: [],
        filenameContains: 'result',
        primaryLimit: 10,
        otherLimit: 0
      })
    ).resolves.toMatchObject({ primary: { items: [], totalCount: 0 } })
    await expect(
      repository.listArtifactGroups({ projectId: PROJECT_ID, limit: 20 })
    ).resolves.toMatchObject({ items: [], totalCount: 0 })

    await repository.reconcileActiveSessions([])

    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 0,
      artifactCount: 0,
      artifactGroupCount: 0
    })
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
        limit: 20
      })
    ).resolves.toMatchObject({ items: [], totalCount: 0 })

    await client.fileOriginSession.update({
      where: { projectId_sessionId: { projectId: PROJECT_ID, sessionId: SESSION_ID } },
      data: { state: 'active', deletedAt: null, deletionOperationId: null }
    })

    await expect(
      client.artifactLineage.findUniqueOrThrow({ where: { id: 'artifact-lineage-1' } })
    ).resolves.toMatchObject({ currentVersionId: 'artifact-version-1' })
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
        limit: 20
      })
    ).resolves.toMatchObject({
      items: [
        {
          sourceFileId: 'artifact-lineage-1',
          sourceVersionId: 'artifact-version-1',
          checksum: 'a'.repeat(64)
        }
      ],
      totalCount: 1
    })
  })

  it.each(['unrelated project', 'recovered project'] as const)(
    'keeps the %s complete after a Project-scoped reconciliation failure',
    async (scenario) => {
      const getClient = vi.fn().mockResolvedValue(client)
      const recoveringRepository = new ManagedFileIndexRepository(
        getClient,
        storageRoot,
        new ManagedFileVersionService({ storageRoot, getClient: () => Promise.resolve(client) }),
        uploadRepository
      )
      await recoveringRepository.reconcileActiveSessions([])
      getClient.mockRejectedValueOnce(new Error('database busy'))

      await expect(recoveringRepository.reconcileProjectSessions(PROJECT_ID, [])).rejects.toThrow(
        'database busy'
      )
      await expect(recoveringRepository.getOverview(PROJECT_ID)).resolves.toMatchObject({
        isIndexComplete: false
      })
      if (scenario === 'recovered project') {
        await recoveringRepository.reconcileProjectSessions(PROJECT_ID, [])
      }
      await expect(
        recoveringRepository.getOverview(
          scenario === 'unrelated project' ? 'project-b' : PROJECT_ID
        )
      ).resolves.toMatchObject({ isIndexComplete: true })
    }
  )

  it('keeps a known retained-origin failure scoped during a global reconciliation', async () => {
    await client.fileOriginSession.create({
      data: {
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        state: 'deleted',
        deletedAt: new Date()
      }
    })
    vi.spyOn(client.artifactLineage, 'findMany').mockRejectedValueOnce(
      new Error('retained projection busy')
    )
    await expect(repository.reconcileActiveSessions([])).rejects.toThrow()
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      isIndexComplete: false
    })
    await expect(repository.getOverview('project-b')).resolves.toMatchObject({
      isIndexComplete: true
    })
  })

  it('does not clear global uncertainty when only one Project is reconciled', async () => {
    repository.markReconciliationIncomplete()
    await repository.reconcileProjectSessions(PROJECT_ID, [])
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      isIndexComplete: false
    })
    await repository.reconcileActiveSessions([])
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      isIndexComplete: true
    })
  })

  it('reports an incomplete index until failed startup reconciliation succeeds', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'result.txt'
    )
    await writeManagedFile(artifactPath, 'result')
    await repository.syncSession(
      createSession({
        artifacts: [
          { id: 'artifact-1', kind: 'managed-file', path: artifactPath, name: 'result.txt' }
        ]
      })
    )
    let shouldFail = true
    const recoveringRepository = new ManagedFileIndexRepository(
      async () => {
        if (shouldFail) {
          shouldFail = false
          throw new Error('database busy')
        }
        return client
      },
      storageRoot,
      new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client)
      }),
      uploadRepository
    )

    await expect(recoveringRepository.reconcileActiveSessions([])).rejects.toThrow('database busy')
    await expect(recoveringRepository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 1,
      isIndexComplete: false
    })

    await recoveringRepository.reconcileActiveSessions([])
    await expect(recoveringRepository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      totalCount: 0,
      isIndexComplete: true
    })
  })

  it('clears an incomplete session after a complete scan confirms its JSON is gone', async () => {
    const missingPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'missing.txt'
    )
    await expect(
      repository.syncSession(
        createSession({
          artifacts: [
            { id: 'artifact-missing', kind: 'managed-file', path: missingPath, name: 'missing.txt' }
          ]
        })
      )
    ).resolves.toEqual([])
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      isIndexComplete: false
    })

    await repository.reconcileActiveSessions([])

    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      isIndexComplete: true
    })
  })

  it('clears an incomplete session after a Project-scoped scan confirms its JSON is gone', async () => {
    const missingPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'missing.txt'
    )
    await expect(
      repository.syncSession(
        createSession({
          artifacts: [
            { id: 'artifact-missing', kind: 'managed-file', path: missingPath, name: 'missing.txt' }
          ]
        })
      )
    ).resolves.toEqual([])
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      isIndexComplete: false
    })

    await repository.reconcileProjectSessions(PROJECT_ID, [])

    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      isIndexComplete: true
    })
  })

  it('canonicalizes duplicate legacy ids that point at the same storage path', async () => {
    const artifactPath = join(
      storageRoot,
      'artifacts',
      'default-project',
      SESSION_ID,
      'message-1',
      'duplicate.txt'
    )
    await writeManagedFile(artifactPath, 'one file')
    const artifacts = [
      { id: 'legacy-a', kind: 'managed-file' as const, path: artifactPath, name: 'duplicate.txt' },
      { id: 'legacy-b', kind: 'managed-file' as const, path: artifactPath, name: 'duplicate.txt' }
    ]

    await repository.syncSession(
      createSession({
        artifacts
      })
    )

    const uploadPath = join(storageRoot, 'uploads', 'default-project', SESSION_ID, 'input.csv')
    await writeManagedFile(uploadPath, 'a,b')
    const changedSources = await repository.syncSession(
      createSession({
        filesRevision: 2,
        artifacts,
        messages: [
          {
            id: 'message-user',
            role: 'user',
            content: 'Analyze',
            status: 'complete',
            eventIds: [],
            uploads: [
              {
                id: 'upload-1',
                sessionId: SESSION_ID,
                name: 'input.csv',
                originalName: 'input.csv',
                path: uploadPath,
                size: 3
              }
            ],
            createdAt: 100,
            updatedAt: 200
          }
        ]
      })
    )
    expect(changedSources).toEqual(['upload'])

    const page = await repository.listFiles({
      projectId: PROJECT_ID,
      collection: { kind: 'sessionArtifacts', sessionId: SESSION_ID },
      limit: 24
    })
    expect(page.items).toHaveLength(1)
    expect(page.items[0].sourceFileId).toBe('legacy-a')
    await expect(repository.getOverview(PROJECT_ID)).resolves.toMatchObject({
      artifactCount: 1,
      isIndexComplete: true
    })
  })

  it('rejects an empty session scope instead of returning every project artifact', async () => {
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'sessionArtifacts', sessionId: '' },
        limit: 24
      })
    ).rejects.toThrow(/sessionId.*required/)
  })

  it('rejects an unknown collection kind at the runtime boundary', async () => {
    await expect(
      repository.listFiles({
        projectId: PROJECT_ID,
        collection: { kind: 'bogus' }
      } as unknown as Parameters<ManagedFileIndexRepository['listFiles']>[0])
    ).rejects.toThrow(/collection.*invalid/)
  })
})

const writeManagedFile = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}
