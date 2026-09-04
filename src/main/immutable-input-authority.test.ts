import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ImmutableInputAuthority } from './immutable-input-authority'

describe('ImmutableInputAuthority', () => {
  let storageRoot: string | undefined

  afterEach(async () => {
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  })

  it('resolves an exact Notebook input through a verified managed Version lease', async () => {
    const verifyUnchanged = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const openVersion = vi.fn().mockResolvedValue({
      path: '/managed/upload.csv',
      size: 8,
      logicalFile: {
        source: 'upload',
        id: 'upload-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        displayName: 'upload.csv',
        currentVersionId: 'upload-version-2'
      },
      version: {
        id: 'upload-version-1',
        fileId: 'upload-1',
        versionNumber: 1,
        contentStorageKey: 'uploads/project-1/session-1/upload-1/upload-version-1/content',
        filename: 'stored.csv',
        originalFilename: 'upload.csv',
        contentType: 'text/csv',
        sizeBytes: 8n,
        checksum: 'a'.repeat(64),
        createdAt: new Date('2026-08-26T00:00:00.000Z')
      },
      verifyUnchanged,
      close
    })
    const authority = new ImmutableInputAuthority({
      storageRoot: '/storage',
      managedFileVersions: { openVersion }
    } as never)

    await expect(
      authority.resolveVersion({
        projectId: 'project-1',
        sourceKind: 'upload-version',
        inputFileVersionId: 'upload-version-1',
        expectedSourceFileId: 'upload-1'
      })
    ).resolves.toMatchObject({
      inputFileVersionId: 'upload-version-1',
      sourceFileId: 'upload-1',
      sourceProjectId: 'project-1',
      sourceSessionId: 'session-1',
      filename: 'upload.csv',
      checksum: 'a'.repeat(64)
    })
    expect(openVersion).toHaveBeenCalledWith(
      { source: 'upload', projectId: 'project-1', fileId: 'upload-1' },
      'upload-version-1'
    )
    expect(verifyUnchanged).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('holds the exact managed Version lease until its Session staging copy is verified', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-immutable-input-authority-'))
    const events: string[] = []
    const content = 'verified input\n'
    const checksum = createHash('sha256').update(content).digest('hex')
    const close = vi.fn(async () => {
      events.push('close')
    })
    const openVersion = vi.fn().mockResolvedValue({
      path: '/managed/source.txt',
      size: Buffer.byteLength(content),
      logicalFile: {
        source: 'artifact',
        id: 'artifact-1',
        projectId: 'project-1',
        sessionId: 'source-session',
        displayName: 'source.txt',
        currentVersionId: 'artifact-version-2'
      },
      version: {
        id: 'artifact-version-1',
        fileId: 'artifact-1',
        versionNumber: 1,
        contentStorageKey: 'untrusted/storage/key',
        filename: 'source.txt',
        originalFilename: null,
        contentType: 'text/plain',
        sizeBytes: BigInt(Buffer.byteLength(content)),
        checksum,
        createdAt: new Date('2026-08-26T00:00:00.000Z')
      },
      copyTo: vi.fn(async (destinationPath: string) => {
        events.push('copy')
        await mkdir(dirname(destinationPath), { recursive: true })
        await writeFile(destinationPath, content)
      }),
      verifyUnchanged: vi.fn(async () => {
        events.push('verify')
      }),
      close
    })
    const authority = new ImmutableInputAuthority({
      storageRoot,
      managedFileVersions: { openVersion }
    } as never)

    const stagedPath = await authority.stageVersion({
      projectId: 'project-1',
      targetSessionId: 'target-session',
      sourceKind: 'artifact-version',
      inputFileVersionId: 'artifact-version-1',
      expectedSourceFileId: 'artifact-1'
    })

    await expect(readFile(stagedPath, 'utf8')).resolves.toBe(content)
    expect(stagedPath).toContain(join('notebook-inputs', 'project-1', 'target-session'))
    expect(events.at(-1)).toBe('close')
    expect(events).toContain('copy')
    expect(openVersion).toHaveBeenCalledWith(
      { source: 'artifact', projectId: 'project-1', fileId: 'artifact-1' },
      'artifact-version-1'
    )
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes the managed Version lease when Session staging fails', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-immutable-input-authority-'))
    const close = vi.fn().mockResolvedValue(undefined)
    const authority = new ImmutableInputAuthority({
      storageRoot,
      managedFileVersions: {
        openVersion: vi.fn().mockResolvedValue({
          logicalFile: {
            source: 'upload',
            id: 'upload-1',
            projectId: 'project-1',
            sessionId: 'source-session',
            displayName: 'source.csv',
            currentVersionId: 'upload-version-1'
          },
          version: {
            id: 'upload-version-1',
            fileId: 'upload-1',
            versionNumber: 1,
            contentStorageKey: 'untrusted/storage/key',
            filename: 'source.csv',
            originalFilename: 'source.csv',
            contentType: 'text/csv',
            sizeBytes: 8n,
            checksum: 'c'.repeat(64),
            createdAt: new Date('2026-08-26T00:00:00.000Z')
          },
          copyTo: vi.fn().mockRejectedValue(new Error('copy failed')),
          verifyUnchanged: vi.fn().mockResolvedValue(undefined),
          close
        })
      }
    } as never)

    await expect(
      authority.stageVersion({
        projectId: 'project-1',
        targetSessionId: 'target-session',
        sourceKind: 'upload-version',
        inputFileVersionId: 'upload-version-1',
        expectedSourceFileId: 'upload-1'
      })
    ).rejects.toThrow('copy failed')
    expect(close).toHaveBeenCalledOnce()
  })
})
