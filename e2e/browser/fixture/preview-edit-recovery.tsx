import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { PreviewFileSurface } from '@/pages/workspace/PreviewFileSurface'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { createManagedPreviewTestTransport } from '@/pages/workspace/previews/managed-preview-test-support'
import type { ManagedFileVersionSaveTextEditRequest } from '../../../src/shared/managed-file-versions'

initI18n('en')
const text = '# Current\n'
const version = {
  id: 'v1',
  source: 'upload' as const,
  fileId: 'file',
  versionNumber: 1,
  displayName: 'README.md',
  originKind: 'user_upload' as const,
  basedOnVersionId: null,
  contentType: 'text/markdown',
  sizeBytes: text.length,
  checksum: '1',
  createdAt: '2026-09-10T00:00:00.000Z'
}
const inspect = {
  source: 'upload',
  projectId: 'project',
  fileId: 'file',
  sessionId: 'standalone-uploads',
  displayName: 'README.md',
  headVersionId: 'v1',
  selectedVersionId: 'v1',
  versions: [version],
  canEdit: true,
  canDiff: false,
  text,
  textFormat: { hasUtf8Bom: false, newline: 'lf', hasTrailingNewline: true }
}
const transport = createManagedPreviewTestTransport({
  read: async () => ({ content: text, encoding: 'utf8', size: text.length, truncated: false })
})
const saves: ManagedFileVersionSaveTextEditRequest[] = []
Object.assign(window, { previewEditRecovery: { saves } })
window.api = {
  previewResources: transport,
  managedFileVersions: {
    inspect: async () => ({ ok: true, value: inspect }),
    saveTextEdit: async (request: ManagedFileVersionSaveTextEditRequest) => {
      saves.push(request)
      return {
        ok: true,
        value: {
          kind: 'conflict',
          expectedHeadVersionId: 'v1',
          actualHead: { ...version, id: 'v2', versionNumber: 2 }
        }
      }
    }
  }
} as unknown as typeof window.api
window.fetch = transport.fetch
usePreviewWorkbenchStore.getState().activateProject('project')
createRoot(document.getElementById('root')!).render(
  <main style={{ height: '100vh' }}>
    <PreviewFileSurface
      item={{
        id: 'upload:file',
        managedFileId: 'file',
        selectedVersionId: 'v1',
        projectId: 'project',
        sessionId: 'standalone-uploads',
        type: 'file',
        title: 'README.md',
        name: 'README.md',
        path: 'upload-version:project/standalone-uploads/v1',
        format: 'markdown',
        source: 'upload'
      }}
      onClose={() => {}}
    />
  </main>
)
