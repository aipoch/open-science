import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { CsvPreviewRenderer } from '@/pages/workspace/previews/renderers/CsvPreview'
import { createManagedPreviewTestTransport } from '@/pages/workspace/previews/managed-preview-test-support'

const content = [
  Array.from({ length: 13 }, (_, i) => `group${i + 1}`).join(','),
  ...Array.from({ length: 100 }, (_, row) =>
    Array.from({ length: 13 }, (_, col) => `${row + col}.123456789`).join(',')
  )
].join('\n')
const transport = createManagedPreviewTestTransport({
  read: async () => ({ content, encoding: 'utf8', size: content.length, truncated: false })
})
window.api = { previewResources: transport } as unknown as typeof window.api
window.fetch = transport.fetch
initI18n('en')
createRoot(document.getElementById('root')!).render(
  <div style={{ width: 640, height: 540, margin: 24 }}>
    <CsvPreviewRenderer
      item={{
        id: 'csv-scroll',
        type: 'file',
        title: 'data.csv',
        name: 'data.csv',
        path: 'artifact://data.csv',
        format: 'csv',
        source: 'artifact',
        projectId: 'project-1',
        sessionId: 'session-1',
        managedFileId: 'csv-scroll',
        selectedVersionId: 'version-1'
      }}
    />
  </div>
)
