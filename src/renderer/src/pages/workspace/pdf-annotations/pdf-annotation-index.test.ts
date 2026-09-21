import { describe, expect, it } from 'vitest'
import type { PdfAnnotation } from '../../../../../shared/pdf-annotations'
import { indexPdfAnnotations, pdfAnnotationSourceKey } from './pdf-annotation-index'

const annotation = (id: string, pageNumber: number): PdfAnnotation => ({
  id,
  projectId: 'p',
  sessionId: 's',
  version: 1,
  origin: 'user',
  kind: 'page-note',
  tagIds: [],
  note: id,
  createdAt: '2026-09-19T00:00:00.000Z',
  updatedAt: '2026-09-19T00:00:00.000Z',
  target: {
    source: {
      kind: 'upload-version',
      projectId: 'p',
      sourceFileId: 'file',
      versionId: 'version',
      checksum: 'a'.repeat(64),
      name: 'paper.pdf',
      path: 'upload-version:version'
    },
    selector: { kind: 'page-note', coordinateVersion: 1, pageNumber, pageRotation: 0 }
  }
})

describe('PDF annotation page index', () => {
  it('preserves source order, separates pages and leaves document notes outside page overlays', () => {
    const first = annotation('a', 2)
    const second = annotation('b', 1)
    const document: PdfAnnotation = {
      ...annotation('c', 1),
      kind: 'document-note',
      target: {
        source: first.target.source,
        selector: { kind: 'document-note', coordinateVersion: 1 }
      }
    }
    const items = [first, second, document]
    const index = indexPdfAnnotations(items).get(pdfAnnotationSourceKey(first.target.source))!
    expect(index.annotations).toEqual(items)
    expect(index.pages.get(2)).toEqual([first])
    expect(index.pages.get(1)).toEqual([second])
    expect(index.pages.get(2)![0]).toBe(first)
  })
  it('keeps project, kind, file version and checksum boundaries exact', () => {
    const original = annotation('a', 1)
    const variants = [
      { projectId: 'other' },
      { kind: 'artifact-version' as const },
      { sourceFileId: 'other' },
      { versionId: 'other' },
      { checksum: 'b'.repeat(64) }
    ].map((change, i) => ({
      ...original,
      id: String(i),
      target: { ...original.target, source: { ...original.target.source, ...change } }
    }))
    const index = indexPdfAnnotations([original, ...variants])
    expect(index.size).toBe(6)
    expect(index.get(pdfAnnotationSourceKey(original.target.source))!.pages.get(1)).toEqual([
      original
    ])
  })
})
