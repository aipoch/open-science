import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { MANAGED_TEXT_EDIT_MAX_BYTES } from '../../shared/managed-file-versions'
import { ManagedFileVersionError, ManagedFileVersionService } from './service'

const checksum = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const testPublish = (
  _rootPath: string,
  parentPath: string,
  sourceName: string,
  destinationName: string
): void => {
  linkSync(join(parentPath, sourceName), join(parentPath, destinationName))
  unlinkSync(join(parentPath, sourceName))
}
const testWriteAndPublish = (
  rootPath: string,
  parentPath: string,
  temporaryName: string,
  destinationName: string,
  bytes: Buffer
): void => {
  mkdirSync(parentPath, { recursive: true })
  writeFileSync(join(parentPath, temporaryName), bytes)
  testPublish(rootPath, parentPath, temporaryName, destinationName)
}

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
    'resolves the %s DB head by default and an explicit owned historical version exactly',
    async (source) => {
      const fixture = await createFixture(source)
      const service = new ManagedFileVersionService({
        storageRoot,
        writeAndPublish: testWriteAndPublish,
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
        service.resolve({
          source,
          projectId: 'project-1',
          fileId: fixture.fileId,
          versionId: `${source}-other-version`
        })
      ).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' })
    }
  )

  it.each(['artifact', 'upload'] as const)(
    'keeps the verified %s inode pinned when its storage path is replaced before consumption',
    async (source) => {
      const fixture = await createFixture(source)
      const service = new ManagedFileVersionService({
        storageRoot,
        writeAndPublish: testWriteAndPublish,
        getClient: () => Promise.resolve(client),
        nativeWriteAvailable: true,
        verifyAnchored: (_rootPath, parentPath, name, expectedSizeBytes, expectedChecksum) => {
          const bytes = readFileSync(join(parentPath, name))
          return bytes.byteLength === expectedSizeBytes && checksum(bytes) === expectedChecksum
        }
      })
      const lease = await service.openResolved({
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
        writeAndPublish: testWriteAndPublish,
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
      writeAndPublish: testWriteAndPublish,
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
      writeAndPublish: testWriteAndPublish,
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
    const service = new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client),
      readAnchored: () => {
        readAttempts += 1
        renameSync(versionsPath, `${versionsPath}-replaced`)
        symlinkSync(outsideRoot!, versionsPath, process.platform === 'win32' ? 'junction' : 'dir')
        throw Object.assign(new Error('anchored parent changed'), { code: 'ELOOP' })
      }
    })

    await expect(
      service.inspect({ source: 'upload', projectId: 'project-1', fileId: fixture.fileId })
    ).rejects.toMatchObject({ code: 'CONTENT_INTEGRITY_FAILED' })
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
    const service = new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client),
      readAnchored: () => {
        readAttempts += 1
        renameSync(versionsPath, `${versionsPath}-replaced`)
        symlinkSync(outsideRoot!, versionsPath, process.platform === 'win32' ? 'junction' : 'dir')
        throw Object.assign(new Error('anchored parent changed'), { code: 'ELOOP' })
      }
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
    ).rejects.toMatchObject({ code: 'CONTENT_INTEGRITY_FAILED' })
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
    let bodyReads = 0
    const service = new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client),
      readAnchored: () => {
        bodyReads += 1
        throw new Error('large body must not be read')
      }
    })

    await expect(
      service.inspect({ source: 'upload', projectId: 'project-1', fileId: fixture.fileId })
    ).resolves.toMatchObject({
      canEdit: false,
      canDiff: false,
      unavailableReason: 'EDIT_LIMIT_EXCEEDED'
    })
    expect(bodyReads).toBe(0)
  })

  it('maps an atomic bounded-read overflow to EDIT_LIMIT_EXCEEDED', async () => {
    const fixture = await createFixture('upload')
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      readAnchoredBounded: () => {
        throw Object.assign(new Error('bounded read overflow'), { code: 'EFBIG' })
      }
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
      writeAndPublish: testWriteAndPublish,
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
    const service = new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client),
      createId: () => 'artifact-racing-v3',
      createStorageTag: () => 'vrace0001',
      durability: {
        syncFile: () => Promise.resolve(),
        syncDirectory: async () => {
          if (hidBaseline) return
          hidBaseline = true
          await client.artifactVersion.update({
            where: { id: fixture.versionIds[1] },
            data: { managedVisibleAt: null }
          })
        }
      }
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
      const service = new ManagedFileVersionService({
        storageRoot,
        writeAndPublish: testWriteAndPublish,
        getClient: () => Promise.resolve(client),
        createId: () => `${source}-v3`,
        createStorageTag: () => 'va1b2c3d4'
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
      const resolved = await service.resolve({
        source,
        projectId: 'project-1',
        fileId: fixture.fileId
      })
      expect(resolved.version.id).toBe(`${source}-v3`)
      expect(resolved.version.storedFilename).toBe('va1b2c3d4_README.md')
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
        writeAndPublish: testWriteAndPublish,
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

  it.each([
    ['CONTAINS_NUL', 'unsafe\0content'],
    ['EDIT_LIMIT_EXCEEDED', 'x'.repeat(MANAGED_TEXT_EDIT_MAX_BYTES + 1)]
  ] as const)(
    'rejects normalized save bytes with %s before creating a journal',
    async (code, content) => {
      const fixture = await createFixture('upload')
      const service = new ManagedFileVersionService({
        storageRoot,
        writeAndPublish: testWriteAndPublish,
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
      getClient,
      nativeWriteAvailable: true
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
    let tag = 0
    const service = new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client),
      createId: () => `upload-v${++id}`,
      createStorageTag: () => `v0000000${++tag}`
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
  })

  it('retries a colliding physical storage tag without clobbering existing bytes', async () => {
    const fixture = await createFixture('artifact')
    const collidingKey = `artifacts/project-1/session-1/${fixture.fileId}/managed-versions/vaaaaaaaa_README.md`
    const collidingPath = join(storageRoot, ...collidingKey.split('/'))
    await mkdir(dirname(collidingPath), { recursive: true })
    await writeFile(collidingPath, 'do not replace')
    const tags = ['vaaaaaaaa', 'vbbbbbbbb']
    const service = new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client),
      createId: () => 'artifact-v3',
      createStorageTag: () => tags.shift()!
    })

    const result = await service.saveTextEdit({
      source: 'artifact',
      projectId: 'project-1',
      fileId: fixture.fileId,
      basedOnVersionId: fixture.versionIds[1],
      expectedHeadVersionId: fixture.versionIds[1],
      content: 'new bytes\n',
      operationId: 'artifact-collision-operation'
    })

    expect(result).toMatchObject({ kind: 'created' })
    await expect(
      service.resolve({
        source: 'artifact',
        projectId: 'project-1',
        fileId: fixture.fileId
      })
    ).resolves.toMatchObject({ version: { storedFilename: 'vbbbbbbbb_README.md' } })
    await expect(readFile(collidingPath, 'utf8')).resolves.toBe('do not replace')
  })

  it('reallocates the journal destination when a no-clobber publication loses a filesystem race', async () => {
    const fixture = await createFixture('upload')
    const tags = ['vrace0001', 'vrace0002']
    let publicationAttempts = 0
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      createId: () => 'upload-v3',
      createStorageTag: () => tags.shift()!,
      writeAndPublish: (rootPath, parentPath, temporaryName, destinationName, bytes) => {
        publicationAttempts += 1
        if (publicationAttempts === 1) {
          throw Object.assign(new Error('simulated no-replace race'), { code: 'EEXIST' })
        }
        testWriteAndPublish(rootPath, parentPath, temporaryName, destinationName, bytes)
      }
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
    await expect(
      client.managedFileVersionWriteOperation.findUniqueOrThrow({
        where: { operationId: 'race-operation' }
      })
    ).resolves.toMatchObject({
      state: 'published',
      storageTag: 'vrace0002',
      storedFilename: 'vrace0002_README.md'
    })
  })

  it('does not delete an existing destination when every no-clobber publication collides', async () => {
    const fixture = await createFixture('upload')
    const tags = Array.from({ length: 16 }, (_, index) => `vcoll${String(index).padStart(4, '0')}`)
    const collidingPaths: string[] = []
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      createStorageTag: () => tags.shift()!,
      writeAndPublish: (_rootPath, parentPath, _temporaryName, destinationName) => {
        mkdirSync(parentPath, { recursive: true })
        const destinationPath = join(parentPath, destinationName)
        writeFileSync(destinationPath, 'existing bytes')
        collidingPaths.push(destinationPath)
        throw Object.assign(new Error('simulated no-replace collision'), { code: 'EEXIST' })
      }
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
      getClient: () => Promise.resolve(client),
      createStorageTag: () => 'vsymlink1',
      writeAndPublish: () => {
        throw Object.assign(new Error('anchored publisher rejected symlink'), { code: 'ELOOP' })
      }
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
    ).rejects.toMatchObject({ code: 'ELOOP' })

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
    let directorySyncCount = 0
    const service = new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client),
      createId: () => 'upload-v3',
      createStorageTag: () => 'vreplay01',
      durability: {
        syncFile: () => Promise.resolve(),
        syncDirectory: async () => {
          directorySyncCount += 1
          if (directorySyncCount === 1) {
            signalFirstAfterPublish()
            await firstMayContinue
          }
        }
      }
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
    const resolved = await service.resolve({
      source: 'upload',
      projectId: 'project-1',
      fileId: fixture.fileId
    })
    await expect(readFile(resolved.path, 'utf8')).resolves.toBe('one durable publication\n')
  })

  it('replays the original published result after a later head and rejects corrupt result bytes', async () => {
    const fixture = await createFixture('upload')
    const tags = ['vreplay02', 'vreplay03']
    const ids = ['upload-v3', 'upload-v4']
    const service = new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client),
      createId: () => ids.shift()!,
      createStorageTag: () => tags.shift()!
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
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client),
      readAnchored: (_rootPath, parentPath, name) => {
        if (parentPath.endsWith('/versions/upload-v2')) {
          throw new Error('published replay must not read the baseline')
        }
        return Buffer.from(readFileSync(join(parentPath, name)))
      }
    })
    expect(publishedVersion.storedFilename).not.toBe('content')
    await expect(replayWithoutBaseline.saveTextEdit(firstRequest)).resolves.toMatchObject({
      kind: 'created',
      headVersionId: 'upload-v3',
      version: { id: 'upload-v3' },
      replayed: true
    })
    const original = await service.resolve({
      source: 'upload',
      projectId: 'project-1',
      fileId: fixture.fileId,
      versionId: 'upload-v3'
    })
    await writeFile(original.path, 'corrupt')
    await expect(service.saveTextEdit(firstRequest)).rejects.toMatchObject({
      code: 'CONTENT_INTEGRITY_FAILED'
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
      writeAndPublish: testWriteAndPublish,
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
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client),
      createId: () => 'upload-v3',
      createStorageTag: () => 'vcrash001',
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
      writeAndPublish: testWriteAndPublish,
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

  it('publishes an intact deterministic temp left before rename instead of failing recovery', async () => {
    const fixture = await createFixture('upload')
    const crashing = new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client),
      createStorageTag: () => 'vtmprec01',
      testFaultAt: 'after-journal'
    })
    await expect(
      crashing.saveTextEdit({
        source: 'upload',
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        content: 'recover deterministic temp\n',
        operationId: 'temp-before-rename-operation'
      })
    ).rejects.toThrow()
    const operation = await client.managedFileVersionWriteOperation.findUniqueOrThrow({
      where: { operationId: 'temp-before-rename-operation' }
    })
    const parentPath = dirname(join(storageRoot, ...operation.contentStorageKey.split('/')))
    const operationDigest = createHash('sha256')
      .update('temp-before-rename-operation')
      .digest('hex')
      .slice(0, 16)
    const tempName = `.${operation.storedFilename}.${operationDigest}.tmp`
    await mkdir(parentPath, { recursive: true })
    const relativeParentPath = relative(storageRoot, parentPath)
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
          const binding = require(process.argv[1])
          binding.writeAndPublishNoReplace(
            process.argv[2],
            process.argv[3],
            process.argv[4],
            process.argv[5],
            Buffer.from('recover deterministic temp\\n')
          )
        `,
        join(process.cwd(), 'packages/safe-file-publisher-native'),
        storageRoot,
        relativeParentPath,
        tempName,
        operation.storedFilename
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: 'test',
          VITEST: 'true',
          OPEN_SCIENCE_NATIVE_TEST_HOOKS: '1',
          OPEN_SCIENCE_TEST_EXIT_AFTER_DURABLE_TEMP: '86'
        },
        stdio: 'ignore'
      }
    )
    const childExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, rejectExit) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL')
          rejectExit(new Error('durable-temp child timed out'))
        }, 5_000)
        child.once('exit', (code, signal) => {
          clearTimeout(timeout)
          resolveExit({ code, signal })
        })
        child.once('error', rejectExit)
      }
    )
    expect(childExit).toEqual({ code: 86, signal: null })
    await expect(readFile(join(parentPath, tempName), 'utf8')).resolves.toBe(
      'recover deterministic temp\n'
    )
    await expect(readFile(join(parentPath, operation.storedFilename))).rejects.toMatchObject({
      code: 'ENOENT'
    })

    const recovered = new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client),
      createId: () => 'upload-temp-recovered-v3'
    })
    await expect(recovered.recoverPendingWrites()).resolves.toMatchObject({
      recovered: 1,
      failed: 0
    })
  })

  it('keeps a transient recovery read failure pending for the next startup retry', async () => {
    const fixture = await createFixture('upload')
    const crashing = new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client),
      createStorageTag: () => 'vtrans001',
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

    const retryable = new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client),
      readAnchored: () => {
        throw Object.assign(new Error('temporary filesystem outage'), { code: 'EIO' })
      }
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
        writeAndPublish: testWriteAndPublish,
        getClient: () => Promise.resolve(client),
        createId: () => 'artifact-v3',
        createStorageTag: () => `v${testFaultAt === 'after-temp-write' ? 'temp0001' : 'ready001'}`,
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
        writeAndPublish: testWriteAndPublish,
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
        writeAndPublish: testWriteAndPublish,
        getClient: () => Promise.resolve(client),
        createId: () => `${source}-v3`,
        createStorageTag: () => 'vdelete01',
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
        writeAndPublish: testWriteAndPublish,
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
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client),
      createStorageTag: () => 'vblocked1'
    })

    await expect(
      service.inspect({ source: 'upload', projectId: 'project-1', fileId: fixture.fileId })
    ).resolves.toMatchObject({ canEdit: false, unavailableReason: 'FILE_DELETED' })
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
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client)
    }).recoverPendingWrites()

    expect(await client.managedFile.count({ where: { sourceFileId: fixture.fileId } })).toBe(0)
  })

  it('does not expose a completed Artifact head before its Files projection becomes visible', async () => {
    const fixture = await createFixture('artifact')
    await client.managedFile.deleteMany({ where: { sourceFileId: fixture.fileId } })

    await new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
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
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client),
      createStorageTag: () => 'vjournal1',
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
      writeAndPublish: testWriteAndPublish,
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
    const terminalPath = join(
      storageRoot,
      'uploads/project-1/session-1',
      fixture.fileId,
      'managed-versions/vterminal_README.md'
    )
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
        storageTag: 'vterminal',
        storedFilename: 'vterminal_README.md',
        contentStorageKey: `uploads/project-1/session-1/${fixture.fileId}/managed-versions/vterminal_README.md`,
        checksum: checksum(Buffer.from('terminal cleanup\n')),
        sizeBytes: BigInt(Buffer.byteLength('terminal cleanup\n')),
        textFormatJson: format,
        errorCode: 'CONTENT_INTEGRITY_FAILED'
      }
    })

    const recovery = await new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
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
    await expect(readFile(terminalPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('marks corrupt staged publication bytes failed and never advances the head', async () => {
    const fixture = await createFixture('artifact')
    const crashing = new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client),
      createId: () => 'artifact-v3',
      createStorageTag: () => 'vcrash002',
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
      writeAndPublish: testWriteAndPublish,
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
      writeAndPublish: testWriteAndPublish,
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
      const contentStorageKey = `uploads/project-1/session-1/${fixture.fileId}/managed-versions/vcleanup1_README.md`
      const finalPath = join(storageRoot, ...contentStorageKey.split('/'))
      await mkdir(dirname(finalPath), { recursive: true })
      await writeFile(finalPath, 'orphan final\n')
      await client.managedFileVersionWriteOperation.create({
        data: {
          operationId: `${state}-cleanup-operation`,
          source: 'upload',
          projectId: 'project-1',
          sourceFileId: fixture.fileId,
          basedOnVersionId: fixture.versionIds[1],
          expectedHeadVersionId: fixture.versionIds[1],
          state,
          storageTag: 'vcleanup1',
          storedFilename: 'vcleanup1_README.md',
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
        writeAndPublish: testWriteAndPublish,
        getClient: () => Promise.resolve(client)
      }).recoverPendingWrites()

      await expect(readFile(finalPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(
        client.managedFileVersionWriteOperation.findUniqueOrThrow({
          where: { operationId: `${state}-cleanup-operation` }
        })
      ).resolves.toMatchObject({ state })
    }
  )

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
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client)
    }).recoverPendingWrites()

    await expect(readFile(finalPath, 'utf8')).resolves.toBe('foreign bytes\n')
  })

  it('removes only stale managed-version temporary files that have no journal', async () => {
    const fixture = await createFixture('artifact')
    const parentPath = join(
      storageRoot,
      'artifacts',
      'project-1',
      'session-1',
      fixture.fileId,
      'managed-versions'
    )
    await mkdir(parentPath, { recursive: true })
    const staleName = '.vorphan01_README.md.0123456789abcdef.tmp'
    const freshName = '.vfresh001_README.md.0123456789abcdef.tmp'
    await writeFile(join(parentPath, staleName), 'stale')
    await writeFile(join(parentPath, freshName), 'fresh')
    await utimes(join(parentPath, staleName), new Date(0), new Date(0))

    await new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client),
      now: () => new Date('2026-08-12T00:00:00.000Z')
    }).recoverPendingWrites()

    await expect(readFile(join(parentPath, staleName))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(parentPath, freshName), 'utf8')).resolves.toBe('fresh')
  })

  it('paginates file roots while preserving a stale temp with exact journal ownership', async () => {
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
    const storedFilename = 'vprotect1_100.txt'
    const operationId = 'protected-temp-operation'
    const digest = createHash('sha256').update(operationId).digest('hex').slice(0, 16)
    const protectedTemp = `.${storedFilename}.${digest}.tmp`
    const orphanTemp = '.vorphan02_100.txt.0123456789abcdef.tmp'
    const lastParent = join(
      storageRoot,
      'uploads',
      'project-1',
      'session-1',
      last.id,
      'managed-versions'
    )
    await mkdir(lastParent, { recursive: true })
    await writeFile(join(lastParent, protectedTemp), 'protected')
    await writeFile(join(lastParent, orphanTemp), 'orphan')
    await utimes(join(lastParent, protectedTemp), new Date(0), new Date(0))
    await utimes(join(lastParent, orphanTemp), new Date(0), new Date(0))
    await client.managedFileVersionWriteOperation.create({
      data: {
        operationId,
        source: 'upload',
        projectId: 'project-1',
        sourceFileId: last.id,
        basedOnVersionId: `${last.id}-v1`,
        expectedHeadVersionId: `${last.id}-v1`,
        state: 'published',
        storageTag: 'vprotect1',
        storedFilename,
        contentStorageKey: `uploads/project-1/session-1/${last.id}/managed-versions/${storedFilename}`,
        checksum: checksum(Buffer.from('protected')),
        sizeBytes: BigInt(Buffer.byteLength('protected')),
        textFormatJson: JSON.stringify({
          hasUtf8Bom: false,
          newline: 'lf',
          hasTrailingNewline: false
        }),
        resultVersionId: `${last.id}-v1`
      }
    })

    const transactionSpy = vi.spyOn(client, '$transaction')
    await new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client),
      now: () => new Date('2026-08-13T00:00:00.000Z')
    }).recoverPendingWrites()

    await expect(readFile(join(lastParent, protectedTemp), 'utf8')).resolves.toBe('protected')
    await expect(readFile(join(lastParent, orphanTemp))).rejects.toMatchObject({ code: 'ENOENT' })
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

  it('fails closed when stale temporary-file recovery encounters a replaced symlink parent', async () => {
    const fixture = await createFixture('artifact')
    outsideRoot = await mkdtemp(join(tmpdir(), 'open-science-managed-version-outside-'))
    const fileRoot = join(storageRoot, 'artifacts', 'project-1', 'session-1', fixture.fileId)
    const originalRoot = `${fileRoot}-original`
    await mkdir(join(fileRoot, 'managed-versions'), { recursive: true })
    await rename(fileRoot, originalRoot)
    await symlink(outsideRoot, fileRoot)
    await writeFile(join(outsideRoot, '.vorphan01_README.md.0123456789abcdef.tmp'), 'outside')

    await expect(
      new ManagedFileVersionService({
        storageRoot,
        writeAndPublish: testWriteAndPublish,
        getClient: () => Promise.resolve(client),
        now: () => new Date('2026-08-12T00:00:00.000Z')
      }).recoverPendingWrites()
    ).rejects.toMatchObject({ code: 'ELOOP' })
    await expect(
      readFile(join(outsideRoot, '.vorphan01_README.md.0123456789abcdef.tmp'), 'utf8')
    ).resolves.toBe('outside')
  })

  it('rejects archived projects and corrupted completed head bytes with stable error codes', async () => {
    const fixture = await createFixture('artifact')
    const service = new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
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
    const resolved = await service.resolve({
      source: 'artifact',
      projectId: 'project-1',
      fileId: fixture.fileId
    })
    await writeFile(resolved.path, 'corrupt')
    await expect(
      service.inspect({ source: 'artifact', projectId: 'project-1', fileId: fixture.fileId })
    ).rejects.toMatchObject({ code: 'CONTENT_INTEGRITY_FAILED' })
  })

  it('reports an unsafe stable basename as ineligible instead of failing during save allocation', async () => {
    const fixture = await createFixture('upload')
    await client.uploadFile.update({
      where: { id: fixture.fileId },
      data: { filename: 'CON.md', originalFilename: 'CON.md' }
    })
    const service = new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client)
    })

    await expect(
      service.inspect({ source: 'upload', projectId: 'project-1', fileId: fixture.fileId })
    ).resolves.toMatchObject({ canEdit: false, unavailableReason: 'UNSAFE_FILENAME' })
  })

  it('keeps trusted reads available when anchored writes are unavailable', async () => {
    const fixture = await createFixture('upload')
    const service = new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client),
      nativeWriteAvailable: false,
      nativeReadFallbackAvailable: true,
      readAnchored: () => {
        throw Object.assign(new Error('anchored reads unavailable'), { code: 'ENOTSUP' })
      },
      verifyAnchored: () => {
        throw Object.assign(new Error('anchored verification unavailable'), { code: 'ENOTSUP' })
      }
    })

    await expect(
      service.inspect({ source: 'upload', projectId: 'project-1', fileId: fixture.fileId })
    ).resolves.toMatchObject({
      canEdit: false,
      canDiff: true,
      text: 'second\n',
      unavailableReason: 'NATIVE_WRITE_REQUIRED'
    })
    const lease = await service.openResolved({
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
        requestId: 'native-read-fallback'
      })
    ).resolves.toMatchObject({
      baseVersionId: fixture.versionIds[0],
      selectedVersionId: fixture.versionIds[1]
    })
    await expect(service.auditActiveVersionIntegrity()).resolves.toEqual([])
    const currentPath = await service.resolvePath({
      source: 'upload',
      projectId: 'project-1',
      fileId: fixture.fileId
    })
    await expect(readFile(currentPath.path, 'utf8')).resolves.toBe('second\n')
    await expect(
      service.resolve({ source: 'upload', projectId: 'project-1', fileId: fixture.fileId })
    ).rejects.toMatchObject({ code: 'NATIVE_WRITE_REQUIRED' })
    await expect(
      service.saveTextEdit({
        source: 'upload',
        projectId: 'project-1',
        fileId: fixture.fileId,
        basedOnVersionId: fixture.versionIds[1],
        expectedHeadVersionId: fixture.versionIds[1],
        content: 'blocked native write\n',
        operationId: 'native-write-unavailable'
      })
    ).rejects.toMatchObject({ code: 'NATIVE_WRITE_REQUIRED' })
  })

  it('fails closed when the native binding is unavailable rather than explicitly read-only', async () => {
    const fixture = await createFixture('upload')
    const service = new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client),
      nativeWriteAvailable: false,
      nativeReadFallbackAvailable: false
    })

    await expect(
      service.inspect({ source: 'upload', projectId: 'project-1', fileId: fixture.fileId })
    ).resolves.toMatchObject({
      canEdit: false,
      canDiff: false,
      unavailableReason: 'NATIVE_WRITE_REQUIRED'
    })
    await expect(
      service.inspect({ source: 'upload', projectId: 'project-1', fileId: fixture.fileId })
    ).resolves.not.toHaveProperty('text')
    await expect(
      service.openResolved({
        source: 'upload',
        projectId: 'project-1',
        fileId: fixture.fileId
      })
    ).rejects.toMatchObject({ code: 'NATIVE_WRITE_REQUIRED' })
    await expect(
      service.diffText({
        source: 'upload',
        projectId: 'project-1',
        fileId: fixture.fileId,
        versionId: fixture.versionIds[1],
        requestId: 'missing-native-binding'
      })
    ).rejects.toMatchObject({ code: 'NATIVE_WRITE_REQUIRED' })
  })

  it('audits only active heads during startup and validates historical bytes lazily', async () => {
    const fixture = await createFixture('artifact')
    const historical = await new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client)
    }).resolve({
      source: 'artifact',
      projectId: 'project-1',
      fileId: fixture.fileId,
      versionId: fixture.versionIds[0]
    })
    await writeFile(historical.path, 'corrupt historical bytes')
    const service = new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
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
    ).rejects.toMatchObject({ code: 'CONTENT_INTEGRITY_FAILED' })
  })

  it('keeps blocking journal recovery separate from the explicit active-head integrity audit', async () => {
    const fixture = await createFixture('artifact')
    const service = new ManagedFileVersionService({
      storageRoot,
      writeAndPublish: testWriteAndPublish,
      getClient: () => Promise.resolve(client)
    })
    const head = await service.resolve({
      source: 'artifact',
      projectId: 'project-1',
      fileId: fixture.fileId
    })
    await writeFile(head.path, 'corrupt active head')

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
    const service = new ManagedFileVersionService({
      storageRoot,
      getClient: () => Promise.resolve(client),
      verifyAnchored: () => true,
      readAnchored: () => {
        throw new Error('audit must not allocate the file body')
      }
    })

    await expect(service.auditActiveVersionIntegrity()).resolves.toEqual([])
  })
})
