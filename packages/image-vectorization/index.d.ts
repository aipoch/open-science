import type { PdfStructureOcr } from '@aipoch/pdf-structure'

export type ImageRegion = [number, number, number, number]

export type ImageExportDetail =
  | { mode: 'original'; reason: string }
  | {
      mode: 'hybrid'
      paths: { id: string; bounds: ImageRegion }[]
      maskedFills: { id: string; bounds: ImageRegion }[]
      sourceGroups: { id: string; bounds: ImageRegion[] }[]
    }

export function vectorizeImage(
  bytes: Buffer,
  options?: { ocr?: PdfStructureOcr; signal?: AbortSignal; preserveRegion?: ImageRegion }
): Promise<{
  mimeType: 'image/svg+xml' | 'image/png' | 'image/jpeg' | 'image/webp'
  content: Buffer
  detail: ImageExportDetail
}>
