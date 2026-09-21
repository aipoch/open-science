import type { PdfAnnotation, PdfNativeImportReceipt } from '../../../../../shared/pdf-annotations'

export const PDF_EXPORT_MAX_BYTES = 128 * 1024 * 1024
export const PDF_EXPORT_MAX_MARKS = 20_000
export type PdfExportMark = {
  id: string
  kind: PdfAnnotation['kind']
  color: PdfAnnotation['color']
  note: string
  createdAt: string
  updatedAt: string
  pageNumber: number
  /** PDF user-space points in text top-left, top-right, bottom-left, bottom-right order. */
  quads: number[][]
}
export type PdfExportRequest = {
  data: ArrayBuffer
  checksum: string
  marks: PdfExportMark[]
  nativeRefs?: PdfNativeImportReceipt['nativeRefs']
}
