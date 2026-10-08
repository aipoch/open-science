import * as core from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url'
import cancellationSource from './pdf-worker-cancellation.js?raw'

// Ship Adobe character maps with both renderers. Some embedded CJK fonts have
// no ToUnicode map; without these resources PDF.js silently omits their text.
const characterMaps = import.meta.glob<string>(
  '../../../../../../node_modules/pdfjs-dist/cmaps/*.bcmap',
  { eager: true, query: '?url', import: 'default' }
)
const characterMapUrls = new Map(
  Object.entries(characterMaps).map(([path, url]) => [
    path
      .split('/')
      .at(-1)!
      .replace(/\.bcmap$/, ''),
    url
  ])
)
class BundledCMapReaderFactory {
  async fetch({
    name
  }: {
    name: string
  }): Promise<{ cMapData: Uint8Array; isCompressed: boolean }> {
    const url = characterMapUrls.get(name)
    if (!url) throw new Error('Unknown PDF character map.')
    const response = await fetch(url)
    if (!response.ok) throw new Error('Could not load PDF character map.')
    return { cMapData: new Uint8Array(await response.arrayBuffer()), isCompressed: true }
  }
}
const getDocument: typeof core.getDocument = (source) => {
  const options =
    typeof source === 'string' || source instanceof URL
      ? { url: source }
      : source instanceof ArrayBuffer || ArrayBuffer.isView(source)
        ? { data: source }
        : source
  return core.getDocument({
    CMapReaderFactory: BundledCMapReaderFactory,
    useWorkerFetch: false,
    ...options
  })
}
const pdfjsLib = { ...core, getDocument }

// pdf_viewer.mjs expects the core library on this global. Its import is deferred by PdfPreview
// until after this module has initialized, which also keeps test collection from evaluating the
// viewer against an empty global.
;(globalThis as typeof globalThis & { pdfjsLib?: typeof pdfjsLib }).pdfjsLib = pdfjsLib

// Vite rewrites this to the bundled worker URL, so pdfjs runs off the main thread in dev and prod.
// Configured once here and shared by the full preview and the thumbnail renderer.
pdfjsLib.GlobalWorkerOptions.workerSrc =
  typeof window !== 'undefined' && typeof Worker !== 'undefined'
    ? URL.createObjectURL(
        new Blob(
          [
            `export { WorkerMessageHandler } from ${JSON.stringify(new URL(pdfWorkerUrl, window.location.href).href)};\n`,
            cancellationSource
          ],
          { type: 'text/javascript' }
        )
      )
    : pdfWorkerUrl

export { pdfjsLib }
