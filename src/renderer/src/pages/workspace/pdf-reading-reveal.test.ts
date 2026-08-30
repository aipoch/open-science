// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'

import type { SessionPdfBinding } from '../../../../shared/session-persistence'

import { requestPdfReadingReveal, subscribePdfReadingReveal } from './pdf-reading-reveal'

const { previewItem, upsertAndActivateItem } = vi.hoisted(() => ({
  previewItem: { type: 'file', id: 'upload:file-1', path: 'upload-version://version-1' },
  upsertAndActivateItem: vi.fn()
}))

vi.mock('@/stores/preview-workbench-store', () => ({
  usePreviewWorkbenchStore: { getState: () => ({ upsertAndActivateItem }) }
}))
vi.mock('./preview-file-item', () => ({
  createPreviewFileItemFromPdfContext: () => previewItem
}))

const binding: SessionPdfBinding = {
  version: 1,
  bindingId: 'binding-1',
  sourceKind: 'upload-version',
  sourceFileId: 'file-1',
  sourceVersionId: 'version-1',
  sourceSessionId: 'session-1',
  name: 'paper.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  checksum: 'checksum-1',
  linkedAt: 1710000000000
}

beforeEach(() => upsertAndActivateItem.mockClear())

it('opens the captured PDF and delivers its page after the preview subscribes', () => {
  requestPdfReadingReveal('project-1', binding, 7)
  expect(upsertAndActivateItem).toHaveBeenCalledWith(previewItem)

  const listener = vi.fn(() => true)
  const unsubscribe = subscribePdfReadingReveal(listener)
  expect(listener).toHaveBeenCalledWith({
    projectId: 'project-1',
    path: previewItem.path,
    pageNumber: 7
  })
  unsubscribe()
})
