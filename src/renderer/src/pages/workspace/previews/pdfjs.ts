import * as pdfjsLib from 'pdfjs-dist'

// Vite rewrites this to the bundled worker URL, so pdfjs runs off the main thread in dev and prod.
// Configured once here and shared by the full preview and the thumbnail renderer.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

export { pdfjsLib }
