import { describe, expect, it, vi } from 'vitest'

import { SessionPdfSourceResolver } from './session-pdf-source-resolver'

describe('SessionPdfSourceResolver', () => {
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
