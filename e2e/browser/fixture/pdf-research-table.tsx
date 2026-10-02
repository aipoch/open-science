import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { PdfFiguresView } from '@/pages/workspace/previews/renderers/PdfFiguresView'
import type { PdfStructureResult } from '../../../src/shared/pdf-structure'

const cell = (
  row: number,
  column: number,
  text: string,
  rowSpan = 1,
  columnSpan = 1
): NonNullable<PdfStructureResult['elements'][number]['table']>['cells'][number] => ({
  row,
  column,
  text,
  rowSpan,
  columnSpan,
  regions: []
})
const result: PdfStructureResult = {
  schemaVersion: 1,
  extractionId: 'table-fixture',
  engineFingerprint: 'a'.repeat(64),
  sourceChecksum: 'b'.repeat(64),
  sourceSizeBytes: 1,
  pageCount: 1,
  requestedPages: [1],
  processedPages: [1],
  pages: [{ page: 1, width: 600, height: 800, rotation: 0 }],
  elements: [
    {
      id: 'table-1',
      kind: 'table',
      regions: [{ page: 1, x: 0, y: 0, width: 1, height: 1 }],
      caption: { text: 'Table 1. Biomarkers', regions: [] },
      issues: [],
      table: {
        rowCount: 6,
        columnCount: 6,
        cells: [
          cell(0, 0, '', 2, 2),
          cell(0, 2, 'CLDN18', 1, 2),
          cell(0, 4, 'Total', 2),
          cell(0, 5, 'P value', 2),
          cell(1, 2, 'Negative'),
          cell(1, 3, 'Positive'),
          cell(2, 0, 'FGFR2', 4),
          cell(2, 1, 'Negative', 2),
          cell(4, 1, 'Positive', 2),
          cell(2, 5, '0.077', 4),
          ...[
            ['237', '99', '336'],
            ['70.5%', '29.5%', '84.0%'],
            ['38', '26', '64'],
            ['59.4%', '40.6%', '16.0%']
          ].flatMap((values, row) => values.map((text, col) => cell(row + 2, col + 2, text)))
        ],
        unassignedText: [],
        issues: []
      }
    }
  ],
  thumbnails: [],
  navigation: [],
  issues: []
}
window.api = {
  localModels: { getSnapshot: async () => ({ models: [] }) },
  pdfStructure: { readCached: async () => result }
} as unknown as typeof window.api
if (new URLSearchParams(location.search).has('dark')) document.documentElement.classList.add('dark')
initI18n('en')
createRoot(document.getElementById('root')!).render(
  <main style={{ height: '100vh' }}>
    <PdfFiguresView
      source={{ attachmentVersionId: 'table-version' }}
      pageCount={1}
      onNavigate={() => {}}
    />
  </main>
)
