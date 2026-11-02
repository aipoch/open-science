import { createRequire } from 'node:module'
import { readFile, stat } from 'node:fs/promises'
import { init } from '@embedpdf/pdfium'
import type { PdfAnnotationSelector } from '../../shared/pdf-annotations'

export type PdfAnnotationGeometryInput = {
  filePath: string
  pageNumber: number
  quote?: string
  prefix?: string
  suffix?: string
}
export type PdfAnnotationGeometryResult = { selectors: PdfAnnotationSelector[]; truncated: boolean }
const unavailable = (): Error =>
  new Error('PDF_ANNOTATION_TARGET_UNAVAILABLE: The page or exact text cannot be located reliably.')
const normalize = (text: string): string => text.replace(/\s+/gu, ' ').trim()

// Runs only in the bounded worker. PDFium supplies actual selected-character rectangles;
// PDF.js supplies the same crop/rotation transform used by the reader.
export async function locatePdfAnnotationGeometry(
  input: PdfAnnotationGeometryInput
): Promise<PdfAnnotationGeometryResult> {
  if ((await stat(input.filePath)).size > 64 * 1024 * 1024) throw unavailable()
  const data = new Uint8Array(await readFile(input.filePath))
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const document = await pdfjs.getDocument({
    data: data.slice(),
    verbosity: 0,
    isEvalSupported: false
  }).promise
  try {
    if (
      !Number.isSafeInteger(input.pageNumber) ||
      input.pageNumber < 1 ||
      input.pageNumber > document.numPages
    )
      throw unavailable()
    const page = await document.getPage(input.pageNumber)
    const viewport = page.getViewport({ scale: 1 })
    const pageRotation = viewport.rotation
    if (![0, 90, 180, 270].includes(pageRotation)) throw unavailable()
    if (input.quote === undefined)
      return {
        selectors: [
          {
            kind: 'page-note',
            pageNumber: input.pageNumber,
            pageRotation: pageRotation as 0 | 90 | 180 | 270,
            coordinateVersion: 1
          }
        ],
        truncated: false
      }
    const overrides = {
      thisProgram: 'open-science-pdf-annotations',
      wasmBinary: new Uint8Array(
        await readFile(createRequire(import.meta.url).resolve('@embedpdf/pdfium/pdfium.wasm'))
      ).buffer
    }
    const p = await init(overrides)
    p.PDFiumExt_Init()
    const m = p.pdfium
    const at = m.wasmExports.malloc(data.length)
    m.HEAPU8.set(data, at)
    const doc = p.FPDF_LoadMemDocument(at, data.length, '')
    let nativePage = 0,
      textPage = 0,
      rectAt = 0
    try {
      if (!doc) throw unavailable()
      nativePage = p.FPDF_LoadPage(doc, input.pageNumber - 1)
      if (!nativePage) throw unavailable()
      textPage = p.FPDFText_LoadPage(nativePage)
      if (!textPage) throw unavailable()
      const count = p.FPDFText_CountChars(textPage)
      if (count < 1 || count > 200_000) throw unavailable()
      let text = ''
      const indices: number[] = []
      for (let i = 0; i < count; i++) {
        const code = p.FPDFText_GetUnicode(textPage, i)
        if (!code || code > 0x10ffff) throw unavailable()
        const char = String.fromCodePoint(code)
        if (/\s/u.test(char)) {
          if (text.endsWith(' ')) continue
          text += ' '
          indices.push(i)
        } else {
          text += char
          for (let unit = 0; unit < char.length; unit++) indices.push(i)
        }
      }
      const quote = normalize(input.quote)
      if (!quote) throw unavailable()
      const selectors: PdfAnnotationSelector[] = []
      rectAt = m.wasmExports.malloc(32)
      for (let start = text.indexOf(quote); start !== -1; start = text.indexOf(quote, start + 1)) {
        const end = start + quote.length
        if (input.prefix && !text.slice(0, start).trimEnd().endsWith(normalize(input.prefix)))
          continue
        if (input.suffix && !text.slice(end).trimStart().startsWith(normalize(input.suffix)))
          continue
        // Never select half a surrogate pair/native character.
        if (
          (start > 0 && indices[start - 1] === indices[start]) ||
          indices[end - 1] === indices[end]
        )
          continue
        const rectCount = p.FPDFText_CountRects(
          textPage,
          indices[start]!,
          indices[end - 1]! - indices[start]! + 1
        )
        if (rectCount < 1 || rectCount > 256) throw unavailable()
        const quads: Array<{ x: number; y: number; width: number; height: number }> = []
        for (let i = 0; i < rectCount; i++) {
          if (!p.FPDFText_GetRect(textPage, i, rectAt, rectAt + 8, rectAt + 16, rectAt + 24))
            throw unavailable()
          const [left, top, right, bottom] = Array.from(m.HEAPF64.slice(rectAt / 8, rectAt / 8 + 4))
          const box = viewport.convertToViewportRectangle([left!, bottom!, right!, top!])
          const x = Math.min(box[0]!, box[2]!) / viewport.width
          const y = Math.min(box[1]!, box[3]!) / viewport.height
          const x2 = Math.max(box[0]!, box[2]!) / viewport.width
          const y2 = Math.max(box[1]!, box[3]!) / viewport.height
          if (
            ![x, y, x2, y2].every(Number.isFinite) ||
            x < 0 ||
            y < 0 ||
            x2 > 1 ||
            y2 > 1 ||
            x2 <= x ||
            y2 <= y
          )
            throw unavailable()
          quads.push({ x, y, width: x2 - x, height: y2 - y })
        }
        if (selectors.length === 10) return { selectors, truncated: true }
        selectors.push({
          kind: 'text',
          pageNumber: input.pageNumber,
          exact: quote,
          prefix: text.slice(Math.max(0, start - 80), start),
          suffix: text.slice(end, end + 80),
          position: { start, end },
          quads,
          extractorVersion: 'pdfium-annotation-v1',
          pageRotation,
          coordinateVersion: 1
        })
      }
      return { selectors, truncated: false }
    } finally {
      if (rectAt) m.wasmExports.free(rectAt)
      if (textPage) p.FPDFText_ClosePage(textPage)
      if (nativePage) p.FPDF_ClosePage(nativePage)
      if (doc) p.FPDF_CloseDocument(doc)
      m.wasmExports.free(at)
      p.FPDF_DestroyLibrary()
    }
  } finally {
    await document.destroy()
  }
}
