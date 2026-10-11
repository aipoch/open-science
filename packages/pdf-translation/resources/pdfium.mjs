/* eslint-disable @typescript-eslint/explicit-function-return-type -- Unbundled Node worker JavaScript. */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import { readFile } from 'node:fs/promises'
import { init } from '@embedpdf/pdfium'
export async function engine() {
  const p = await init({
    // PDFium's Emscripten environment encodes the program name as ASCII. It is a
    // logical WASM label, not a host path; a Unicode worker path otherwise aborts.
    thisProgram: 'open-science-pdf-translation',
    wasmBinary: await readFile(require.resolve('@embedpdf/pdfium/pdfium.wasm'))
  })
  p.PDFiumExt_Init()
  const m = p.pdfium,
    alloc = (n) => m.wasmExports.malloc(n),
    free = (n) => m.wasmExports.free(n)
  const bytes = (b) => {
    const at = alloc(b.length)
    m.HEAPU8.set(b, at)
    return at
  }
  const readText = (obj, t) => {
    const n = p.FPDFTextObj_GetText(obj, t, 0, 0),
      at = alloc(n)
    try {
      p.FPDFTextObj_GetText(obj, t, at, n)
      return Buffer.from(m.HEAPU8.slice(at, at + n))
        .toString('utf16le')
        .replace(/\0$/, '')
    } finally {
      free(at)
    }
  }
  const bounds = (obj) => {
    const at = alloc(16)
    try {
      if (!p.FPDFPageObj_GetBounds(obj, at, at + 4, at + 8, at + 12)) throw Error('bounds')
      return Array.from(m.HEAPF32.slice(at / 4, at / 4 + 4))
    } finally {
      free(at)
    }
  }
  const save = (doc, flags = 2) => {
    const fw = p.PDFiumExt_OpenFileWriter()
    try {
      if (!p.FPDF_SaveAsCopy(doc, fw, flags)) throw Error('save')
      const n = p.PDFiumExt_GetFileWriterSize(fw),
        at = alloc(n)
      try {
        p.PDFiumExt_GetFileWriterData(fw, at, n)
        return m.HEAPU8.slice(at, at + n)
      } finally {
        free(at)
      }
    } finally {
      p.PDFiumExt_CloseFileWriter(fw)
    }
  }
  return {
    p,
    m,
    alloc,
    free,
    bytes,
    bounds,
    save,
    open(data) {
      const at = bytes(data),
        doc = p.FPDF_LoadMemDocument(at, data.length, 0)
      if (!doc) {
        free(at)
        throw Error('load')
      }
      return {
        doc,
        close() {
          p.FPDF_CloseDocument(doc)
          free(at)
        }
      }
    },
    objects(page) {
      const text = p.FPDFText_LoadPage(page)
      try {
        return Array.from({ length: p.FPDFPage_CountObjects(page) }, (_, i) => {
          const obj = p.FPDFPage_GetObject(page, i),
            type = p.FPDFPageObj_GetType(obj)
          return {
            i,
            obj,
            type,
            bounds: bounds(obj),
            text: type === 1 ? readText(obj, text) : undefined
          }
        })
      } finally {
        p.FPDFText_ClosePage(text)
      }
    }
  }
}
