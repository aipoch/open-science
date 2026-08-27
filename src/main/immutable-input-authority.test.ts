import { describe, expect, it, vi } from 'vitest'

import { ImmutableInputAuthority } from './immutable-input-authority'

describe('ImmutableInputAuthority', () => {
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
})
