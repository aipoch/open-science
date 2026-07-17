import { describe, expect, it, vi } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'

import { OfficePreviewRenderer } from './renderers/OfficePreview'
import { renderPreviewFile } from './preview-registry'

vi.mock('./renderers/PdfPreview', () => ({ PdfPreviewRenderer: () => null }))

const createItem = (format: PreviewFileItem['format']): PreviewFileItem => ({
  id: `file-${format}`,
  sessionId: 'session-1',
  title: `sample.${format}`,
  type: 'file',
  source: 'artifact',
  path: `/artifacts/sample.${format}`,
  name: `sample.${format}`,
  format
})

describe('preview registry Office routing', () => {
  it.each(['word', 'spreadsheet', 'presentation'] as const)(
    'routes %s files to the Office renderer',
    (format) => {
      const rendered = renderPreviewFile({ item: createItem(format) })

      expect(rendered?.type).toBe(OfficePreviewRenderer)
    }
  )
})
