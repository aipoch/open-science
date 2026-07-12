import * as pdfjsLib from 'pdfjs-dist'

// Vite rewrites this to the bundled worker URL, so pdfjs runs off the main thread in dev and prod.
// Configured once here and shared by the full preview and the thumbnail renderer.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

// Decodes a base64 payload (from the read-bytes IPC) into the byte array pdfjs expects.
export const base64ToUint8Array = (base64: string): Uint8Array => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export { pdfjsLib }
