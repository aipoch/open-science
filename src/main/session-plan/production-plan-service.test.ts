import { describe, expect, it, vi } from 'vitest'

import { readManagedArtifactVersion } from './production-plan-service'

describe('readManagedArtifactVersion', () => {
  it('reads an exact Artifact Version, including an unpublished one, through a lease and closes it', async () => {
    const bytes = Buffer.from('{"schema_version":1}')
    const close = vi.fn().mockResolvedValue(undefined)
    const verifyUnchanged = vi.fn().mockResolvedValue(undefined)
    const openUnpublishedVersion = vi.fn().mockResolvedValue({
      size: bytes.byteLength,
      logicalFile: { sessionId: 'session-1' },
      version: { checksum: 'a'.repeat(64) },
      readRange: vi.fn().mockResolvedValue(new Uint8Array(bytes)),
      verifyUnchanged,
      close
    })

    await expect(
      readManagedArtifactVersion({ openUnpublishedVersion } as never, {
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactId: 'artifact-1',
        artifactVersionId: 'version-2'
      })
    ).resolves.toEqual({ content: '{"schema_version":1}', checksum: 'a'.repeat(64) })

    expect(openUnpublishedVersion).toHaveBeenCalledWith(
      { source: 'artifact', projectId: 'project-1', fileId: 'artifact-1' },
      'version-2'
    )
    expect(verifyUnchanged).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects a Version owned by another Session and still closes its lease', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    const openUnpublishedVersion = vi.fn().mockResolvedValue({
      size: 2,
      logicalFile: { sessionId: 'session-2' },
      version: { checksum: 'b'.repeat(64) },
      readRange: vi.fn(),
      verifyUnchanged: vi.fn(),
      close
    })

    await expect(
      readManagedArtifactVersion({ openUnpublishedVersion } as never, {
        projectId: 'project-1',
        sessionId: 'session-1',
        artifactId: 'artifact-1',
        artifactVersionId: 'version-2'
      })
    ).rejects.toThrow(/different Session/i)
    expect(close).toHaveBeenCalledOnce()
  })
})
