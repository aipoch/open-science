import { describe, expect, it } from 'vitest'

import type { LiteratureItemView } from '../../../../shared/literature'
import { literatureReadingDocument } from '../literature/literature-reading'
import { createPreviewFileItemFromPdfContext } from './preview-file-item'
import { literatureItemToPdfOption } from './literature-pdf-options'
import { resolvePdfContextTarget } from './use-pdf-context-action'

const literatureItem = {
  id: 'literature-item-1',
  metadataRevision: 1,
  item: {
    title: 'Exact sources',
    creators: [],
    identifiers: []
  },
  attachments: [
    {
      id: 'attachment-1',
      kind: 'fullText',
      versions: [
        {
          id: 'literature-version-1',
          versionNumber: 1,
          filename: 'exact.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1024,
          pageCount: 2,
          createdAt: 1,
          availability: 'available'
        }
      ]
    }
  ]
} as unknown as LiteratureItemView

describe('literature PDF source identity', () => {
  it('retains the attachment ID through picker and reading preview adapters', () => {
    const option = literatureItemToPdfOption(literatureItem)
    expect(option?.source).toEqual({
      sourceKind: 'literature-attachment-version',
      sourceFileId: 'attachment-1',
      sourceVersionId: 'literature-version-1'
    })

    const reading = literatureReadingDocument(literatureItem)
    expect(reading?.item.managedFileId).toBe('attachment-1')
    expect(reading?.item.selectedVersionId).toBe('literature-version-1')
    expect(reading?.source).toEqual(option?.source)
    expect(resolvePdfContextTarget(reading!.item)).toEqual(option?.source)

    const durable = createPreviewFileItemFromPdfContext(
      {
        version: 1,
        bindingId: 'binding-1',
        sourceKind: 'literature-attachment-version',
        sourceFileId: 'attachment-1',
        sourceVersionId: 'literature-version-1',
        name: 'exact.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        checksum: 'a'.repeat(64),
        linkedAt: 2
      },
      'project-1'
    )
    expect({
      id: reading!.item.id,
      path: reading!.item.path,
      source: reading!.item.source,
      managedFileId: reading!.item.managedFileId,
      selectedVersionId: reading!.item.selectedVersionId,
      name: reading!.item.name,
      mimeType: reading!.item.mimeType,
      size: reading!.item.size
    }).toEqual({
      id: durable.id,
      path: durable.path,
      source: durable.source,
      managedFileId: durable.managedFileId,
      selectedVersionId: durable.selectedVersionId,
      name: durable.name,
      mimeType: durable.mimeType,
      size: durable.size
    })
  })

  it('does not invent a literature attachment identity from a Version locator', () => {
    expect(
      resolvePdfContextTarget({
        ...literatureReadingDocument(literatureItem)!.item,
        managedFileId: undefined
      })
    ).toEqual({
      sourceKind: 'literature-attachment-version',
      sourceVersionId: 'literature-version-1'
    })
  })
})
