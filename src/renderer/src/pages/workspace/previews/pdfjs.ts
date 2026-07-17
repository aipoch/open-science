import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

// Vite rewrites this to the bundled worker URL, so pdfjs runs off the main thread in dev and prod.
// Configured once here and shared by the full preview and the thumbnail renderer.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

export { pdfjsLib }
