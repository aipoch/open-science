import '@/assets/main.css'
import { useState } from 'react'
import { PdfPreviewContent } from '@/pages/workspace/previews/renderers/PdfPreview'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { GlobalSearchDialog } from '@/components/global-search/GlobalSearchDialog'
import { LiteratureLibraryPage } from '@/pages/literature/LiteratureLibraryPage'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useTagStore } from '@/stores/tag-store'
import {
  literatureItemInputSchema,
  type LiteratureCatalogCommand
} from '../../../src/shared/literature'

initI18n('en')
const previewCase = new URLSearchParams(location.search).get('preview')
// A real, deterministic PDF exercises PDF.js rendering and wheel handling without disk IPC.
const content = `BT /F1 22 Tf 50 740 Td (Literature attachment preview) Tj
/F1 12 Tf 0 -40 Td (A stable dialog preserves the reference beneath it.) Tj
0 -30 Td (Scroll to read the rest of this document.) Tj ET`
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
]
let pdf = '%PDF-1.4\n'
const offsets = objects.map((object, index) => {
  const offset = pdf.length
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  return offset
})
const xref = pdf.length
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
const pdfBytes = new TextEncoder().encode(pdf)
const commands: LiteratureCatalogCommand[] = []
Object.assign(window, { modalLibrary: { commands } })
const reference = {
  id: 'audit-paper',
  metadataRevision: 1,
  item: literatureItemInputSchema.parse({
    title: previewCase ? 'Stable attachment preview' : 'Audit trashed reference',
    itemType: 'journalArticle'
  }),
  projectIds: [],
  collectionIds: [],
  attachments: previewCase
    ? [
        {
          id: 'attachment-1',
          kind: 'fullText',
          title: '',
          sortOrder: 0,
          createdAt: 1,
          updatedAt: 1,
          versions: [2, 1].map((versionNumber) => ({
            id: `version-${versionNumber}`,
            versionNumber,
            filename: versionNumber === 2 ? 'paper.pdf' : 'paper-v1.pdf',
            contentType: 'application/pdf',
            sizeBytes: pdfBytes.length,
            checksum: 'a'.repeat(64),
            createdAt: versionNumber
          }))
        }
      ]
    : [],
  createdAt: 1,
  updatedAt: 1,
  deletedAt: previewCase ? undefined : 1
}
window.api = {
  platform: 'darwin',
  sessions: { searchMessages: async () => ({ items: [], totalCount: 0, isComplete: true }) },
  projectFiles: {
    getOverview: async () => ({
      totalCount: 0,
      uploadCount: 0,
      artifactCount: 0,
      artifactGroupCount: 0,
      isIndexComplete: true
    }),
    searchArtifacts: async () => ({
      primary: { items: [], totalCount: 0 },
      other: [],
      isIndexComplete: true
    })
  },
  literature: {
    onChanged: () => () => {},
    get: async () => reference,
    search: async (request: { scope: string }) => ({
      entries: ['library', 'global-search'].includes(request.scope) ? [reference] : [],
      totalCount: ['library', 'global-search'].includes(request.scope) ? 1 : 0
    }),
    transact: async (command: LiteratureCatalogCommand) => {
      commands.push(command)
      return { kind: 'item', id: reference.id }
    },
    jobs: async () => ({ jobs: [], summaries: [] }),
    citationStyles: async () => ({ styles: [] })
  },
  previewResources: {
    acquire: async () => ({
      id: 'pdf',
      url: '',
      size: pdfBytes.length,
      mimeType: 'application/pdf',
      version: 1
    }),
    readRange: async ({ begin, end }: { begin: number; end: number }) => ({
      begin,
      end,
      total: pdfBytes.length,
      data: pdfBytes.slice(begin, end)
    }),
    release: async () => {}
  },
  tags: {
    snapshot: async () => ({ revision: 1, tags: [], assignments: [] }),
    onChanged: () => () => {}
  }
} as unknown as Window['api']
useNavigationStore.setState({ view: 'library' })
useProjectStore.setState({ projects: [], isLoaded: true })
useTagStore.setState({ status: 'ready', revision: 1, tags: [], assignments: [] })
export const AreaSelectionPreview = (): React.JSX.Element => {
  const [removed, setRemoved] = useState(false)
  const source = {
    kind: 'upload-version' as const,
    projectId: 'selection-project',
    sessionId: 'selection-session',
    versionId: 'version-2',
    name: 'paper.pdf',
    path: 'upload-version:version-2',
    checksum: 'a'.repeat(64)
  }
  return (
    <div style={{ height: '100vh' }}>
      <PdfPreviewContent
        path={source.path}
        name={source.name}
        source="upload"
        projectId={source.projectId}
        sessionId={source.sessionId}
        managedFileId="selection-upload"
        selectedVersionId={source.versionId}
        pdfEvidenceSource={source}
        annotationProps={{
          item: {
            id: 'selection-upload',
            title: source.name,
            type: 'file',
            format: 'pdf',
            source: 'upload',
            ...source
          },
          activeAnnotations: removed
            ? []
            : [
                {
                  id: 'selection-area',
                  kind: 'pdf',
                  target: 'agent',
                  source,
                  selector: {
                    kind: 'region',
                    pageNumber: 1,
                    pageRotation: 0,
                    rect: { x: 50 / 612, y: 88 / 792, width: 85 / 612, height: 12 / 792 },
                    imageOmissionReason: 'session-budget'
                  }
                }
              ],
          onRemoveAnnotation: () => setRemoved(true)
        }}
      />
    </div>
  )
}
createRoot(document.getElementById('root')!).render(
  previewCase === 'area-selection' ? (
    <AreaSelectionPreview />
  ) : previewCase === 'search' ? (
    <GlobalSearchDialog open onOpenChange={() => {}} isSessionPersistenceReady />
  ) : (
    <LiteratureLibraryPage />
  )
)
