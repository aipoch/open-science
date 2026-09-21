import type { PdfAnnotation, PdfAnnotationSource } from '../../../../../shared/pdf-annotations'

export const EMPTY_PDF_ANNOTATIONS: readonly PdfAnnotation[] = Object.freeze([])
export const pdfAnnotationSourceKey = (source: PdfAnnotationSource): string =>
  JSON.stringify([
    source.projectId,
    source.kind,
    source.sourceFileId,
    source.versionId,
    source.checksum
  ])

type DocumentIndex = {
  annotations: PdfAnnotation[]
  pages: Map<number, PdfAnnotation[]>
}

// Derived once per committed snapshot; all pages share it instead of scanning the Session list.
export const indexPdfAnnotations = (
  annotations: readonly PdfAnnotation[]
): Map<string, DocumentIndex> => {
  const documents = new Map<string, DocumentIndex>()
  for (const annotation of annotations) {
    const key = pdfAnnotationSourceKey(annotation.target.source)
    let document = documents.get(key)
    if (!document) {
      document = { annotations: [], pages: new Map() }
      documents.set(key, document)
    }
    document.annotations.push(annotation)
    const selector = annotation.target.selector
    if (selector.kind === 'document-note') continue
    let page = document.pages.get(selector.pageNumber)
    if (!page) {
      page = []
      document.pages.set(selector.pageNumber, page)
    }
    page.push(annotation)
  }
  return documents
}
