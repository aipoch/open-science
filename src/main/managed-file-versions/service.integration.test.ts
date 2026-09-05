import { createHash } from 'node:crypto'
import { renameSync, symlinkSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  open as openFile,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { MANAGED_TEXT_EDIT_MAX_BYTES } from '../../shared/managed-file-versions'
import { ManagedFileVersionError, ManagedFileVersionService } from './service'
import { NodeVersionFileOperator, VersionFileOperatorError } from './version-file-operator'

const checksum = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
type SourceFixture = {
  source: 'artifact' | 'upload'
  fileId: string
  versionIds: [string, string]
}

describe('ManagedFileVersionService (SQLite + filesystem)', () => {
  let storageRoot: string
  let outsideRoot: string | undefined
  let client: PrismaClient

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-managed-version-'))
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    await client.project.create({ data: { id: 'project-1', name: 'Project one' } })
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
  })

  afterEach(async () => {
    await client.$disconnect()
    await rm(storageRoot, { recursive: true, force: true })
    if (outsideRoot) await rm(outsideRoot, { recursive: true, force: true })
    outsideRoot = undefined
  })

  const createFixture = async (source: 'artifact' | 'upload'): Promise<SourceFixture> => {
    const fileId = `${source}-file-1`
    const versionIds: [string, string] = [`${source}-v1`, `${source}-v2`]
    const first = Buffer.from('\ufefffirst\r\nline\r\n')
    const second = Buffer.from('second\n')
    const storageKeys = versionIds.map(
      (versionId) => `${source}s/project-1/session-1/${fileId}/versions/${versionId}/content`
    )
    for (const [index, storageKey] of storageKeys.entries()) {
      const path = join(storageRoot, ...storageKey.split('/'))
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, index === 0 ? first : second)
    }

    if (source === 'artifact') {
      await client.artifactLineage.create({
        data: {
          id: fileId,
          projectId: 'project-1',
          sessionId: 'session-1',
          normalizedFilename: 'readme.md',
          filename: 'README.md'
        }
      })
      await client.artifactVersion.createMany({
        data: versionIds.map((id, index) => ({
          id,
          artifactId: fileId,
          versionNumber: index + 1,
          filename: 'README.md',
          originKind: 'legacy',
          basedOnVersionId: index === 0 ? null : versionIds[0],
          state: 'finalized',
          contentStorageKey: storageKeys[index]!,
          contentType: 'text/markdown',
          sizeBytes: BigInt(index === 0 ? first.byteLength : second.byteLength),
          checksum: checksum(index === 0 ? first : second)
        }))
      })
      await client.artifactLineage.update({
        where: { id: fileId },
        data: { currentVersionId: versionIds[1] }
      })
    } else {
      await client.uploadFile.create({
        data: {
          id: fileId,
          projectId: 'project-1',
          sessionId: 'session-1',
          filename: 'README.md',
          originalFilename: 'README.md'
        }
      })
      await client.uploadVersion.createMany({
        data: versionIds.map((id, index) => ({
          id,
          uploadFileId: fileId,
          versionNumber: index + 1,
          state: 'ready',
          originKind: 'legacy',
          basedOnVersionId: index === 0 ? null : versionIds[0],
          contentStorageKey: storageKeys[index]!,
          filename: 'README.md',
          originalFilename: 'README.md',
          contentType: 'text/markdown',
          sizeBytes: BigInt(index === 0 ? first.byteLength : second.byteLength),
          checksum: checksum(index === 0 ? first : second),
          createdAt: new Date(`2026-08-0${index + 1}T00:00:00.000Z`)
        }))
      })
      await client.uploadFile.update({
        where: { id: fileId },
        data: { currentVersionId: versionIds[1] }
      })
    }

    // Deliberately stale: default resolution must use the logical file head, not this projection.
    await client.managedFile.create({
      data: {
        source,
        sourceFileId: fileId,
        sourceVersionId: versionIds[0],
        checksum: checksum(first),
        projectId: 'project-1',
        sessionId: 'session-1',
        displayName: 'README.md',
        storageKey: storageKeys[0]!,
        mimeType: 'text/markdown',
        sizeBytes: BigInt(first.byteLength),
        mtimeMs: BigInt(1),
        sortAtMs: BigInt(1)
      }
    })
    return { source, fileId, versionIds }
  }

  it.each(['artifact', 'upload'] as const)(
    'bounds the initial %s history response for a frequently edited file',
    async (source) => {
      const fixture = await createFixture(source)
      const totalVersions = 202
      const numbers = Array.from({ length: totalVersions - 2 }, (_, index) => index + 3)
      const latestId = `${source}-v${totalVersions}`
      const key = (number: number): string =>
        `${source}s/project-1/session-1/${fixture.fileId}/versions/${source}-v${number}/content`
      if (source === 'artifact') {
        const template = await client.artifactVersion.findUniqueOrThrow({
          where: { id: fixture.versionIds[1] }
        })
        await client.artifactVersion.createMany({
          data: numbers.map((versionNumber) => ({
            ...template,
            id: `${source}-v${versionNumber}`,
            versionNumber,
            basedOnVersionId: `${source}-v${versionNumber - 1}`,
            contentStorageKey: key(versionNumber)
          }))
        })
        await client.artifactLineage.update({
          where: { id: fixture.fileId },
          data: { currentVersionId: latestId }
        })
      } else {
        const template = await client.uploadVersion.findUniqueOrThrow({
          where: { id: fixture.versionIds[1] }
        })
        await client.uploadVersion.createMany({
          data: numbers.map((versionNumber) => ({
            ...template,
            id: `${source}-v${versionNumber}`,
            versionNumber,
            basedOnVersionId: `${source}-v${versionNumber - 1}`,
            contentStorageKey: key(versionNumber)
          }))
        })
        await client.uploadFile.update({
          where: { id: fixture.fileId },
          data: { currentVersionId: latestId }
        })
      }
      // Only the selected head is read; older immutable content is not needed to list metadata.
      const latestPath = join(storageRoot, ...key(totalVersions).split('/'))
      await mkdir(dirname(latestPath), { recursive: true })
      await writeFile(latestPath, 'second\n')
      const service = new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client)
      })
      const result = await service.inspect({
        source,
        projectId: 'project-1',
        fileId: fixture.fileId
      })
      expect(result.selectedVersionId).toBe(latestId)
      expect(result.text).toBe('second\n')
      expect(result.versions.some((version) => version.id === latestId)).toBe(true)
      expect(result.versions).toHaveLength(50)
      const versionIds = result.versions.map((version) => version.id)
      let cursor = result.nextCursor
      while (cursor) {
        const page = await service.inspect({
          source,
          projectId: 'project-1',
          fileId: fixture.fileId,
          versionId: fixture.versionIds[0],
          cursor
        })
        expect(page.versions.length).toBeLessThanOrEqual(50)
        expect(page.selectedVersion?.id).toBe(fixture.versionIds[0])
        expect(page.headVersion?.id).toBe(latestId)
        expect(page.nextVersion?.id).toBe(fixture.versionIds[1])
        expect(page.previousVersion).toBeUndefined()
        versionIds.push(...page.versions.map((version) => version.id))
        cursor = page.nextCursor
      }
      expect(versionIds).toHaveLength(totalVersions)
      expect(new Set(versionIds).size).toBe(totalVersions)
      await expect(
        service.inspect({
          source,
          projectId: 'project-1',
          fileId: fixture.fileId,
          cursor: 'invalid'
        })
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
  )

  it.each(['artifact', 'upload'] as const)(
    'resolves the %s DB head by default and an explicit owned historical version exactly',
    async (source) => {
      const fixture = await createFixture(source)
      const service = new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client)
      })

      const head = await service.inspect({
        source,
        projectId: 'project-1',
        fileId: fixture.fileId
      })
      expect(head).toMatchObject({
        displayName: 'README.md',
        headVersionId: fixture.versionIds[1],
        selectedVersionId: fixture.versionIds[1],
        text: 'second\n',
        canEdit: true,
        canDiff: true
      })
      expect(head.versions.map((version) => version.id)).toEqual(fixture.versionIds)

      const historical = await service.inspect({
        source,
        projectId: 'project-1',
        fileId: fixture.fileId,
        versionId: fixture.versionIds[0]
      })
      expect(historical).toMatchObject({
        headVersionId: fixture.versionIds[1],
        selectedVersionId: fixture.versionIds[0],
        text: 'first\r\nline\r\n',
        textFormat: { hasUtf8Bom: true, newline: 'crlf', hasTrailingNewline: true },
        canDiff: false
      })

      await expect(
        service.openVersion(
          { source, projectId: 'project-1', fileId: fixture.fileId },
          `${source}-other-version`
        )
      ).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' })
    }
  )

  it.each(['artifact', 'upload'] as const)(
    'separates latest, explicit historical, and based-on diff reads for %s files',
    async (source) => {
      const fixture = await createFixture(source)
      const service = new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client)
      })
      const identity = {
        source,
        projectId: 'project-1',
        fileId: fixture.fileId
      }

      const latest = await service.openLatest(identity)
      try {
        await expect(latest.readRange(0, latest.size)).resolves.toEqual(
          new Uint8Array(Buffer.from('second\n'))
        )
        expect(latest.version.id).toBe(fixture.versionIds[1])
      } finally {
        await latest.close()
      }

      const historical = await service.openVersion(identity, fixture.versionIds[0])
      try {
        await expect(historical.readRange(0, historical.size)).resolves.toEqual(
          new Uint8Array(Buffer.from('\ufefffirst\r\nline\r\n'))
        )
        expect(historical.version.id).toBe(fixture.versionIds[0])
      } finally {
        await historical.close()
      }

      await expect(
        service.diffVersion(identity, fixture.versionIds[1], `${source}-explicit-diff`)
      ).resolves.toMatchObject({
        baseVersionId: fixture.versionIds[0],
        selectedVersionId: fixture.versionIds[1]
      })
    }
  )

  it.each(['artifact', 'upload'] as const)(
    'hides latest and historical %s versions while the logical file is soft-deleted',
    async (source) => {
      const fixture = await createFixture(source)
      const service = new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client)
      })
      const identity = {
        source,
        projectId: 'project-1',
        fileId: fixture.fileId
      }
      await client.managedFile.update({
        where: {
          projectId_source_sourceFileId: {
            projectId: 'project-1',
            source,
            sourceFileId: fixture.fileId
          }
        },
        data: { deletedAt: new Date('2026-08-24T00:00:00.000Z'), deleteOperationId: 'delete-1' }
      })

      await expect(service.openLatest(identity)).rejects.toMatchObject({ code: 'FILE_DELETED' })
      await expect(service.openVersion(identity, fixture.versionIds[0])).rejects.toMatchObject({
        code: 'FILE_DELETED'
      })
      await expect(
        service.diffVersion(identity, fixture.versionIds[1], `${source}-deleted-diff`)
      ).rejects.toMatchObject({ code: 'FILE_DELETED' })
    }
  )

  it.each(['artifact', 'upload'] as const)(
    'keeps all %s history readable but immutable after its Session is deleted',
    async (source) => {
      const fixture = await createFixture(source)
      const service = new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client)
      })
      const identity = {
        source,
        projectId: 'project-1',
        fileId: fixture.fileId
      }
      const readCurrentVersionId = async (): Promise<string | null> =>
        source === 'artifact'
          ? (
              await client.artifactLineage.findUniqueOrThrow({
                where: { id: fixture.fileId },
                select: { currentVersionId: true }
              })
            ).currentVersionId
          : (
              await client.uploadFile.findUniqueOrThrow({
                where: { id: fixture.fileId },
                select: { currentVersionId: true }
              })
            ).currentVersionId
      await client.fileOriginSession.update({
        where: { projectId_sessionId: { projectId: 'project-1', sessionId: 'session-1' } },
        data: {
          state: 'deleted',
          deletedAt: new Date('2026-08-24T00:00:00.000Z'),
          deletionOperationId: null
        }
      })

      const latest = await service.openLatest(identity)
      try {
        await expect(latest.readRange(0, latest.size)).resolves.toEqual(
          new Uint8Array(Buffer.from('second\n'))
        )
        expect(latest.version.id).toBe(fixture.versionIds[1])
      } finally {
        await latest.close()
      }

      const historical = await service.openVersion(identity, fixture.versionIds[0])
      try {
        expect(historical.version.id).toBe(fixture.versionIds[0])
      } finally {
        await historical.close()
      }

      await expect(service.inspect(identity)).resolves.toMatchObject({
        headVersionId: fixture.versionIds[1],
        selectedVersionId: fixture.versionIds[1],
        canEdit: false,
        unavailableReason: 'FILE_DELETED'
      })
      await expect(
        service.saveTextEdit({
          ...identity,
          basedOnVersionId: fixture.versionIds[1],
          expectedHeadVersionId: fixture.versionIds[1],
          content: 'third\n',
          operationId: `${source}-deleted-edit`
        })
      ).rejects.toMatchObject({ code: 'FILE_DELETED' })
      await expect(readCurrentVersionId()).resolves.toBe(fixture.versionIds[1])
    }
  )

  it('uses the Node version file operator when native managed-file support is unavailable', async () => {
    const fixture = await createFixture('artifact')
    const versionFileOperator = new NodeVersionFileOperator({ storageRoot })
    const operationId = 'node-version-operation'
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      versionFileOperator
    })

    const inspected = await service.inspect({
      source: 'artifact',
      projectId: 'project-1',
      fileId: fixture.fileId
    })
    expect(inspected).toMatchObject({
      canEdit: true,
      text: 'second\n',
      selectedVersionId: fixture.versionIds[1]
    })

    const result = await service.saveTextEdit({
      source: 'artifact',
      projectId: 'project-1',
      fileId: fixture.fileId,
      basedOnVersionId: fixture.versionIds[1],
      expectedHeadVersionId: fixture.versionIds[1],
      operationId,
      content: 'third\n'
    })
    expect(result.kind).toBe('created')

    const expectedPlan = versionFileOperator.planImmutable({
      operationId,
      scope: {
        source: 'artifact',
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: fixture.fileId
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    })
    const operation = await client.managedFileVersionWriteOperation.findUniqueOrThrow({
      where: { operationId }
    })
    expect(operation.contentStorageKey).toBe(expectedPlan.storageRef)
    expect(operation.storedFilename).toBe(expectedPlan.storedFilename)
  })

  it('creates a Node version file operator by default without a platform capability gate', async () => {
    const fixture = await createFixture('upload')
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })

    await expect(
      service.inspect({
        source: 'upload',
        projectId: 'project-1',
        fileId: fixture.fileId
      })
    ).resolves.toMatchObject({ canEdit: true, text: 'second\n' })
  })

  it('adopts a legacy Artifact as one immutable v1 and replays the same operation', async () => {
    const content = Buffer.from('legacy artifact bytes\n')
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      createId: vi.fn().mockReturnValueOnce('legacy-artifact-version-1')
    })
    const request = {
      projectId: 'project-1',
      sessionId: 'session-1',
      sourceFileId: 'legacy-artifact-1',
      logicalFilename: 'legacy.md',
      content,
      contentType: 'text/markdown',
      messageId: 'message-1'
    }

    const first = await service.adoptLegacyArtifact(request)
    const replay = await service.adoptLegacyArtifact(request)

    expect(replay).toEqual(first)
    expect(first).toMatchObject({
      fileId: 'legacy-artifact-1',
      versionId: 'legacy-artifact-version-1',
      versionNumber: 1,
      checksum: checksum(content),
      sizeBytes: content.byteLength
    })
    expect(first.storageRef).toMatch(
      /^artifacts\/project-1\/session-1\/legacy-artifact-1\/managed-versions\/v[a-z0-9]{8}_legacy\.md$/u
    )
    await expect(
      client.artifactLineage.findUniqueOrThrow({ where: { id: first.fileId } })
    ).resolves.toMatchObject({ currentVersionId: first.versionId })
    await expect(
      client.artifactVersion.findUniqueOrThrow({ where: { id: first.versionId } })
    ).resolves.toMatchObject({
      artifactId: first.fileId,
      versionNumber: 1,
      state: 'finalized',
      originKind: 'legacy',
      basedOnVersionId: null,
      contentStorageKey: first.storageRef,
      checksum: checksum(content),
      sizeBytes: BigInt(content.byteLength)
    })
    const lease = await service.openLatest({
      source: 'artifact',
      projectId: 'project-1',
      fileId: first.fileId
    })
    try {
      await expect(lease.readRange(0, content.byteLength)).resolves.toEqual(new Uint8Array(content))
    } finally {
      await lease.close()
    }
  })

  it('does not finalize a legacy Artifact after Project deletion begins', async () => {
    const content = Buffer.from('legacy artifact bytes\n')
    const operator = new NodeVersionFileOperator({ storageRoot })
    const publishImmutable = operator.publishImmutable.bind(operator)
    let reportPublished!: () => void
    let allowReturn!: () => void
    const published = new Promise<void>((resolve) => {
      reportPublished = resolve
    })
    const mayReturn = new Promise<void>((resolve) => {
      allowReturn = resolve
    })
    vi.spyOn(operator, 'publishImmutable').mockImplementation(async (input) => {
      const stored = await publishImmutable(input)
      reportPublished()
      await mayReturn
      return stored
    })
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      versionFileOperator: operator,
      createId: () => 'legacy-artifact-deletion-version'
    })

    const adoption = service.adoptLegacyArtifact({
      projectId: 'project-1',
      sessionId: 'session-1',
      sourceFileId: 'legacy-artifact-deletion',
      logicalFilename: 'legacy-deletion.md',
      content,
      contentType: 'text/markdown'
    })
    await published
    await client.projectDeletionIntent.create({ data: { projectId: 'project-1' } })
    allowReturn()

    await expect(adoption).rejects.toMatchObject({ code: 'PROJECT_NOT_WRITABLE' })
    await expect(
      client.artifactLineage.findUniqueOrThrow({
        where: { id: 'legacy-artifact-deletion' }
      })
    ).resolves.toMatchObject({ currentVersionId: null })
    await expect(
      client.artifactVersion.findUniqueOrThrow({
        where: { id: 'legacy-artifact-deletion-version' }
      })
    ).resolves.toMatchObject({ state: 'staging' })
  })

  it.each(['artifact', 'upload'] as const)(
    'keeps the verified %s inode pinned when its storage path is replaced before consumption',
    async (source) => {
      const fixture = await createFixture(source)
      const service = new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client)
      })
      const lease = await service.openLatest({
        source,
        projectId: 'project-1',
        fileId: fixture.fileId
      })
      const replacementPath = `${lease.path}.verified`
      const copiedPath = join(storageRoot, `${source}-downloaded.md`)

      await rename(lease.path, replacementPath)
      await writeFile(lease.path, 'attacker-controlled replacement')

      try {
        await expect(lease.readRange(0, lease.size)).resolves.toEqual(
          new Uint8Array(Buffer.from('second\n'))
        )
        await lease.copyTo(copiedPath)
        await expect(readFile(copiedPath, 'utf8')).resolves.toBe('second\n')
        await expect(readFile(lease.path, 'utf8')).resolves.toBe('attacker-controlled replacement')
      } finally {
        await lease.close()
        await lease.close()
      }
    }
  )

  it.each(['artifact', 'upload'] as const)(
    'diffs the selected %s version against its explicit basedOn version',
    async (source) => {
      const fixture = await createFixture(source)
      const service = new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client)
      })

      await expect(
        service.diffText({
          source,
          projectId: 'project-1',
          fileId: fixture.fileId,
          versionId: fixture.versionIds[1],
          requestId: `${source}-diff`
        })
      ).resolves.toMatchObject({
        baseVersionId: fixture.versionIds[0],
        selectedVersionId: fixture.versionIds[1],
        lines: expect.arrayContaining([
          expect.objectContaining({ kind: 'removed', oldLineNumber: 1 }),
          expect.objectContaining({ kind: 'added', newLineNumber: 1 })
        ])
      })

      await expect(
        service.diffText({
          source,
          projectId: 'project-1',
          fileId: fixture.fileId,
          versionId: fixture.versionIds[0],
          requestId: `${source}-v1-diff`
        })
      ).rejects.toMatchObject({ code: 'DIFF_BASE_NOT_FOUND' })
    }
  )

  it('cancels during asynchronous resolution before starting a diff worker', async () => {
    const fixture = await createFixture('upload')
    let releaseClient!: () => void
    const clientGate = new Promise<void>((resolve) => {
      releaseClient = resolve
    })
    const run = vi.fn()
    const cancel = vi.fn(() => false)
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: async () => {
        await clientGate
        return client
      },
      diffTaskRunner: { run, cancel }
    })

    const pending = service.diffText({
      source: 'upload',
      projectId: 'project-1',
      fileId: fixture.fileId,
      versionId: fixture.versionIds[1],
      requestId: 'cancel-before-worker'
    })
    expect(service.cancelDiff('cancel-before-worker')).toBe(true)
    releaseClient()

    await expect(pending).rejects.toMatchObject({ code: 'DIFF_CANCELLED' })
    expect(run).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })

  it('cancels after a diff worker result is queued but before the service settles', async () => {
    const fixture = await createFixture('upload')
    let signalRunStarted!: () => void
    const runStarted = new Promise<void>((resolve) => {
      signalRunStarted = resolve
    })
    let releaseRun!: () => void
    const run = vi.fn(
      () =>
        new Promise<never[]>((resolve) => {
          releaseRun = () => resolve([])
          signalRunStarted()
        })
    )
    const cancel = vi.fn(() => false)
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      diffTaskRunner: { run, cancel }
    })

    const pending = service.diffText({
      source: 'upload',
      projectId: 'project-1',
      fileId: fixture.fileId,
      versionId: fixture.versionIds[1],
      requestId: 'cancel-after-worker-result'
    })
    await runStarted
    releaseRun()
    expect(service.cancelDiff('cancel-after-worker-result')).toBe(true)

    await expect(pending).rejects.toMatchObject({ code: 'DIFF_CANCELLED' })
    expect(cancel).toHaveBeenCalledWith('cancel-after-worker-result')
  })

  it('fails closed when inspect reaches an anchored reader after a version ancestor is replaced', async () => {
    const fixture = await createFixture('upload')
    outsideRoot = await mkdtemp(join(tmpdir(), 'open-science-managed-version-outside-'))
    const versionsPath = join(
      storageRoot,
      'uploads',
      'project-1',
      'session-1',
      fixture.fileId,
      'versions'
    )
    let readAttempts = 0
    const versionFileOperator = new NodeVersionFileOperator({ storageRoot })
    const openImmutable = versionFileOperator.openImmutable.bind(versionFileOperator)
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      versionFileOperator: Object.assign(versionFileOperator, {
        openImmutable: async (...args: Parameters<typeof openImmutable>) => {
          readAttempts += 1
          renameSync(versionsPath, `${versionsPath}-replaced`)
          symlinkSync(outsideRoot!, versionsPath, process.platform === 'win32' ? 'junction' : 'dir')
          return openImmutable(...args)
        }
      })
    })

    await expect(
      service.inspect({ source: 'upload', projectId: 'project-1', fileId: fixture.fileId })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    expect(readAttempts).toBe(1)
  })

  it('fails closed when save reads its baseline after a version ancestor is replaced', async () => {
    const fixture = await createFixture('upload')
    outsideRoot = await mkdtemp(join(tmpdir(), 'open-science-managed-version-outside-'))
    const versionsPath = join(
      storageRoot,
      'uploads',
      'project-1',
      'session-1',
      fixture.fileId,
      'versions'
    )
    let readAttempts = 0
    const versionFileOperator = new NodeVersionFileOperator({ storageRoot })
    const openImmutable = versionFileOperator.openImmutable.bind(versionFileOperator)
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      versionFileOperator: Object.assign(versionFileOperator, {
        openImmutable: async (...args: Parameters<typeof openImmutable>) => {
          readAttempts += 1
          renameSync(versionsPath, `${versionsPath}-replaced`)
          symlinkSync(outsideRoot!, versionsPath, process.platform === 'win32' ? 'junction' : 'dir')
          return openImmutable(...args)
        }
      })
    })

    await expect(
      service.saveTextEdit({
        source: 'upload',
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        content: 'changed\n',
        operationId: 'anchored-baseline-read'
      })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    expect(readAttempts).toBe(1)
  })

  it('uses anchored metadata to reject a large version without reading its body', async () => {
    const fixture = await createFixture('upload')
    const version = await client.uploadVersion.findUniqueOrThrow({
      where: { id: fixture.versionIds[1] }
    })
    const bytes = Buffer.alloc(MANAGED_TEXT_EDIT_MAX_BYTES + 1, 0x61)
    await writeFile(join(storageRoot, ...version.contentStorageKey.split('/')), bytes)
    await client.uploadVersion.update({
      where: { id: version.id },
      data: { sizeBytes: BigInt(bytes.byteLength), checksum: checksum(bytes) }
    })
    const versionFileOperator = new NodeVersionFileOperator({ storageRoot })
    const openImmutable = vi.fn(versionFileOperator.openImmutable.bind(versionFileOperator))
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      versionFileOperator: Object.assign(versionFileOperator, { openImmutable })
    })

    await expect(
      service.inspect({ source: 'upload', projectId: 'project-1', fileId: fixture.fileId })
    ).resolves.toMatchObject({
      canEdit: false,
      canDiff: false,
      unavailableReason: 'EDIT_LIMIT_EXCEEDED'
    })
    expect(openImmutable).not.toHaveBeenCalled()
  })

  it('maps an atomic bounded-read overflow to EDIT_LIMIT_EXCEEDED', async () => {
    const fixture = await createFixture('upload')
    await client.uploadVersion.update({
      where: { id: fixture.versionIds[1] },
      data: { sizeBytes: BigInt(MANAGED_TEXT_EDIT_MAX_BYTES + 1) }
    })
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })

    await expect(
      service.inspect({ source: 'upload', projectId: 'project-1', fileId: fixture.fileId })
    ).resolves.toMatchObject({
      canEdit: false,
      canDiff: false,
      unavailableReason: 'EDIT_LIMIT_EXCEEDED'
    })
  })

  it('hides durable but not managed-visible agent Artifact versions from list and exact inspect', async () => {
    const fixture = await createFixture('artifact')
    const bytes = Buffer.from('not activated\n')
    const storageKey =
      'artifacts/project-1/session-1/artifact-file-1/versions/artifact-hidden-v3/content'
    const contentPath = join(storageRoot, ...storageKey.split('/'))
    await mkdir(dirname(contentPath), { recursive: true })
    await writeFile(contentPath, bytes)
    await client.artifactVersion.create({
      data: {
        id: 'artifact-hidden-v3',
        artifactId: fixture.fileId,
        versionNumber: 3,
        filename: 'README.md',
        originKind: 'agent_generated',
        artifactRunId: 'compatibility-failed-run',
        rootFrameId: 'root-1',
        agentFrameId: 'agent-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'prompt-1',
        state: 'finalized',
        managedVisibleAt: null,
        contentStorageKey: storageKey,
        evidenceStorageKey: `${storageKey}.evidence`,
        contentType: 'text/markdown',
        sizeBytes: BigInt(bytes.byteLength),
        checksum: checksum(bytes),
        evidenceJson: '{}',
        evidenceChecksum: checksum(Buffer.from('{}')),
        evidenceSchemaVersion: 1
      }
    })
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })

    await expect(
      service.inspect({ source: 'artifact', projectId: 'project-1', fileId: fixture.fileId })
    ).resolves.toMatchObject({
      versions: [
        expect.objectContaining({ id: fixture.versionIds[0] }),
        expect.objectContaining({ id: fixture.versionIds[1] })
      ]
    })
    await expect(
      service.inspect({
        source: 'artifact',
        projectId: 'project-1',
        fileId: fixture.fileId,
        versionId: 'artifact-hidden-v3'
      })
    ).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' })
    await expect(
      service.saveTextEdit({
        source: 'artifact',
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: 'artifact-hidden-v3',
        expectedHeadVersionId: fixture.versionIds[1],
        content: 'must not derive from a hidden version\n',
        operationId: 'hidden-baseline-edit'
      })
    ).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' })
    expect(
      await client.managedFileVersionWriteOperation.count({
        where: { operationId: 'hidden-baseline-edit' }
      })
    ).toBe(0)

    await client.artifactVersion.update({
      where: { id: 'artifact-hidden-v3' },
      data: { managedVisibleAt: new Date('2026-08-13T00:00:00.000Z') }
    })
    await expect(
      service.inspect({
        source: 'artifact',
        projectId: 'project-1',
        fileId: fixture.fileId,
        versionId: 'artifact-hidden-v3'
      })
    ).resolves.toMatchObject({ selectedVersionId: 'artifact-hidden-v3' })
  })

  it('rechecks an Agent edit baseline visibility inside the publication transaction', async () => {
    const fixture = await createFixture('artifact')
    await client.artifactVersion.update({
      where: { id: fixture.versionIds[1] },
      data: {
        originKind: 'agent_generated',
        artifactRunId: 'visible-run',
        rootFrameId: 'root-1',
        agentFrameId: 'agent-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'prompt-1',
        managedVisibleAt: new Date('2026-08-13T00:00:00.000Z'),
        evidenceStorageKey: 'artifacts/project-1/session-1/evidence/v2.json',
        evidenceJson: '{}',
        evidenceChecksum: checksum(Buffer.from('{}')),
        evidenceSchemaVersion: 1
      }
    })
    let hidBaseline = false
    const versionFileOperator = new NodeVersionFileOperator({ storageRoot })
    const publishImmutable = versionFileOperator.publishImmutable.bind(versionFileOperator)
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      createId: () => 'artifact-racing-v3',
      versionFileOperator: Object.assign(versionFileOperator, {
        publishImmutable: async (...args: Parameters<typeof publishImmutable>) => {
          const stored = await publishImmutable(...args)
          if (hidBaseline) return stored
          hidBaseline = true
          await client.artifactVersion.update({
            where: { id: fixture.versionIds[1] },
            data: { managedVisibleAt: null }
          })
          return stored
        }
      })
    })

    await expect(
      service.saveTextEdit({
        source: 'artifact',
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        content: 'must not publish after the base becomes hidden\n',
        operationId: 'visibility-race-operation'
      })
    ).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' })
    await expect(
      client.artifactLineage.findUniqueOrThrow({ where: { id: fixture.fileId } })
    ).resolves.toMatchObject({ currentVersionId: fixture.versionIds[1] })
    expect(await client.artifactVersion.count({ where: { id: 'artifact-racing-v3' } })).toBe(0)
    await expect(
      client.managedFileVersionWriteOperation.findUniqueOrThrow({
        where: { operationId: 'visibility-race-operation' }
      })
    ).resolves.toMatchObject({ state: 'file_ready', resultVersionId: null })
  })

  it.each(['artifact', 'upload'] as const)(
    'saves a %s historical edit as the next immutable head and synchronizes the Files projection',
    async (source) => {
      const fixture = await createFixture(source)
      const versionFileOperator = new NodeVersionFileOperator({ storageRoot })
      const service = new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client),
        createId: () => `${source}-v3`,
        versionFileOperator
      })

      await client.managedFile.update({
        where: {
          projectId_source_sourceFileId: {
            projectId: 'project-1',
            source,
            sourceFileId: fixture.fileId
          }
        },
        data: { messageId: 'message-before-edit' }
      })

      const result = await service.saveTextEdit({
        source,
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[0],
        expectedHeadVersionId: fixture.versionIds[1],
        content: 'changed\nfrom history\n',
        operationId: `${source}-operation-1`
      })

      expect(result).toMatchObject({
        kind: 'created',
        headVersionId: `${source}-v3`,
        version: {
          id: `${source}-v3`,
          versionNumber: 3,
          basedOnVersionId: fixture.versionIds[0],
          originKind: 'user_edit',
          displayName: 'README.md'
        }
      })
      const resolved = await service.openLatest({
        source,
        projectId: 'project-1',
        fileId: fixture.fileId
      })
      try {
        expect(resolved.version.id).toBe(`${source}-v3`)
      } finally {
        await resolved.close()
      }
      const plannedFile = versionFileOperator.planImmutable({
        operationId: `${source}-operation-1`,
        scope: {
          source,
          projectId: 'project-1',
          sessionId: 'session-1',
          logicalFileId: fixture.fileId
        },
        logicalFilename: 'README.md',
        candidateIndex: 0
      })
      expect(resolved.version.storedFilename).toBe(plannedFile.storedFilename)
      expect(await readFile(resolved.path)).toEqual(
        Buffer.from('\ufeffchanged\r\nfrom history\r\n')
      )
      await expect(stat(resolved.path)).resolves.toMatchObject({ size: 26 })

      const projection = await client.managedFile.findUniqueOrThrow({
        where: {
          projectId_source_sourceFileId: {
            projectId: 'project-1',
            source,
            sourceFileId: fixture.fileId
          }
        }
      })
      expect(projection).toMatchObject({
        sourceVersionId: `${source}-v3`,
        storageKey: resolved.version.contentStorageKey,
        checksum: resolved.version.checksum,
        displayName: 'README.md',
        deletedAt: null,
        messageId: null
      })
    }
  )

  it.each(['artifact', 'upload'] as const)(
    'returns a no-op for unchanged %s bytes without creating a journal, file, or version',
    async (source) => {
      const fixture = await createFixture(source)
      const service = new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client)
      })
      const before =
        source === 'artifact'
          ? await client.artifactVersion.count()
          : await client.uploadVersion.count()

      const result = await service.saveTextEdit({
        source,
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[0],
        expectedHeadVersionId: fixture.versionIds[1],
        content: 'first\nline\n',
        operationId: `${source}-noop-operation`
      })

      expect(result).toMatchObject({ kind: 'noop', headVersionId: fixture.versionIds[1] })
      expect(await client.managedFileVersionWriteOperation.count()).toBe(0)
      expect(
        source === 'artifact'
          ? await client.artifactVersion.count()
          : await client.uploadVersion.count()
      ).toBe(before)
    }
  )

  it.each(['artifact', 'upload'] as const)(
    'returns a conflict before staging normalized no-op %s bytes when the expected head is stale',
    async (source) => {
      const fixture = await createFixture(source)
      const service = new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client)
      })
      const versionCountBefore =
        source === 'artifact'
          ? await client.artifactVersion.count({ where: { artifactId: fixture.fileId } })
          : await client.uploadVersion.count({ where: { uploadFileId: fixture.fileId } })

      const result = await service.saveTextEdit({
        source,
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[0],
        expectedHeadVersionId: fixture.versionIds[0],
        // The v1 format restores the BOM and CRLF, so these editor bytes normalize to v1 exactly.
        content: 'first\nline\n',
        operationId: `${source}-stale-noop-operation`
      })

      expect(result).toMatchObject({
        kind: 'conflict',
        expectedHeadVersionId: fixture.versionIds[0],
        actualHead: { id: fixture.versionIds[1], versionNumber: 2 }
      })
      expect(await client.managedFileVersionWriteOperation.count()).toBe(0)
      expect(
        source === 'artifact'
          ? await client.artifactVersion.count({ where: { artifactId: fixture.fileId } })
          : await client.uploadVersion.count({ where: { uploadFileId: fixture.fileId } })
      ).toBe(versionCountBefore)
      await expect(
        readdir(join(storageRoot, `${source}s`, 'project-1', 'session-1', fixture.fileId))
      ).resolves.toEqual(['versions'])
    }
  )

  it.each(['artifact', 'upload'] as const)(
    'linearizes a normalized no-op %s save against a concurrent head advance',
    async (source) => {
      const fixture = await createFixture(source)
      const operator = new NodeVersionFileOperator({ storageRoot })
      const openImmutable = operator.openImmutable.bind(operator)
      let resumeBaseRead!: () => void
      let reportBaseRead!: () => void
      const baseReadPaused = new Promise<void>((resolve) => {
        reportBaseRead = resolve
      })
      const baseReadResume = new Promise<void>((resolve) => {
        resumeBaseRead = resolve
      })
      let shouldPauseBaseRead = true
      vi.spyOn(operator, 'openImmutable').mockImplementation(async (storageRef, integrity) => {
        if (shouldPauseBaseRead && storageRef.endsWith(`/${fixture.versionIds[0]}/content`)) {
          shouldPauseBaseRead = false
          reportBaseRead()
          await baseReadResume
        }
        return openImmutable(storageRef, integrity)
      })
      const service = new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client),
        versionFileOperator: operator
      })

      const staleNoop = service.saveTextEdit({
        source,
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[0],
        expectedHeadVersionId: fixture.versionIds[1],
        content: 'first\nline\n',
        operationId: `${source}-racing-noop-operation`
      })
      await baseReadPaused

      const concurrentSave = await service
        .saveTextEdit({
          source,
          projectId: 'project-1',
          fileId: fixture.fileId,
          basedOnVersionId: fixture.versionIds[1],
          expectedHeadVersionId: fixture.versionIds[1],
          content: 'concurrent change\n',
          operationId: `${source}-concurrent-operation`
        })
        .finally(resumeBaseRead)
      expect(concurrentSave).toMatchObject({ kind: 'created', replayed: false })
      if (concurrentSave.kind !== 'created')
        throw new Error('Expected concurrent Version creation.')

      await expect(staleNoop).resolves.toMatchObject({
        kind: 'conflict',
        expectedHeadVersionId: fixture.versionIds[1],
        actualHead: { id: concurrentSave.version.id, versionNumber: 3 }
      })
      await expect(
        client.managedFileVersionWriteOperation.findMany({
          select: { operationId: true, state: true }
        })
      ).resolves.toEqual([{ operationId: `${source}-concurrent-operation`, state: 'published' }])
      expect(
        source === 'artifact'
          ? await client.artifactVersion.count({ where: { artifactId: fixture.fileId } })
          : await client.uploadVersion.count({ where: { uploadFileId: fixture.fileId } })
      ).toBe(3)
    }
  )

  it.each([
    ['CONTAINS_NUL', 'unsafe\0content'],
    ['EDIT_LIMIT_EXCEEDED', 'x'.repeat(MANAGED_TEXT_EDIT_MAX_BYTES + 1)]
  ] as const)(
    'rejects normalized save bytes with %s before creating a journal',
    async (code, content) => {
      const fixture = await createFixture('upload')
      const service = new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client)
      })

      await expect(
        service.saveTextEdit({
          source: 'upload',
          projectId: 'project-1',
          fileId: fixture.fileId,
          basedOnVersionId: fixture.versionIds[1],
          expectedHeadVersionId: fixture.versionIds[1],
          content,
          operationId: `invalid-output-${code}`
        })
      ).rejects.toMatchObject({ code })
      expect(await client.managedFileVersionWriteOperation.count()).toBe(0)
      expect(await client.uploadVersion.count({ where: { uploadFileId: fixture.fileId } })).toBe(2)
    }
  )

  it('rejects an oversized edit at the service boundary before opening the database', async () => {
    const getClient = vi.fn().mockRejectedValue(new Error('database must not be opened'))
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient
    })

    await expect(
      service.saveTextEdit({
        source: 'upload',
        projectId: 'project-1',
        fileId: 'upload-file-1',
        basedOnVersionId: 'upload-v1',
        expectedHeadVersionId: 'upload-v1',
        content: 'x'.repeat(MANAGED_TEXT_EDIT_MAX_BYTES + 1),
        operationId: 'oversized-before-database'
      })
    ).rejects.toMatchObject({ code: 'EDIT_LIMIT_EXCEEDED' })
    expect(getClient).not.toHaveBeenCalled()
  })

  it('allows only one of two concurrent saves against the same head to publish', async () => {
    const fixture = await createFixture('upload')
    let id = 2
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      createId: () => `upload-v${++id}`
    })
    const base = {
      source: 'upload' as const,
      projectId: 'project-1',
      fileId: fixture.fileId,
      basedOnVersionId: fixture.versionIds[1],
      expectedHeadVersionId: fixture.versionIds[1]
    }

    const results = await Promise.all([
      service.saveTextEdit({ ...base, content: 'left\n', operationId: 'operation-left' }),
      service.saveTextEdit({ ...base, content: 'right\n', operationId: 'operation-right' })
    ])

    expect(results.map((result) => result.kind).sort()).toEqual(['conflict', 'created'])
    expect(await client.uploadVersion.count()).toBe(3)
    expect(
      await client.managedFileVersionWriteOperation.count({ where: { state: 'conflict' } })
    ).toBe(1)
    await expect(
      client.managedFileVersionWriteOperation.findFirstOrThrow({ where: { state: 'conflict' } })
    ).resolves.toMatchObject({ errorCode: 'VERSION_CONFLICT' })
  })

  it('advances monotonically across colliding physical storage tags without clobbering bytes', async () => {
    const fixture = await createFixture('artifact')
    const operationId = 'artifact-collision-operation'
    const versionFileOperator = new NodeVersionFileOperator({ storageRoot })
    const planInput = {
      operationId,
      scope: {
        source: 'artifact' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: fixture.fileId
      },
      logicalFilename: 'README.md'
    }
    const collidingPlan = versionFileOperator.planImmutable({ ...planInput, candidateIndex: 0 })
    const secondCollidingPlan = versionFileOperator.planImmutable({
      ...planInput,
      candidateIndex: 1
    })
    const expectedPlan = versionFileOperator.planImmutable({ ...planInput, candidateIndex: 2 })
    const collidingPath = join(storageRoot, ...collidingPlan.storageRef.split('/'))
    const secondCollidingPath = join(storageRoot, ...secondCollidingPlan.storageRef.split('/'))
    await mkdir(dirname(collidingPath), { recursive: true })
    await writeFile(collidingPath, 'do not replace')
    await writeFile(secondCollidingPath, 'also do not replace')
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      createId: () => 'artifact-v3',
      versionFileOperator
    })

    const result = await service.saveTextEdit({
      source: 'artifact',
      projectId: 'project-1',
      fileId: fixture.fileId,
      basedOnVersionId: fixture.versionIds[1],
      expectedHeadVersionId: fixture.versionIds[1],
      content: 'new bytes\n',
      operationId
    })

    expect(result).toMatchObject({ kind: 'created' })
    const resolved = await service.openLatest({
      source: 'artifact',
      projectId: 'project-1',
      fileId: fixture.fileId
    })
    try {
      expect(resolved).toMatchObject({ version: { storedFilename: expectedPlan.storedFilename } })
    } finally {
      await resolved.close()
    }
    await expect(readFile(collidingPath, 'utf8')).resolves.toBe('do not replace')
    await expect(readFile(secondCollidingPath, 'utf8')).resolves.toBe('also do not replace')
  })

  it('reallocates the journal destination when a no-clobber publication loses a filesystem race', async () => {
    const fixture = await createFixture('upload')
    let publicationAttempts = 0
    const versionFileOperator = new NodeVersionFileOperator({ storageRoot })
    const publishImmutable = versionFileOperator.publishImmutable.bind(versionFileOperator)
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      createId: () => 'upload-v3',
      versionFileOperator: Object.assign(versionFileOperator, {
        publishImmutable: async (...args: Parameters<typeof publishImmutable>) => {
          publicationAttempts += 1
          if (publicationAttempts === 1) {
            throw new VersionFileOperatorError(
              'INTEGRITY_FAILED',
              'simulated no-replace race',
              'DESTINATION_COLLISION'
            )
          }
          return publishImmutable(...args)
        }
      })
    })

    await expect(
      service.saveTextEdit({
        source: 'upload',
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        content: 'race-safe\n',
        operationId: 'race-operation'
      })
    ).resolves.toMatchObject({ kind: 'created' })
    expect(publicationAttempts).toBe(2)
    const operation = await client.managedFileVersionWriteOperation.findUniqueOrThrow({
      where: { operationId: 'race-operation' }
    })
    const expectedPlan = versionFileOperator.planImmutable({
      operationId: 'race-operation',
      scope: {
        source: 'upload',
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: fixture.fileId
      },
      logicalFilename: 'README.md',
      candidateIndex: 1
    })
    expect(operation).toMatchObject({
      state: 'published',
      storageTag: `v${expectedPlan.versionToken}`,
      storedFilename: expectedPlan.storedFilename
    })
  })

  it('replays a failed partial publication with only a scrubbed deletion tombstone', async () => {
    const fixture = await createFixture('upload')
    let corruptPublication = true
    const versionFileOperator = new NodeVersionFileOperator({
      storageRoot,
      fileSystem: {
        open: async (...args) => {
          const handle = await openFile(...args)
          if (!corruptPublication || typeof args[1] !== 'string' || !args[1].startsWith('wx')) {
            return handle
          }
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'write') {
                return async (
                  buffer: Uint8Array,
                  offset: number,
                  length: number,
                  position: number
                ) => {
                  const changed = Buffer.from(buffer.subarray(offset, offset + length))
                  if (changed.byteLength > 0) changed[0] = changed[0]! ^ 0xff
                  return target.write(changed, 0, changed.byteLength, position)
                }
              }
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            }
          })
        }
      }
    })
    const operationId = 'partial-publication-replay'
    const request = {
      source: 'upload' as const,
      projectId: 'project-1',
      fileId: fixture.fileId,
      basedOnVersionId: fixture.versionIds[1],
      expectedHeadVersionId: fixture.versionIds[1],
      content: 'retry the same immutable destination\n',
      operationId
    }
    const planInput = {
      operationId,
      scope: {
        source: 'upload' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: fixture.fileId
      },
      logicalFilename: 'README.md'
    }
    const firstPlan = versionFileOperator.planImmutable({ ...planInput, candidateIndex: 0 })
    const secondPlan = versionFileOperator.planImmutable({ ...planInput, candidateIndex: 1 })
    const firstPath = join(storageRoot, ...firstPlan.storageRef.split('/'))
    const secondPath = join(storageRoot, ...secondPlan.storageRef.split('/'))
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      createId: () => 'upload-v3',
      versionFileOperator
    })

    await expect(service.saveTextEdit(request)).rejects.toMatchObject({
      code: 'INTEGRITY_FAILED'
    })
    await expect(
      client.managedFileVersionWriteOperation.findUniqueOrThrow({ where: { operationId } })
    ).resolves.toMatchObject({ state: 'staging', contentStorageKey: firstPlan.storageRef })
    expect(await readFile(firstPath)).not.toEqual(Buffer.from(request.content))

    corruptPublication = false
    await expect(service.saveTextEdit(request)).resolves.toMatchObject({
      kind: 'created',
      headVersionId: 'upload-v3'
    })
    await expect(
      client.managedFileVersionWriteOperation.findUniqueOrThrow({ where: { operationId } })
    ).resolves.toMatchObject({ state: 'published', contentStorageKey: secondPlan.storageRef })
    await expect(readFile(firstPath)).resolves.toHaveLength(0)
    await expect(readFile(secondPath)).resolves.toEqual(Buffer.from(request.content))
    const parentEntries = await readdir(dirname(firstPath))
    expect(parentEntries).toHaveLength(2)
    expect(parentEntries).toContain(firstPlan.storedFilename)
    expect(parentEntries).toContain(secondPlan.storedFilename)
  })

  it('does not delete an existing destination when every no-clobber publication collides', async () => {
    const fixture = await createFixture('upload')
    const collidingPaths: string[] = []
    const versionFileOperator = new NodeVersionFileOperator({ storageRoot })
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      versionFileOperator: Object.assign(versionFileOperator, {
        publishImmutable: async (
          input: Parameters<typeof versionFileOperator.publishImmutable>[0]
        ) => {
          const destinationPath = join(storageRoot, ...input.plannedFile.storageRef.split('/'))
          await mkdir(dirname(destinationPath), { recursive: true })
          await writeFile(destinationPath, 'existing bytes')
          collidingPaths.push(destinationPath)
          throw new VersionFileOperatorError(
            'INTEGRITY_FAILED',
            'simulated no-replace collision',
            'DESTINATION_COLLISION'
          )
        }
      })
    })

    await expect(
      service.saveTextEdit({
        source: 'upload',
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        content: 'never published\n',
        operationId: 'exhausted-collision-operation'
      })
    ).rejects.toMatchObject({ code: 'STORAGE_COLLISION' })

    expect(collidingPaths).toHaveLength(16)
    for (const collidingPath of collidingPaths) {
      await expect(readFile(collidingPath, 'utf8')).resolves.toBe('existing bytes')
    }
    await expect(
      client.managedFileVersionWriteOperation.findUniqueOrThrow({
        where: { operationId: 'exhausted-collision-operation' }
      })
    ).resolves.toMatchObject({ state: 'failed', errorCode: 'STORAGE_COLLISION' })
  })

  it('never writes temporary or final bytes outside the storage root through a symlinked ancestor', async () => {
    const fixture = await createFixture('upload')
    outsideRoot = await mkdtemp(join(tmpdir(), 'open-science-managed-version-outside-'))
    const managedVersionsPath = join(
      storageRoot,
      'uploads',
      'project-1',
      'session-1',
      fixture.fileId,
      'managed-versions'
    )
    await symlink(
      outsideRoot,
      managedVersionsPath,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })

    await expect(
      service.saveTextEdit({
        source: 'upload',
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        content: 'must stay in root\n',
        operationId: 'symlink-escape-operation'
      })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })

    expect(await readdir(outsideRoot)).toEqual([])
  })

  it('returns one published result and preserves its bytes for concurrent replay of one operation', async () => {
    const fixture = await createFixture('upload')
    let releaseFirstAfterPublish!: () => void
    let signalFirstAfterPublish!: () => void
    const firstAfterPublish = new Promise<void>((resolve) => {
      signalFirstAfterPublish = resolve
    })
    const firstMayContinue = new Promise<void>((resolve) => {
      releaseFirstAfterPublish = resolve
    })
    let publicationCount = 0
    const versionFileOperator = new NodeVersionFileOperator({ storageRoot })
    const publishImmutable = versionFileOperator.publishImmutable.bind(versionFileOperator)
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      createId: () => 'upload-v3',
      versionFileOperator: Object.assign(versionFileOperator, {
        publishImmutable: async (...args: Parameters<typeof publishImmutable>) => {
          const stored = await publishImmutable(...args)
          publicationCount += 1
          if (publicationCount === 1) {
            signalFirstAfterPublish()
            await firstMayContinue
          }
          return stored
        }
      })
    })
    const request = {
      source: 'upload' as const,
      projectId: 'project-1',
      fileId: fixture.fileId,
      basedOnVersionId: fixture.versionIds[1],
      expectedHeadVersionId: fixture.versionIds[1],
      content: 'one durable publication\n',
      operationId: 'same-operation'
    }

    const first = service.saveTextEdit(request)
    await firstAfterPublish
    const secondResult = await service.saveTextEdit(request)
    releaseFirstAfterPublish()
    const firstResult = await first

    expect([firstResult, secondResult]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'created', headVersionId: 'upload-v3', replayed: false }),
        expect.objectContaining({ kind: 'created', headVersionId: 'upload-v3', replayed: true })
      ])
    )
    await expect(
      client.managedFileVersionWriteOperation.findUniqueOrThrow({
        where: { operationId: request.operationId }
      })
    ).resolves.toMatchObject({ state: 'published', resultVersionId: 'upload-v3' })
    const resolved = await service.openLatest({
      source: 'upload',
      projectId: 'project-1',
      fileId: fixture.fileId
    })
    try {
      await expect(resolved.readRange(0, resolved.size)).resolves.toEqual(
        new Uint8Array(Buffer.from('one durable publication\n'))
      )
    } finally {
      await resolved.close()
    }
  })

  it('replays the original published result after a later head and rejects corrupt result bytes', async () => {
    const fixture = await createFixture('upload')
    const ids = ['upload-v3', 'upload-v4']
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      createId: () => ids.shift()!
    })
    const firstRequest = {
      source: 'upload' as const,
      projectId: 'project-1',
      fileId: fixture.fileId,
      basedOnVersionId: fixture.versionIds[1],
      expectedHeadVersionId: fixture.versionIds[1],
      content: 'published result\n',
      operationId: 'published-operation'
    }
    await expect(service.saveTextEdit(firstRequest)).resolves.toMatchObject({
      kind: 'created',
      headVersionId: 'upload-v3',
      replayed: false
    })
    await service.saveTextEdit({
      ...firstRequest,
      basedOnVersionId: 'upload-v3',
      expectedHeadVersionId: 'upload-v3',
      content: 'later head\n',
      operationId: 'later-operation'
    })

    const publishedVersion = await client.uploadVersion.findUniqueOrThrow({
      where: { id: 'upload-v3' }
    })
    const replayWithoutBaseline = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })
    expect(publishedVersion.storedFilename).not.toBe('content')
    await expect(replayWithoutBaseline.saveTextEdit(firstRequest)).resolves.toMatchObject({
      kind: 'created',
      headVersionId: 'upload-v3',
      version: { id: 'upload-v3' },
      replayed: true
    })
    await writeFile(join(storageRoot, ...publishedVersion.contentStorageKey.split('/')), 'corrupt')
    await expect(service.saveTextEdit(firstRequest)).rejects.toMatchObject({
      code: 'INTEGRITY_FAILED'
    })
  })

  it('rejects a published journal whose result Version was not created by that operation', async () => {
    const fixture = await createFixture('upload')
    const version = await client.uploadVersion.findUniqueOrThrow({
      where: { id: fixture.versionIds[1] }
    })
    const forgedBytes = Buffer.from('forged\n')
    await client.managedFileVersionWriteOperation.create({
      data: {
        operationId: 'forged-published-operation',
        source: 'upload',
        projectId: 'project-1',
        sourceFileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        state: 'published',
        storageTag: 'vforged1',
        storedFilename: 'vforged1_README.md',
        contentStorageKey:
          'uploads/project-1/session-1/upload-file-1/managed-versions/vforged1_README.md',
        checksum: checksum(forgedBytes),
        sizeBytes: BigInt(forgedBytes.byteLength),
        textFormatJson: JSON.stringify({
          hasUtf8Bom: false,
          newline: 'lf',
          hasTrailingNewline: true
        }),
        resultVersionId: version.id
      }
    })
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })

    await expect(
      service.saveTextEdit({
        source: 'upload',
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        content: 'forged\n',
        operationId: 'forged-published-operation'
      })
    ).rejects.toMatchObject({ code: 'CONTENT_INTEGRITY_FAILED' })
  })

  it('recovers an intact published file after a crash before file_ready and publishes once', async () => {
    const fixture = await createFixture('upload')
    const crashing = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      createId: () => 'upload-v3',
      testFaultAt: 'after-file-publish'
    })
    await expect(
      crashing.saveTextEdit({
        source: 'upload',
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        content: 'survives crash\n',
        operationId: 'recover-operation'
      })
    ).rejects.toThrow('simulated managed version crash')
    await expect(
      client.managedFileVersionWriteOperation.findUniqueOrThrow({
        where: { operationId: 'recover-operation' }
      })
    ).resolves.toMatchObject({ state: 'staging' })

    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      createId: () => 'upload-v3'
    })
    const recovery = await service.recoverPendingWrites()
    expect(recovery).toEqual({ recovered: 1, conflicted: 0, failed: 0, integrityErrors: [] })
    expect(await client.uploadVersion.count()).toBe(3)
    await expect(
      client.uploadFile.findUniqueOrThrow({ where: { id: fixture.fileId } })
    ).resolves.toMatchObject({ currentVersionId: 'upload-v3' })
    await expect(
      client.managedFileVersionWriteOperation.findUniqueOrThrow({
        where: { operationId: 'recover-operation' }
      })
    ).resolves.toMatchObject({ state: 'published', resultVersionId: 'upload-v3' })
  })

  it('does not remove an incomplete recovery file referenced by an immutable Version', async () => {
    const fixture = await createFixture('upload')
    const crashing = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      testFaultAt: 'after-journal'
    })
    await expect(
      crashing.saveTextEdit({
        source: 'upload',
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        content: 'expected complete bytes\n',
        operationId: 'owned-incomplete-recovery'
      })
    ).rejects.toThrow('simulated managed version crash')
    const operation = await client.managedFileVersionWriteOperation.findUniqueOrThrow({
      where: { operationId: 'owned-incomplete-recovery' }
    })
    const partial = Buffer.from('partial')
    const localPath = join(storageRoot, ...operation.contentStorageKey.split('/'))
    await mkdir(dirname(localPath), { recursive: true })
    await writeFile(localPath, partial)
    await client.uploadVersion.create({
      data: {
        id: 'upload-version-owning-incomplete-file',
        uploadFileId: fixture.fileId,
        versionNumber: 3,
        state: 'ready',
        originKind: 'legacy',
        basedOnVersionId: fixture.versionIds[1],
        contentStorageKey: operation.contentStorageKey,
        filename: 'README.md',
        originalFilename: 'README.md',
        contentType: 'text/markdown',
        sizeBytes: BigInt(partial.byteLength),
        checksum: checksum(partial)
      }
    })

    const recovering = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })
    await expect(recovering.recoverPendingWrites()).resolves.toMatchObject({ failed: 1 })

    await expect(readFile(localPath)).resolves.toEqual(partial)
    await expect(
      client.managedFileVersionWriteOperation.findUniqueOrThrow({
        where: { operationId: 'owned-incomplete-recovery' }
      })
    ).resolves.toMatchObject({ state: 'failed' })
  })

  it('does not remove unknown bytes that appeared after a journal-only crash', async () => {
    const fixture = await createFixture('upload')
    const crashing = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      testFaultAt: 'after-journal'
    })
    await expect(
      crashing.saveTextEdit({
        source: 'upload',
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        content: 'expected complete bytes\n',
        operationId: 'partial-final-operation'
      })
    ).rejects.toThrow()
    const operation = await client.managedFileVersionWriteOperation.findUniqueOrThrow({
      where: { operationId: 'partial-final-operation' }
    })
    const finalPath = join(storageRoot, ...operation.contentStorageKey.split('/'))
    await mkdir(dirname(finalPath), { recursive: true })
    await writeFile(finalPath, 'partial')

    const recovered = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      createId: () => 'unused-version-id'
    })
    await expect(recovered.recoverPendingWrites()).resolves.toMatchObject({
      recovered: 0,
      failed: 1
    })
    await expect(readFile(finalPath, 'utf8')).resolves.toBe('partial')
    await expect(
      client.managedFileVersionWriteOperation.findUniqueOrThrow({
        where: { operationId: 'partial-final-operation' }
      })
    ).resolves.toMatchObject({ state: 'failed', errorCode: 'CONTENT_INTEGRITY_FAILED' })
  })

  it('retries cleanup of a claimed incomplete file after a transient deletion failure', async () => {
    const fixture = await createFixture('upload')
    const crashing = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      testFaultAt: 'after-journal'
    })
    const operationId = 'retry-incomplete-cleanup'
    await expect(
      crashing.saveTextEdit({
        source: 'upload',
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        content: 'expected complete bytes\n',
        operationId
      })
    ).rejects.toThrow('simulated managed version crash')
    const operation = await client.managedFileVersionWriteOperation.findUniqueOrThrow({
      where: { operationId }
    })
    const localPath = join(storageRoot, ...operation.contentStorageKey.split('/'))
    await mkdir(dirname(localPath), { recursive: true })
    await writeFile(localPath, 'claimed partial')
    const partial = Buffer.from('claimed partial')
    let removeAttempts = 0
    const realOperator = new NodeVersionFileOperator({ storageRoot })
    const retryingOperator = Object.assign(realOperator, {
      inspectRecovery: async () => {
        try {
          await readFile(localPath)
          return {
            state: 'incomplete' as const,
            actualIntegrity: {
              sizeBytes: partial.byteLength,
              checksum: checksum(partial)
            }
          }
        } catch {
          return { state: 'missing' as const }
        }
      },
      removeIncomplete: async () => {
        removeAttempts += 1
        if (removeAttempts <= 2) {
          throw new VersionFileOperatorError('PERMISSION_DENIED', 'temporarily denied')
        }
        await rm(localPath)
      }
    })
    const recovering = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      versionFileOperator: retryingOperator
    })

    await recovering.recoverPendingWrites()
    await expect(readFile(localPath, 'utf8')).resolves.toBe('claimed partial')
    await recovering.recoverPendingWrites()

    await expect(readFile(localPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(removeAttempts).toBe(3)
    await expect(
      client.managedFileVersionWriteOperation.findUniqueOrThrow({ where: { operationId } })
    ).resolves.toMatchObject({ state: 'failed' })
  })

  it('keeps a transient recovery read failure pending for the next startup retry', async () => {
    const fixture = await createFixture('upload')
    const crashing = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      testFaultAt: 'after-file-publish'
    })
    await expect(
      crashing.saveTextEdit({
        source: 'upload',
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        content: 'retry me\n',
        operationId: 'transient-recovery-operation'
      })
    ).rejects.toThrow('simulated managed version crash')

    const versionFileOperator = new NodeVersionFileOperator({ storageRoot })
    const retryable = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      versionFileOperator: Object.assign(versionFileOperator, {
        inspectRecovery: async () => {
          throw new VersionFileOperatorError(
            'STORAGE_UNAVAILABLE',
            'temporary filesystem outage',
            undefined,
            { cause: Object.assign(new Error('temporary filesystem outage'), { code: 'EIO' }) }
          )
        }
      })
    })
    await expect(retryable.recoverPendingWrites()).resolves.toMatchObject({
      recovered: 0,
      failed: 0
    })
    await expect(
      client.managedFileVersionWriteOperation.findUniqueOrThrow({
        where: { operationId: 'transient-recovery-operation' }
      })
    ).resolves.toMatchObject({ state: 'staging' })
  })

  it.each(['after-temp-write', 'after-file-ready'] as const)(
    'idempotently recovers a save interrupted at %s',
    async (testFaultAt) => {
      const fixture = await createFixture('artifact')
      const crashing = new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client),
        createId: () => 'artifact-v3',
        testFaultAt
      })
      const request = {
        source: 'artifact' as const,
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        content: `${testFaultAt}\n`,
        operationId: `${testFaultAt}-operation`
      }
      await expect(crashing.saveTextEdit(request)).rejects.toThrow(
        'simulated managed version crash'
      )

      const service = new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client),
        createId: () => 'artifact-v3'
      })
      await expect(service.recoverPendingWrites()).resolves.toMatchObject({ recovered: 1 })
      await expect(service.saveTextEdit(request)).resolves.toMatchObject({
        kind: 'created',
        headVersionId: 'artifact-v3'
      })
      expect(await client.artifactVersion.count()).toBe(3)
    }
  )

  it.each([
    ['artifact', 'project-intent'],
    ['upload', 'session-tombstone']
  ] as const)(
    'does not publish or revive a deleted %s after a %s appears at file_ready',
    async (source, barrier) => {
      const fixture = await createFixture(source)
      const crashing = new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client),
        createId: () => `${source}-v3`,
        testFaultAt: 'after-file-ready'
      })
      await expect(
        crashing.saveTextEdit({
          source,
          projectId: 'project-1',
          fileId: fixture.fileId,
          basedOnVersionId: fixture.versionIds[1],
          expectedHeadVersionId: fixture.versionIds[1],
          content: 'must not publish\n',
          operationId: `${source}-deletion-operation`
        })
      ).rejects.toThrow('simulated managed version crash')

      if (barrier === 'project-intent') {
        await client.projectDeletionIntent.create({ data: { projectId: 'project-1' } })
      } else {
        const deletedAt = new Date('2026-08-12T00:00:00.000Z')
        await client.managedFileSessionSync.create({
          data: {
            projectId: 'project-1',
            sessionId: 'session-1',
            filesRevision: 1,
            groupSortAtMs: BigInt(1),
            deletedAt,
            deleteOperationId: 'delete-session-1'
          }
        })
        await client.managedFile.update({
          where: {
            projectId_source_sourceFileId: {
              projectId: 'project-1',
              source,
              sourceFileId: fixture.fileId
            }
          },
          data: { deletedAt, deleteOperationId: 'delete-session-1' }
        })
      }

      const recovery = await new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client)
      }).recoverPendingWrites()

      expect(recovery).toMatchObject({ recovered: 0, failed: 1 })
      expect(
        source === 'artifact'
          ? await client.artifactVersion.count({ where: { artifactId: fixture.fileId } })
          : await client.uploadVersion.count({ where: { uploadFileId: fixture.fileId } })
      ).toBe(2)
      await expect(
        client.managedFileVersionWriteOperation.findUniqueOrThrow({
          where: { operationId: `${source}-deletion-operation` }
        })
      ).resolves.toMatchObject({ state: 'failed' })
      if (barrier === 'session-tombstone') {
        await expect(
          client.managedFileSessionSync.findUniqueOrThrow({
            where: {
              projectId_sessionId: { projectId: 'project-1', sessionId: 'session-1' }
            }
          })
        ).resolves.toMatchObject({
          deletedAt: new Date('2026-08-12T00:00:00.000Z'),
          deleteOperationId: 'delete-session-1'
        })
        await expect(
          client.managedFile.findFirstOrThrow({ where: { source, sourceFileId: fixture.fileId } })
        ).resolves.toMatchObject({ deleteOperationId: 'delete-session-1' })
      }
    }
  )

  it('rejects a pre-existing Session tombstone before creating a journal or publishing bytes', async () => {
    const fixture = await createFixture('upload')
    await client.managedFileSessionSync.create({
      data: {
        projectId: 'project-1',
        sessionId: 'session-1',
        filesRevision: 4,
        groupSortAtMs: BigInt(1),
        deletedAt: new Date('2026-08-12T00:00:00.000Z'),
        deleteOperationId: 'delete-session-1'
      }
    })
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })

    await expect(
      service.inspect({ source: 'upload', projectId: 'project-1', fileId: fixture.fileId })
    ).rejects.toMatchObject({ code: 'FILE_DELETED' })
    await expect(
      service.saveTextEdit({
        source: 'upload',
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        content: 'must not stage\n',
        operationId: 'preexisting-tombstone-operation'
      })
    ).rejects.toMatchObject({ code: 'FILE_DELETED' })
    expect(await client.managedFileVersionWriteOperation.count()).toBe(0)
    expect(await client.uploadVersion.count({ where: { uploadFileId: fixture.fileId } })).toBe(2)
  })

  it('does not rebuild an active projection inside a tombstoned session', async () => {
    const fixture = await createFixture('upload')
    await client.managedFile.deleteMany({ where: { sourceFileId: fixture.fileId } })
    await client.managedFileSessionSync.create({
      data: {
        projectId: 'project-1',
        sessionId: 'session-1',
        filesRevision: 4,
        groupSortAtMs: BigInt(1),
        deletedAt: new Date('2026-08-12T00:00:00.000Z'),
        deleteOperationId: 'delete-session-1'
      }
    })

    await new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    }).recoverPendingWrites()

    expect(await client.managedFile.count({ where: { sourceFileId: fixture.fileId } })).toBe(0)
  })

  it('does not expose a completed Artifact head before its Files projection becomes visible', async () => {
    const fixture = await createFixture('artifact')
    await client.managedFile.deleteMany({ where: { sourceFileId: fixture.fileId } })

    await new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    }).recoverPendingWrites()

    await expect(
      client.artifactLineage.findUniqueOrThrow({ where: { id: fixture.fileId } })
    ).resolves.toMatchObject({ currentVersionId: fixture.versionIds[1] })
    expect(await client.managedFile.count({ where: { sourceFileId: fixture.fileId } })).toBe(0)
  })

  it('fails a journal-only interrupted save without allocating a visible version number', async () => {
    const fixture = await createFixture('upload')
    const crashing = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      testFaultAt: 'after-journal'
    })
    await expect(
      crashing.saveTextEdit({
        source: 'upload',
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        content: 'journal only\n',
        operationId: 'journal-only-operation'
      })
    ).rejects.toThrow('simulated managed version crash')

    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })
    await expect(service.recoverPendingWrites()).resolves.toMatchObject({ failed: 1 })
    expect(await client.uploadVersion.count()).toBe(2)
    await expect(
      client.managedFileVersionWriteOperation.findUniqueOrThrow({
        where: { operationId: 'journal-only-operation' }
      })
    ).resolves.toMatchObject({ state: 'failed' })
  })

  it('recovers pending and cleans terminal journals beyond the first page', async () => {
    const fixture = await createFixture('upload')
    const format = JSON.stringify({
      hasUtf8Bom: false,
      newline: 'lf',
      hasTrailingNewline: true
    })
    await client.managedFileVersionWriteOperation.createMany({
      data: Array.from({ length: 101 }, (_, index) => {
        const suffix = index.toString().padStart(3, '0')
        return {
          operationId: `paged-pending-${suffix}`,
          source: 'upload',
          projectId: 'project-1',
          sourceFileId: fixture.fileId,
          basedOnVersionId: fixture.versionIds[1],
          expectedHeadVersionId: fixture.versionIds[1],
          state: 'staging',
          storageTag: `vp${suffix}x001`,
          storedFilename: `vp${suffix}x001_README.md`,
          contentStorageKey: `uploads/project-1/session-1/${fixture.fileId}/managed-versions/vp${suffix}x001_README.md`,
          checksum: checksum(Buffer.from(`missing ${suffix}\n`)),
          sizeBytes: BigInt(Buffer.byteLength(`missing ${suffix}\n`)),
          textFormatJson: format
        }
      })
    })
    const versionFileOperator = new NodeVersionFileOperator({ storageRoot })
    const terminalPlan = versionFileOperator.planImmutable({
      operationId: 'zz-paged-terminal',
      scope: {
        source: 'upload',
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: fixture.fileId
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    })
    const terminalPath = join(storageRoot, ...terminalPlan.storageRef.split('/'))
    await mkdir(dirname(terminalPath), { recursive: true })
    await writeFile(terminalPath, 'terminal cleanup\n')
    await client.managedFileVersionWriteOperation.create({
      data: {
        operationId: 'zz-paged-terminal',
        source: 'upload',
        projectId: 'project-1',
        sourceFileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        state: 'failed',
        storageTag: `v${terminalPlan.versionToken}`,
        storedFilename: terminalPlan.storedFilename,
        contentStorageKey: terminalPlan.storageRef,
        checksum: checksum(Buffer.from('terminal cleanup\n')),
        sizeBytes: BigInt(Buffer.byteLength('terminal cleanup\n')),
        textFormatJson: format,
        errorCode: 'CONTENT_INTEGRITY_FAILED'
      }
    })

    const recovery = await new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    }).recoverPendingWrites()

    expect(recovery).toMatchObject({ failed: 101 })
    expect(
      await client.managedFileVersionWriteOperation.count({ where: { state: 'failed' } })
    ).toBe(102)
    await expect(
      client.managedFileVersionWriteOperation.findUniqueOrThrow({
        where: { operationId: 'paged-pending-100' }
      })
    ).resolves.toMatchObject({ state: 'failed' })
    await expect(
      client.managedFileVersionWriteOperation.findUniqueOrThrow({
        where: { operationId: 'zz-paged-terminal' }
      })
    ).resolves.toMatchObject({ state: 'failed' })
    await expect(readFile(terminalPath)).resolves.toHaveLength(0)
  })

  it('marks corrupt staged publication bytes failed and never advances the head', async () => {
    const fixture = await createFixture('artifact')
    const crashing = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      createId: () => 'artifact-v3',
      testFaultAt: 'after-file-publish'
    })
    await expect(
      crashing.saveTextEdit({
        source: 'artifact',
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        content: 'will corrupt\n',
        operationId: 'corrupt-operation'
      })
    ).rejects.toThrow()
    const operation = await client.managedFileVersionWriteOperation.findUniqueOrThrow({
      where: { operationId: 'corrupt-operation' }
    })
    await writeFile(join(storageRoot, ...operation.contentStorageKey.split('/')), 'corrupt')

    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })
    const recovery = await service.recoverPendingWrites()
    expect(recovery).toMatchObject({ recovered: 0, conflicted: 0, failed: 1 })
    await expect(
      client.artifactLineage.findUniqueOrThrow({ where: { id: fixture.fileId } })
    ).resolves.toMatchObject({ currentVersionId: fixture.versionIds[1] })
    expect(await client.artifactVersion.count()).toBe(2)
  })

  it('never cleans a conflict path that is already owned by a ready Version', async () => {
    const fixture = await createFixture('upload')
    const owned = await client.uploadVersion.findUniqueOrThrow({
      where: { id: fixture.versionIds[1] }
    })
    await client.managedFileVersionWriteOperation.create({
      data: {
        operationId: 'owned-conflict-operation',
        source: 'upload',
        projectId: 'project-1',
        sourceFileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[0],
        expectedHeadVersionId: fixture.versionIds[0],
        state: 'file_ready',
        storageTag: 'vowned001',
        storedFilename: 'content',
        contentStorageKey: owned.contentStorageKey,
        checksum: owned.checksum,
        sizeBytes: owned.sizeBytes,
        textFormatJson: JSON.stringify({
          hasUtf8Bom: false,
          newline: 'lf',
          hasTrailingNewline: true
        })
      }
    })
    const ownedPath = join(storageRoot, ...owned.contentStorageKey.split('/'))

    const recovery = await new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    }).recoverPendingWrites()

    expect(recovery).toMatchObject({ conflicted: 1 })
    await expect(readFile(ownedPath, 'utf8')).resolves.toBe('second\n')
    await expect(
      client.managedFileVersionWriteOperation.findUniqueOrThrow({
        where: { operationId: 'owned-conflict-operation' }
      })
    ).resolves.toMatchObject({ state: 'conflict' })
  })

  it.each(['conflict', 'failed'] as const)(
    'retries cleanup of an unowned %s final without changing terminal journal state',
    async (state) => {
      const fixture = await createFixture('upload')
      const operationId = `${state}-cleanup-operation`
      const versionFileOperator = new NodeVersionFileOperator({ storageRoot })
      const plannedFile = versionFileOperator.planImmutable({
        operationId,
        scope: {
          source: 'upload',
          projectId: 'project-1',
          sessionId: 'session-1',
          logicalFileId: fixture.fileId
        },
        logicalFilename: 'README.md',
        candidateIndex: 0
      })
      const contentStorageKey = plannedFile.storageRef
      const finalPath = join(storageRoot, ...contentStorageKey.split('/'))
      await mkdir(dirname(finalPath), { recursive: true })
      await writeFile(finalPath, 'orphan final\n')
      await client.managedFileVersionWriteOperation.create({
        data: {
          operationId,
          source: 'upload',
          projectId: 'project-1',
          sourceFileId: fixture.fileId,
          basedOnVersionId: fixture.versionIds[1],
          expectedHeadVersionId: fixture.versionIds[1],
          state,
          storageTag: `v${plannedFile.versionToken}`,
          storedFilename: plannedFile.storedFilename,
          contentStorageKey,
          checksum: checksum(Buffer.from('orphan final\n')),
          sizeBytes: BigInt(Buffer.byteLength('orphan final\n')),
          textFormatJson: JSON.stringify({
            hasUtf8Bom: false,
            newline: 'lf',
            hasTrailingNewline: true
          }),
          errorCode: state === 'conflict' ? 'HEAD_CHANGED' : 'CONTENT_INTEGRITY_FAILED'
        }
      })

      await new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client)
      }).recoverPendingWrites()

      await expect(readFile(finalPath)).resolves.toHaveLength(0)
      await expect(
        client.managedFileVersionWriteOperation.findUniqueOrThrow({
          where: { operationId }
        })
      ).resolves.toMatchObject({ state })
    }
  )

  it('retries terminal incomplete-file cleanup on the next recovery pass', async () => {
    const fixture = await createFixture('upload')
    const operationId = 'failed-incomplete-cleanup-operation'
    const expectedBytes = Buffer.from('complete journal bytes\n')
    const partialBytes = Buffer.from('partial')
    let partialWritten = false
    const delegate = new NodeVersionFileOperator({
      storageRoot,
      fileSystem: {
        open: async (...args) => {
          const handle = await openFile(...args)
          if (typeof args[1] !== 'string' || !args[1].startsWith('wx')) return handle
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'write') {
                return async () => {
                  if (partialWritten) {
                    throw Object.assign(new Error('interrupted publication'), { code: 'EIO' })
                  }
                  partialWritten = true
                  return target.write(partialBytes, 0, partialBytes.byteLength, 0)
                }
              }
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            }
          })
        }
      }
    })
    const plannedFile = delegate.planImmutable({
      operationId,
      scope: {
        source: 'upload',
        projectId: 'project-1',
        sessionId: 'session-1',
        logicalFileId: fixture.fileId
      },
      logicalFilename: 'README.md',
      candidateIndex: 0
    })
    const finalPath = join(storageRoot, ...plannedFile.storageRef.split('/'))
    await expect(
      delegate.publishImmutable({
        operationId,
        scope: {
          source: 'upload',
          projectId: 'project-1',
          sessionId: 'session-1',
          logicalFileId: fixture.fileId
        },
        logicalFilename: 'README.md',
        candidateIndex: 0,
        plannedFile,
        content: expectedBytes
      })
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    await expect(readFile(finalPath)).resolves.toEqual(partialBytes)
    await client.managedFileVersionWriteOperation.create({
      data: {
        operationId,
        source: 'upload',
        projectId: 'project-1',
        sourceFileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        state: 'failed',
        storageTag: `v${plannedFile.versionToken}`,
        storedFilename: plannedFile.storedFilename,
        contentStorageKey: plannedFile.storageRef,
        checksum: checksum(expectedBytes),
        sizeBytes: expectedBytes.byteLength,
        textFormatJson: '{}',
        errorCode: 'CONTENT_INTEGRITY_FAILED'
      }
    })
    const removeIncomplete = delegate.removeIncomplete.bind(delegate)
    let removalAttempts = 0
    const versionFileOperator = Object.assign(delegate, {
      removeIncomplete: async (...args: Parameters<typeof removeIncomplete>) => {
        removalAttempts += 1
        if (removalAttempts === 1) {
          throw new VersionFileOperatorError('STORAGE_UNAVAILABLE', 'temporary delete failure')
        }
        return removeIncomplete(...args)
      }
    })
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      versionFileOperator
    })

    await service.recoverPendingWrites()
    expect(removalAttempts).toBe(1)
    await expect(readFile(finalPath)).resolves.toEqual(partialBytes)

    await service.recoverPendingWrites()
    expect(removalAttempts).toBe(2)
    await expect(readFile(finalPath)).resolves.toHaveLength(0)
    await expect(
      client.managedFileVersionWriteOperation.findUniqueOrThrow({ where: { operationId } })
    ).resolves.toMatchObject({ state: 'failed', errorCode: 'CONTENT_INTEGRITY_FAILED' })
  })

  it('does not clean unowned terminal paths whose bytes do not match the journal', async () => {
    const fixture = await createFixture('upload')
    const contentStorageKey = `uploads/project-1/session-1/${fixture.fileId}/managed-versions/vforeign1_README.md`
    const finalPath = join(storageRoot, ...contentStorageKey.split('/'))
    await mkdir(dirname(finalPath), { recursive: true })
    await writeFile(finalPath, 'foreign bytes\n')
    await client.managedFileVersionWriteOperation.create({
      data: {
        operationId: 'foreign-cleanup-operation',
        source: 'upload',
        projectId: 'project-1',
        sourceFileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        state: 'failed',
        storageTag: 'vforeign1',
        storedFilename: 'vforeign1_README.md',
        contentStorageKey,
        checksum: checksum(Buffer.from('journal bytes\n')),
        sizeBytes: BigInt(Buffer.byteLength('journal bytes\n')),
        textFormatJson: JSON.stringify({
          hasUtf8Bom: false,
          newline: 'lf',
          hasTrailingNewline: true
        }),
        errorCode: 'CONTENT_INTEGRITY_FAILED'
      }
    })

    await new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    }).recoverPendingWrites()

    await expect(readFile(finalPath, 'utf8')).resolves.toBe('foreign bytes\n')
  })

  it('paginates file roots while rebuilding the latest-version projection', async () => {
    const fixture = await createFixture('upload')
    const fileRows = Array.from({ length: 101 }, (_, index) => {
      const suffix = index.toString().padStart(3, '0')
      return {
        id: `paged-upload-${suffix}`,
        projectId: 'project-1',
        sessionId: 'session-1',
        filename: `${suffix}.txt`,
        originalFilename: `${suffix}.txt`
      }
    })
    await client.uploadFile.createMany({ data: fileRows })
    await client.uploadVersion.createMany({
      data: fileRows.map((file, index) => ({
        id: `${file.id}-v1`,
        uploadFileId: file.id,
        versionNumber: 1,
        state: 'ready',
        originKind: 'legacy',
        contentStorageKey: `uploads/project-1/session-1/${file.id}/content`,
        filename: file.filename,
        originalFilename: file.originalFilename,
        contentType: 'text/plain',
        sizeBytes: BigInt(1),
        checksum: checksum(Buffer.from('x')),
        createdAt: new Date(1_000 + index)
      }))
    })
    for (const file of fileRows) {
      await client.uploadFile.update({
        where: { id: file.id },
        data: { currentVersionId: `${file.id}-v1` }
      })
    }
    await client.managedFile.createMany({
      data: fileRows.map((file, index) => ({
        source: 'upload',
        sourceFileId: file.id,
        sourceVersionId: fixture.versionIds[0],
        checksum: 'stale',
        projectId: 'project-1',
        sessionId: 'session-1',
        displayName: file.originalFilename,
        storageKey: `stale/${file.id}`,
        sizeBytes: BigInt(0),
        sortAtMs: BigInt(index)
      }))
    })
    const last = fileRows.at(-1)!

    const transactionSpy = vi.spyOn(client, '$transaction')
    await new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    }).recoverPendingWrites()

    await expect(
      client.managedFile.findUniqueOrThrow({
        where: {
          projectId_source_sourceFileId: {
            projectId: 'project-1',
            source: 'upload',
            sourceFileId: last.id
          }
        }
      })
    ).resolves.toMatchObject({ sourceVersionId: `${last.id}-v1` })
    expect(transactionSpy).toHaveBeenCalledTimes(fileRows.length + 1)
    transactionSpy.mockRestore()
  })

  it('rejects archived projects and corrupted completed head bytes with stable error codes', async () => {
    const fixture = await createFixture('artifact')
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })
    await client.project.update({
      where: { id: 'project-1' },
      data: { archivedAt: new Date() }
    })
    await expect(
      service.inspect({ source: 'artifact', projectId: 'project-1', fileId: fixture.fileId })
    ).resolves.toMatchObject({
      canEdit: false,
      canDiff: true,
      unavailableReason: 'PROJECT_NOT_WRITABLE'
    })
    await expect(
      service.saveTextEdit({
        source: 'artifact',
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        content: 'blocked\n',
        operationId: 'blocked-operation'
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ManagedFileVersionError>>({
        code: 'PROJECT_NOT_WRITABLE'
      })
    )

    await client.project.update({ where: { id: 'project-1' }, data: { archivedAt: null } })
    const head = await client.artifactVersion.findUniqueOrThrow({
      where: { id: fixture.versionIds[1] }
    })
    await writeFile(join(storageRoot, ...head.contentStorageKey.split('/')), 'corrupt')
    await expect(
      service.inspect({ source: 'artifact', projectId: 'project-1', fileId: fixture.fileId })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
  })

  it('reports an unsafe stable basename as ineligible instead of failing during save allocation', async () => {
    const fixture = await createFixture('upload')
    await client.uploadFile.update({
      where: { id: fixture.fileId },
      data: { filename: 'CON.md', originalFilename: 'CON.md' }
    })
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })

    await expect(
      service.inspect({ source: 'upload', projectId: 'project-1', fileId: fixture.fileId })
    ).resolves.toMatchObject({ canEdit: false, unavailableReason: 'UNSAFE_FILENAME' })
  })

  it('keeps read, diff, and write capabilities independent of native bindings', async () => {
    const fixture = await createFixture('upload')
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })

    await expect(
      service.inspect({ source: 'upload', projectId: 'project-1', fileId: fixture.fileId })
    ).resolves.toMatchObject({
      canEdit: true,
      canDiff: true,
      text: 'second\n'
    })
    const lease = await service.openLatest({
      source: 'upload',
      projectId: 'project-1',
      fileId: fixture.fileId
    })
    await expect(lease.readRange(0, lease.size)).resolves.toEqual(
      new Uint8Array(Buffer.from('second\n'))
    )
    await lease.close()
    await expect(
      service.diffText({
        source: 'upload',
        projectId: 'project-1',
        fileId: fixture.fileId,
        versionId: fixture.versionIds[1],
        requestId: 'node-version-read'
      })
    ).resolves.toMatchObject({
      baseVersionId: fixture.versionIds[0],
      selectedVersionId: fixture.versionIds[1]
    })
    await expect(service.auditActiveVersionIntegrity()).resolves.toEqual([])
    const current = await service.openLatest({
      source: 'upload',
      projectId: 'project-1',
      fileId: fixture.fileId
    })
    try {
      await expect(current.readRange(0, current.size)).resolves.toEqual(
        new Uint8Array(Buffer.from('second\n'))
      )
    } finally {
      await current.close()
    }
    await expect(
      service.saveTextEdit({
        source: 'upload',
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        content: 'node-managed write\n',
        operationId: 'node-managed-write'
      })
    ).resolves.toMatchObject({ kind: 'created' })
  })

  it('preserves STORAGE_UNAVAILABLE from the version file operator', async () => {
    const fixture = await createFixture('upload')
    const versionFileOperator = new NodeVersionFileOperator({ storageRoot })
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      versionFileOperator: Object.assign(versionFileOperator, {
        openImmutable: async () => {
          throw new VersionFileOperatorError(
            'STORAGE_UNAVAILABLE',
            'configured storage is unavailable'
          )
        }
      })
    })

    await expect(
      service.inspect({ source: 'upload', projectId: 'project-1', fileId: fixture.fileId })
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
  })

  it('keeps file_ready retryable when published storage is temporarily unavailable', async () => {
    const fixture = await createFixture('upload')
    const delegate = new NodeVersionFileOperator({ storageRoot })
    let unavailableStorageRef: string | undefined
    const versionFileOperator = {
      planImmutable: delegate.planImmutable.bind(delegate),
      publishImmutable: async (
        ...args: Parameters<NodeVersionFileOperator['publishImmutable']>
      ) => {
        const stored = await delegate.publishImmutable(...args)
        unavailableStorageRef = stored.storageRef
        return stored
      },
      inspectRecovery: delegate.inspectRecovery.bind(delegate),
      removeIncomplete: delegate.removeIncomplete.bind(delegate),
      removeImmutable: delegate.removeImmutable.bind(delegate),
      openImmutable: async (...args: Parameters<NodeVersionFileOperator['openImmutable']>) => {
        if (args[0] === unavailableStorageRef) {
          throw new VersionFileOperatorError(
            'STORAGE_UNAVAILABLE',
            'configured storage is temporarily unavailable'
          )
        }
        return delegate.openImmutable(...args)
      }
    }
    const request = {
      source: 'upload' as const,
      projectId: 'project-1',
      fileId: fixture.fileId,
      basedOnVersionId: fixture.versionIds[1],
      expectedHeadVersionId: fixture.versionIds[1],
      content: 'retry after storage returns\n',
      operationId: 'temporary-storage-outage'
    }
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      createId: () => 'upload-v3',
      versionFileOperator
    })

    await expect(service.saveTextEdit(request)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE'
    })
    await expect(
      client.managedFileVersionWriteOperation.findUniqueOrThrow({
        where: { operationId: request.operationId }
      })
    ).resolves.toMatchObject({ state: 'file_ready', errorCode: null })

    unavailableStorageRef = undefined
    await expect(service.recoverPendingWrites()).resolves.toMatchObject({ recovered: 1, failed: 0 })
    const latest = await service.openLatest(request)
    try {
      expect(latest).toMatchObject({ version: { id: 'upload-v3' } })
    } finally {
      await latest.close()
    }
  })

  it('audits only active heads during startup and validates historical bytes lazily', async () => {
    const fixture = await createFixture('artifact')
    const historical = await client.artifactVersion.findUniqueOrThrow({
      where: { id: fixture.versionIds[0] }
    })
    await writeFile(
      join(storageRoot, ...historical.contentStorageKey.split('/')),
      'corrupt historical bytes'
    )
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })

    await expect(service.recoverPendingWrites()).resolves.toMatchObject({ integrityErrors: [] })
    await expect(
      service.inspect({
        source: 'artifact',
        projectId: 'project-1',
        fileId: fixture.fileId,
        versionId: fixture.versionIds[0]
      })
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
  })

  it('keeps blocking journal recovery separate from the explicit active-head integrity audit', async () => {
    const fixture = await createFixture('artifact')
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client)
    })
    const head = await client.artifactVersion.findUniqueOrThrow({
      where: { id: fixture.versionIds[1] }
    })
    await writeFile(join(storageRoot, ...head.contentStorageKey.split('/')), 'corrupt active head')

    await expect(service.recoverPendingWrites()).resolves.toMatchObject({ integrityErrors: [] })
    await expect(service.auditActiveVersionIntegrity()).resolves.toEqual([
      {
        source: 'artifact',
        fileId: fixture.fileId,
        versionId: fixture.versionIds[1],
        code: 'CONTENT_INTEGRITY_FAILED'
      }
    ])
  })

  it('audits a large binary head without invoking the body reader', async () => {
    const fixture = await createFixture('upload')
    await client.uploadVersion.update({
      where: { id: fixture.versionIds[1] },
      data: { contentType: 'video/mp4' }
    })
    const versionFileOperator = new NodeVersionFileOperator({ storageRoot })
    const openImmutable = vi.spyOn(versionFileOperator, 'openImmutable')
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      versionFileOperator
    })

    await expect(service.auditActiveVersionIntegrity()).resolves.toEqual([])
    expect(openImmutable).toHaveBeenCalledWith(expect.any(String), expect.any(Object), {
      forceVerify: true
    })
  })

  describe('openUnpublishedVersion', () => {
    const createPendingAgentPlanFixture = async (): Promise<{
      fileId: string
      versionId: string
      bytes: Buffer
    }> => {
      const fileId = 'plan-lineage-1'
      const versionId = 'plan-pending-v1'
      const bytes = Buffer.from('{"schema_version":1,"task_summary":"Analyze the dataset"}\n')
      const storageKey = `artifacts/project-1/session-1/${fileId}/versions/${versionId}/content`
      await mkdir(dirname(join(storageRoot, ...storageKey.split('/'))), { recursive: true })
      await writeFile(join(storageRoot, ...storageKey.split('/')), bytes)
      await client.artifactLineage.create({
        data: {
          id: fileId,
          projectId: 'project-1',
          sessionId: 'session-1',
          normalizedFilename: 'plan.json',
          filename: 'plan.json'
        }
      })
      await client.artifactVersion.create({
        data: {
          id: versionId,
          artifactId: fileId,
          versionNumber: 1,
          filename: 'plan.json',
          originKind: 'agent_generated',
          basedOnVersionId: null,
          artifactRunId: 'plan-run-1',
          rootFrameId: 'frame-root',
          agentFrameId: 'frame-agent',
          messageBranchId: 'branch-1',
          runtimeSegmentId: 'segment-1',
          promptMessageId: 'message-1',
          state: 'pending',
          contentStorageKey: storageKey,
          evidenceStorageKey: `${storageKey}/../evidence`,
          evidenceJson: '{"schema_version":1}',
          evidenceChecksum: checksum(Buffer.from('{"schema_version":1}')),
          evidenceSchemaVersion: 1,
          contentType: 'application/json',
          sizeBytes: BigInt(bytes.byteLength),
          checksum: checksum(bytes)
        }
      })
      return { fileId, versionId, bytes }
    }

    it('reads a pending agent-generated version by id exactly as written', async () => {
      const fixture = await createPendingAgentPlanFixture()
      const service = new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client)
      })
      const identity = {
        source: 'artifact' as const,
        projectId: 'project-1',
        fileId: fixture.fileId
      }

      // The published read path rejects this exact shape: the lineage head is unassigned until
      // message finalization, and the version is not yet managed-visible.
      await expect(service.openVersion(identity, fixture.versionId)).rejects.toMatchObject({
        code: 'VERSION_NOT_FOUND'
      })

      const lease = await service.openUnpublishedVersion(identity, fixture.versionId)
      try {
        await expect(lease.readRange(0, lease.size)).resolves.toEqual(new Uint8Array(fixture.bytes))
        expect(lease.version.checksum).toBe(checksum(fixture.bytes))
        expect(lease.logicalFile.sessionId).toBe('session-1')
        await lease.verifyUnchanged()
      } finally {
        await lease.close()
      }
    })

    it('rejects an incomplete staging write for artifacts and uploads', async () => {
      const artifactFixture = await createPendingAgentPlanFixture()
      await client.artifactVersion.update({
        where: { id: artifactFixture.versionId },
        data: { state: 'staging' }
      })
      await client.uploadFile.create({
        data: {
          id: 'upload-file-1',
          projectId: 'project-1',
          sessionId: 'session-1',
          filename: 'notes.md',
          originalFilename: 'notes.md'
        }
      })
      const uploadBytes = Buffer.from('staging bytes\n')
      const uploadKey =
        'uploads/project-1/session-1/upload-file-1/versions/upload-staging-v1/content'
      await mkdir(dirname(join(storageRoot, ...uploadKey.split('/'))), { recursive: true })
      await writeFile(join(storageRoot, ...uploadKey.split('/')), uploadBytes)
      await client.uploadVersion.create({
        data: {
          id: 'upload-staging-v1',
          uploadFileId: 'upload-file-1',
          versionNumber: 1,
          state: 'staging',
          originKind: 'legacy',
          basedOnVersionId: null,
          contentStorageKey: uploadKey,
          filename: 'notes.md',
          originalFilename: 'notes.md',
          contentType: 'text/markdown',
          sizeBytes: BigInt(uploadBytes.byteLength),
          checksum: checksum(uploadBytes)
        }
      })
      const service = new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client)
      })

      await expect(
        service.openUnpublishedVersion(
          { source: 'artifact', projectId: 'project-1', fileId: artifactFixture.fileId },
          artifactFixture.versionId
        )
      ).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' })
      await expect(
        service.openUnpublishedVersion(
          { source: 'upload', projectId: 'project-1', fileId: 'upload-file-1' },
          'upload-staging-v1'
        )
      ).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' })
    })

    it('rejects a version owned by another file', async () => {
      const other = await createFixture('artifact')
      const fixture = await createPendingAgentPlanFixture()
      const service = new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client)
      })

      await expect(
        service.openUnpublishedVersion(
          { source: 'artifact', projectId: 'project-1', fileId: fixture.fileId },
          other.versionIds[0]
        )
      ).rejects.toMatchObject({ code: 'VERSION_NOT_IN_FILE' })
    })

    it('reports version identity before write state on both read paths', async () => {
      // A legacy-origin staging version owned by another file: identity must win over state so
      // the published path keeps its historical error precedence.
      const owned = await createFixture('artifact')
      await client.artifactLineage.create({
        data: {
          id: 'foreign-lineage',
          projectId: 'project-1',
          sessionId: 'session-1',
          normalizedFilename: 'foreign.json',
          filename: 'foreign.json'
        }
      })
      const foreignBytes = Buffer.from('foreign\n')
      const foreignKey = 'artifacts/project-1/session-1/foreign-lineage/versions/foreign-v1/content'
      await mkdir(dirname(join(storageRoot, ...foreignKey.split('/'))), { recursive: true })
      await writeFile(join(storageRoot, ...foreignKey.split('/')), foreignBytes)
      await client.artifactVersion.create({
        data: {
          id: 'foreign-v1',
          artifactId: 'foreign-lineage',
          versionNumber: 1,
          filename: 'foreign.json',
          originKind: 'legacy',
          basedOnVersionId: null,
          state: 'staging',
          contentStorageKey: foreignKey,
          contentType: 'application/json',
          sizeBytes: BigInt(foreignBytes.byteLength),
          checksum: checksum(foreignBytes)
        }
      })
      const service = new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client)
      })
      const identity = {
        source: 'artifact' as const,
        projectId: 'project-1',
        fileId: owned.fileId
      }

      await expect(service.openVersion(identity, 'foreign-v1')).rejects.toMatchObject({
        code: 'VERSION_NOT_IN_FILE'
      })
      await expect(service.openUnpublishedVersion(identity, 'foreign-v1')).rejects.toMatchObject({
        code: 'VERSION_NOT_IN_FILE'
      })
    })

    it('reads a finalized published version through the same path', async () => {
      const fixture = await createPendingAgentPlanFixture()
      const now = new Date('2026-09-01T00:00:00.000Z')
      await client.artifactVersion.update({
        where: { id: fixture.versionId },
        data: { state: 'finalized', managedVisibleAt: now }
      })
      await client.artifactLineage.update({
        where: { id: fixture.fileId },
        data: { currentVersionId: fixture.versionId }
      })
      const service = new ManagedFileVersionService({
        storageRoot,
        getClient: () => Promise.resolve(client)
      })

      const lease = await service.openUnpublishedVersion(
        { source: 'artifact', projectId: 'project-1', fileId: fixture.fileId },
        fixture.versionId
      )
      try {
        await expect(lease.readRange(0, lease.size)).resolves.toEqual(new Uint8Array(fixture.bytes))
      } finally {
        await lease.close()
      }
    })
  })
})
