import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

// pdf_viewer.mjs expects the core library on this global. Its import is deferred by PdfPreview
// until after this module has initialized, which also keeps test collection from evaluating the
// viewer against an empty global.
;(globalThis as typeof globalThis & { pdfjsLib?: typeof pdfjsLib }).pdfjsLib = pdfjsLib

// Vite rewrites this to the bundled worker URL, so pdfjs runs off the main thread in dev and prod.
// Configured once here and shared by the full preview and the thumbnail renderer.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

export { pdfjsLib }
