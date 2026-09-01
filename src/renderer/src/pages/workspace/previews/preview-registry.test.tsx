import { describe, expect, it, vi } from 'vitest'

import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import type { Annotation } from '../../../../../shared/annotations'

import { OfficePreviewRenderer } from './renderers/OfficePreview'
import { PlanJsonPreview } from './renderers/PlanJsonPreview'
import { TiffPreviewRenderer } from './renderers/TiffPreview'
import { renderPreviewFile } from './preview-registry'

const { PdfPreviewRenderer } = vi.hoisted(() => ({ PdfPreviewRenderer: (): null => null }))
vi.mock('./renderers/PdfPreview', () => ({ PdfPreviewRenderer }))

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

  it('routes TIFF files to the TIFF renderer', () => {
    const rendered = renderPreviewFile({ item: createItem('tiff') })

    expect(rendered?.type).toBe(TiffPreviewRenderer)
  })

  it('routes JSON files through the Plan-aware JSON renderer', () => {
    const rendered = renderPreviewFile({ item: createItem('json') })

    expect(rendered?.type).toBe(PlanJsonPreview)
  })

  it('forwards the PDF reading-position observer to the PDF renderer', () => {
    const onPdfReadingPositionChange = vi.fn()

    const rendered = renderPreviewFile({
      item: createItem('pdf'),
      onPdfReadingPositionChange
    })

    expect(rendered?.props.onPdfReadingPositionChange).toBe(onPdfReadingPositionChange)
  })

  it('forwards annotation ports to the PDF renderer', () => {
    const activeAnnotations: Annotation[] = []
    const onAddAnnotation = vi.fn()

    const rendered = renderPreviewFile({
      item: createItem('pdf'),
      activeAnnotations,
      onAddAnnotation
    })

    expect(rendered?.type).toBe(PdfPreviewRenderer)
    expect(rendered?.props.activeAnnotations).toBe(activeAnnotations)
    expect(rendered?.props.onAddAnnotation).toBe(onAddAnnotation)
  })
})
