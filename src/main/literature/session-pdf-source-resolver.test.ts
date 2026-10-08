import { describe, expect, it, vi } from 'vitest'

import { SessionPdfSourceResolver } from './session-pdf-source-resolver'
import type { PdfDocumentSource } from '../../shared/pdf-bookmarks'
import { createUploadVersionReference } from '../../shared/uploads'
import { createArtifactVersionLocator } from '../../shared/artifact-provenance'

describe('SessionPdfSourceResolver', () => {
  const workspace = (kind: 'upload-version' | 'artifact-version'): PdfDocumentSource => ({
    kind,
    projectId: 'project',
    sourceFileId: 'file',
    versionId: 'version',
    sessionId: 'origin-session',
    checksum: 'a'.repeat(64),
    name: 'renderer-name.pdf',
    path: '/renderer/untrusted.pdf'
  })

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const workspaceResolver = (kind: 'upload-version' | 'artifact-version') => {
    const version = {
      projectId: 'project',
      sourceKind: kind,
      sourceFileId: 'file',
      inputFileVersionId: 'version',
      sourceSessionId: 'origin-session',
      filename: 'managed.pdf',
      contentType: 'application/pdf',
      sizeBytes: 42,
      checksum: 'a'.repeat(64),
      storageKey: 'managed/content.pdf'
    }
    const lease = { verifyUnchanged: vi.fn(), close: vi.fn() }
    const inputs = {
      resolveVersion: vi.fn().mockResolvedValue(version),
      openContent: vi.fn().mockResolvedValue(lease)
    }
    const resolver = new SessionPdfSourceResolver({
      inputs,
      literature: { resolveVersion: vi.fn(), openContent: vi.fn() }
    } as never)
    return { resolver, inputs, version, lease }
  }

  it.each(['upload-version', 'artifact-version'] as const)(
    'verifies and canonicalizes %s without opening a renderer-supplied path',
    async (kind) => {
      const h = workspaceResolver(kind)
      const source = workspace(kind)
      await expect(h.resolver.resolveDocumentSource(source)).resolves.toEqual({
        ...source,
        name: 'managed.pdf',
        path:
          kind === 'upload-version'
            ? createUploadVersionReference('version', {
                projectId: 'project',
                sessionId: 'origin-session',
                fileId: 'file'
              })
            : createArtifactVersionLocator({
                projectId: 'project',
                appSessionId: 'origin-session',
                artifactId: 'file',
                versionId: 'version'
              })
      })
      expect(h.inputs.resolveVersion).toHaveBeenCalledWith({
        projectId: 'project',
        sourceKind: kind,
        inputFileVersionId: 'version',
        expectedSourceFileId: 'file'
      })
      expect(h.inputs.openContent).toHaveBeenCalledWith(h.version)
      expect(h.lease.verifyUnchanged).toHaveBeenCalledOnce()
      expect(h.lease.close).toHaveBeenCalledOnce()
    }
  )

  it.each([
    { sourceFileId: 'other-file' },
    { inputFileVersionId: 'other-version' },
    { sourceKind: 'artifact-version' },
    { sourceSessionId: 'other-session' },
    { checksum: 'b'.repeat(64) },
    { sizeBytes: 0 },
    { filename: 'report.txt', contentType: 'text/plain' }
  ])('rejects mismatched or unavailable workspace PDF metadata %j', async (change) => {
    const h = workspaceResolver('upload-version')
    h.inputs.resolveVersion.mockResolvedValue({ ...h.version, ...change })
    await expect(
      h.resolver.resolveDocumentSource(workspace('upload-version'))
    ).resolves.toBeUndefined()
    expect(h.inputs.openContent).not.toHaveBeenCalled()
  })

  it('closes the content lease when byte verification fails', async () => {
    const h = workspaceResolver('upload-version')
    h.lease.verifyUnchanged.mockRejectedValue(new Error('Version changed'))
    await expect(h.resolver.resolveDocumentSource(workspace('upload-version'))).rejects.toThrow(
      'Version changed'
    )
    expect(h.lease.close).toHaveBeenCalledOnce()
  })

  it('does not use a renderer path when the immutable version is unavailable', async () => {
    const h = workspaceResolver('upload-version')
    h.inputs.resolveVersion.mockResolvedValue(undefined)
    await expect(
      h.resolver.resolveDocumentSource(workspace('upload-version'))
    ).resolves.toBeUndefined()
    expect(h.inputs.openContent).not.toHaveBeenCalled()
  })

  it('resolves Literature bytes through the attachment authority without Notebook provenance', async () => {
    const resolveInputVersion = vi.fn()
    const resolveLiteratureVersion = vi.fn(async () => ({
      itemId: 'item-1',
      attachmentId: 'attachment-1',
      versionId: 'attachment-version-1',
      versionNumber: 1,
      filename: 'paper.pdf',
      contentType: 'application/pdf',
      sizeBytes: 42,
      checksum: 'a'.repeat(64),
      storageKey: 'content/aa/paper.pdf',
      path: '/managed/paper.pdf'
    }))
    const resolver = new SessionPdfSourceResolver({
      inputs: { resolveVersion: resolveInputVersion, openContent: vi.fn() },
      literature: { resolveVersion: resolveLiteratureVersion, openContent: vi.fn() }
    })

    await expect(
      resolver.resolveVersion({
        projectId: 'project-1',
        sourceKind: 'literature-attachment-version',
        sourceVersionId: 'attachment-version-1',
        expectedSourceFileId: 'attachment-1'
      })
    ).resolves.toEqual({
      sourceKind: 'literature-attachment-version',
      sourceFileId: 'attachment-1',
      sourceVersionId: 'attachment-version-1',
      filename: 'paper.pdf',
      contentType: 'application/pdf',
      sizeBytes: 42,
      checksum: 'a'.repeat(64),
      path: '/managed/paper.pdf',
      openContent: expect.any(Function)
    })
    expect(resolveInputVersion).not.toHaveBeenCalled()
  })

  it('rejects a Literature Version when the binding points at another attachment', async () => {
    const resolver = new SessionPdfSourceResolver({
      inputs: { resolveVersion: vi.fn(), openContent: vi.fn() },
      literature: {
        openContent: vi.fn(),
        resolveVersion: vi.fn(async () => ({
          itemId: 'item-1',
          attachmentId: 'attachment-2',
          versionId: 'attachment-version-1',
          versionNumber: 1,
          filename: 'paper.pdf',
          contentType: 'application/pdf',
          sizeBytes: 42,
          checksum: 'a'.repeat(64),
          storageKey: 'content/aa/paper.pdf',
          path: '/managed/paper.pdf'
        }))
      }
    })

    await expect(
      resolver.resolveVersion({
        projectId: 'project-1',
        sourceKind: 'literature-attachment-version',
        sourceVersionId: 'attachment-version-1',
        expectedSourceFileId: 'attachment-1'
      })
    ).resolves.toBeUndefined()
  })
})
