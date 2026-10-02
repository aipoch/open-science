import '@/assets/main.css'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { PdfPreviewRenderer } from '@/pages/workspace/previews/renderers/PdfPreview'
import type {
  ParsePdfStructureRequest,
  PdfStructureResult
} from '../../../src/shared/pdf-structure'

// Real PDF.js preview and production reader UI; extraction/IPC are controlled fixtures.
const content =
  'BT /F1 22 Tf 50 740 Td (Uploaded PDF) Tj /F1 12 Tf 0 -40 Td (Sample    Value) Tj 0 -20 Td (A             42) Tj ET'
const navigationFixture = new URLSearchParams(location.search).has('navigation')
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  navigationFixture
    ? '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>'
    : '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
]
if (navigationFixture) objects.push(objects[2])
let pdf = '%PDF-1.4\n'
const offsets = objects.map((object, index) => {
  const offset = pdf.length
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  return offset
})
const xref = pdf.length
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
const bytes = new TextEncoder().encode(pdf)
const result: PdfStructureResult = {
  schemaVersion: 1,
  extractionId: '00000000-0000-4000-8000-000000000001',
  engineFingerprint: 'a'.repeat(64),
  sourceChecksum: 'b'.repeat(64),
  sourceSizeBytes: bytes.length,
  pageCount: 1,
  requestedPages: [1],
  processedPages: [1],
  pages: [{ page: 1, width: 612, height: 792, rotation: 0 }],
  elements: [
    {
      id: 'table-1',
      kind: 'table',
      regions: [{ page: 1, x: 0.08, y: 0.1, width: 0.3, height: 0.1 }],
      caption: {
        text: 'Table 1. Uploaded results',
        regions: [{ page: 1, x: 0.08, y: 0.08, width: 0.3, height: 0.02 }]
      },
      issues: [],
      table: {
        rowCount: 2,
        columnCount: 2,
        cells: ['Sample', 'Value', 'A', '42'].map((text, index) => ({
          row: Math.floor(index / 2),
          column: index % 2,
          rowSpan: 1,
          columnSpan: 1,
          text,
          regions: []
        })),
        issues: [],
        unassignedText: []
      }
    }
  ],
  thumbnails: [],
  navigation: [],
  issues: []
}
const audit = { requests: [] as ParsePdfStructureRequest[] }
Object.assign(window, { uploadedPdfAudit: audit })
let cached: PdfStructureResult | undefined
window.api = {
  previewResources: {
    acquire: async () => ({
      id: 'uploaded-pdf',
      url: '',
      size: bytes.length,
      mimeType: 'application/pdf',
      version: 1
    }),
    readRange: async ({ begin, end }: { begin: number; end: number }) => ({
      begin,
      end,
      total: bytes.length,
      data: bytes.slice(begin, end)
    }),
    release: async () => {}
  },
  localModels: {
    getSnapshot: async () => ({
      availability: 'ready',
      installedRevision: 'v1',
      updateAvailable: false
    })
  },
  pdfStructure: {
    readCached: async () => cached,
    parse: async (request: ParsePdfStructureRequest) => {
      if (!('source' in request) || request.source.sourceKind !== 'upload-version')
        throw new Error('Expected an uploaded version')
      audit.requests.push(request)
      cached = result
      return result
    },
    cancel: async () => {}
  }
} as unknown as Window['api']

export const Fixture = (): React.JSX.Element => {
  const [open, setOpen] = useState(true)
  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center gap-4 border-b p-3">
        <span>Finalized upload · no Agent binding · read-only notes</span>
        <button onClick={() => setOpen(!open)}>{open ? 'Close preview' : 'Open preview'}</button>
      </header>
      {open ? (
        <div className="min-h-0 flex-1">
          <PdfPreviewRenderer
            readOnly
            item={{
              id: 'upload-file',
              title: 'upload.pdf',
              name: 'upload.pdf',
              type: 'file',
              format: 'pdf',
              source: 'upload',
              projectId: 'project',
              sessionId: 'source-session',
              managedFileId: 'file',
              selectedVersionId: 'version',
              path: 'upload-version:project/source-session/file/version'
            }}
          />
        </div>
      ) : null}
    </main>
  )
}
initI18n('en')
createRoot(document.getElementById('root')!).render(<Fixture />)
