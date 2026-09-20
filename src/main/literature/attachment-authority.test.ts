import type { PrismaClient } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'

import { LiteratureAttachmentAuthority } from './attachment-authority'

const checksum = 'a'.repeat(64)

describe('LiteratureAttachmentAuthority', () => {
  it('verifies the Content Blob before returning immutable attachment bytes', async () => {
    const findUnique = vi.fn(async () => ({
      id: 'attachment-version-1',
      attachmentId: 'attachment-1',
      versionNumber: 1,
      contentBlobId: 'blob-1',
      filename: 'paper.pdf',
      contentType: 'application/pdf',
      sizeBytes: 42n,
      checksum,
      pageCount: 14,
      attachment: { itemId: 'item-1', item: { deletedAt: null } },
      contentBlob: { storageKey: 'content/blobs/aa/blob-1' }
    }))
    const verify = vi.fn(async () => ({
      state: 'available' as const,
      content: {
        id: 'blob-1',
        path: '/managed/paper.pdf',
        storageKey: 'content/blobs/aa/blob-1',
        checksum,
        sizeBytes: 42n,
        contentType: 'application/pdf'
      }
    }))
    const authority = new LiteratureAttachmentAuthority({
      getClient: async () =>
        ({ literatureAttachmentVersion: { findUnique } }) as unknown as PrismaClient,
      content: { verify, openLease: vi.fn() }
    })

    await expect(authority.resolveVersion('attachment-version-1')).resolves.toEqual({
      itemId: 'item-1',
      attachmentId: 'attachment-1',
      versionId: 'attachment-version-1',
      versionNumber: 1,
      filename: 'paper.pdf',
      contentType: 'application/pdf',
      sizeBytes: 42,
      checksum,
      pageCount: 14,
      storageKey: 'content/blobs/aa/blob-1',
      path: '/managed/paper.pdf'
    })
    expect(verify).toHaveBeenCalledWith('blob-1')
  })

  it('does not expose attachments owned by a deleted Literature item', async () => {
    const verify = vi.fn()
    const authority = new LiteratureAttachmentAuthority({
      getClient: async () =>
        ({
          literatureAttachmentVersion: {
            findUnique: vi.fn(async () => ({
              attachment: { item: { deletedAt: new Date() } }
            }))
          }
        }) as unknown as PrismaClient,
      content: { verify, openLease: vi.fn() }
    })

    await expect(authority.resolveVersion('attachment-version-1')).resolves.toBeUndefined()
    expect(verify).not.toHaveBeenCalled()
  })
})
