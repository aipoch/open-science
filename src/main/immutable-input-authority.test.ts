import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookRunInputFile } from '../shared/notebook'
import { ImmutableInputAuthority } from './immutable-input-authority'
import { ManagedFileVersionError } from './managed-file-versions/error'
import type { ResolvedManagedFileVersion } from './managed-file-versions/read-port'

const identityRecord = (): ResolvedManagedFileVersion => ({
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
    state: 'ready',
    originKind: 'legacy',
    basedOnVersionId: null,
    storageTag: null,
    storedFilename: null,
    writeOperationId: null,
    contentStorageKey: 'uploads/project-1/session-1/upload-1/upload-version-1/content',
    filename: 'stored.csv',
    originalFilename: 'upload.csv',
    contentType: 'text/csv',
    sizeBytes: 8n,
    checksum: 'a'.repeat(64),
    createdAt: new Date('2026-08-26T00:00:00.000Z')
  }
})

const inputIdentity = (): NotebookRunInputFile => ({
  inputFileVersionId: 'upload-version-1',
  sourceKind: 'upload-version',
  sourceFileId: 'upload-1',
  sourceVersionNumber: 1,
  sourceCreatedAt: '2026-08-26T00:00:00.000Z',
  sourceProjectId: 'project-1',
  sourceSessionId: 'session-1',
  filename: 'upload.csv',
  contentType: 'text/csv',
  sizeBytes: 8,
  checksum: 'a'.repeat(64),
  storageKey: 'uploads/project-1/session-1/upload-1/upload-version-1/content',
  association: 'turn-attached'
})

describe('ImmutableInputAuthority', () => {
  let storageRoot: string | undefined

  afterEach(async () => {
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  })

  it('validates identity through metadata without opening or verifying content', async () => {
    const resolveVersionIdentity = vi.fn().mockResolvedValue(identityRecord())
    const openVersion = vi.fn().mockRejectedValue(new Error('bytes must not be opened'))
    const authority = new ImmutableInputAuthority({
      storageRoot: '/storage',
      managedFileVersions: { openVersion, resolveVersionIdentity }
    })

    await expect(authority.validateIdentity('project-1', inputIdentity())).resolves.toEqual({
      state: 'available',
      input: inputIdentity()
    })
    expect(resolveVersionIdentity).toHaveBeenCalledExactlyOnceWith(
      { source: 'upload', projectId: 'project-1', fileId: 'upload-1' },
      'upload-version-1'
    )
    expect(openVersion).not.toHaveBeenCalled()
    await expect(authority.validateIdentity('another-project', inputIdentity())).resolves.toEqual({
      state: 'project-mismatch'
    })
    expect(resolveVersionIdentity).toHaveBeenCalledOnce()
  })

  it.each([
    { sourceFileId: 'another-file' },
    { sourceSessionId: 'another-session' },
    { sourceVersionNumber: 2 },
    { storageKey: 'another/key' },
    { checksum: 'b'.repeat(64) },
    { sizeBytes: 9 }
  ])('rejects changed immutable identity metadata %j', async (changed) => {
    const openVersion = vi.fn()
    const authority = new ImmutableInputAuthority({
      storageRoot: '/storage',
      managedFileVersions: {
        openVersion,
        resolveVersionIdentity: vi.fn().mockResolvedValue(identityRecord())
      }
    })
    await expect(
      authority.validateIdentity('project-1', { ...inputIdentity(), ...changed })
    ).resolves.toEqual({ state: 'identity-mismatch' })
    expect(openVersion).not.toHaveBeenCalled()
  })

  it('rejects resolved metadata owned by another Project', async () => {
    const resolved = identityRecord()
    resolved.logicalFile.projectId = 'another-project'
    const authority = new ImmutableInputAuthority({
      storageRoot: '/storage',
      managedFileVersions: {
        openVersion: vi.fn(),
        resolveVersionIdentity: vi.fn().mockResolvedValue(resolved)
      }
    })
    await expect(authority.validateIdentity('project-1', inputIdentity())).resolves.toEqual({
      state: 'identity-mismatch'
    })
  })

  it.each(['FILE_NOT_FOUND', 'FILE_DELETED', 'VERSION_NOT_FOUND', 'VERSION_NOT_IN_FILE'] as const)(
    'keeps metadata resolution failures unavailable for %s',
    async (code) => {
      const openVersion = vi.fn()
      const authority = new ImmutableInputAuthority({
        storageRoot: '/storage',
        managedFileVersions: {
          openVersion,
          resolveVersionIdentity: vi.fn().mockRejectedValue(new ManagedFileVersionError(code, code))
        }
      })
      await expect(authority.validateIdentity('project-1', inputIdentity())).resolves.toEqual({
        state: 'unavailable'
      })
      expect(openVersion).not.toHaveBeenCalled()
    }
  )

  it('propagates unexpected metadata errors without falling back to byte access', async () => {
    const error = new ManagedFileVersionError('INVALID_REQUEST', 'invalid identity')
    const openVersion = vi.fn()
    const authority = new ImmutableInputAuthority({
      storageRoot: '/storage',
      managedFileVersions: {
        openVersion,
        resolveVersionIdentity: vi.fn().mockRejectedValue(error)
      }
    })
    await expect(authority.validateIdentity('project-1', inputIdentity())).rejects.toBe(error)
    expect(openVersion).not.toHaveBeenCalled()
  })

  it('keeps legacy read ports strict when metadata resolution is absent', async () => {
    const verifyUnchanged = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const openVersion = vi.fn().mockResolvedValue({ ...identityRecord(), verifyUnchanged, close })
    const authority = new ImmutableInputAuthority({
      storageRoot: '/storage',
      managedFileVersions: { openVersion }
    })
    await expect(authority.validateIdentity('project-1', inputIdentity())).resolves.toEqual({
      state: 'available',
      input: inputIdentity()
    })
    expect(verifyUnchanged).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()

    await expect(
      authority.validateIdentity('project-1', { ...inputIdentity(), checksum: 'c'.repeat(64) })
    ).resolves.toEqual({ state: 'identity-mismatch' })
    expect(verifyUnchanged).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledTimes(2)

    const error = new ManagedFileVersionError('CONTENT_INTEGRITY_FAILED', 'missing bytes')
    openVersion.mockRejectedValueOnce(error)
    await expect(authority.validateIdentity('project-1', inputIdentity())).rejects.toBe(error)
    expect(openVersion).toHaveBeenCalledTimes(3)
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
