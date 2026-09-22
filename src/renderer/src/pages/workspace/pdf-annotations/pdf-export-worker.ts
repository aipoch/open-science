import { exportAnnotatedPdf } from './pdf-export'
import type { PdfExportRequest } from './pdf-export-contract'

self.onmessage = async (event: MessageEvent<PdfExportRequest>): Promise<void> => {
  try {
    const data = await exportAnnotatedPdf(event.data)
    self.postMessage({ data }, { transfer: [data] })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'export-failed' })
  }
}
