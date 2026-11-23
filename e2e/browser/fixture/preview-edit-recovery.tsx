import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { PreviewFileSurface } from '@/pages/workspace/PreviewFileSurface'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { createManagedPreviewTestTransport } from '@/pages/workspace/previews/managed-preview-test-support'
import type { ManagedFileVersionSaveTextEditRequest } from '../../../src/shared/managed-file-versions'
import type { Annotation } from '../../../src/shared/annotation-contract'
import type { DocumentConversationRequest } from '@/pages/workspace/previews/preview-types'

const locale = new URLSearchParams(location.search).get('locale') === 'zh-Hans' ? 'zh-Hans' : 'en'
const text = new URLSearchParams(location.search).has('footnotes')
  ? '# Scroll preview\n\n' +
    'A paragraph before the end.\n\n'.repeat(100) +
    'Document end[^1]\n\n[^1]: Final footnote.\n'
  : new URLSearchParams(location.search).has('features')
    ? '# Current\n\n' +
      Array.from({ length: 24 }, (_, index) => `Paragraph ${index + 1} for scrolling.\n\n`).join(
        ''
      ) +
      'Choose this passage for formatting.\n'
    : new URLSearchParams(location.search).has('table')
      ? '|项目|内容|\n|---|---|\n|统计|样本 *t* 检验|\n'
      : new URLSearchParams(location.search).has('multi')
        ? '第一段包含**重点**。\n\n第二段继续说明。\n'
        : '# Current\n'
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
  canEdit: !new URLSearchParams(location.search).has('footnotes'),
  canDiff: false,
  text,
  textFormat: { hasUtf8Bom: false, newline: 'lf', hasTrailingNewline: true }
}
const transport = createManagedPreviewTestTransport({
  read: async () => ({ content: text, encoding: 'utf8', size: text.length, truncated: false })
})
const saves: ManagedFileVersionSaveTextEditRequest[] = []
const requests: DocumentConversationRequest[] = []
const annotations: Annotation[] = []
Object.assign(window, { previewEditRecovery: { saves, requests, annotations } })
let deliver: ((event: { handle: string; markdown: string }) => void) | undefined
window.api = {
  markdownEdits: {
    open: async () => 'fixture-selection',
    close: async () => {},
    onReplacement: (listener: typeof deliver) => {
      deliver = listener
      return () => {
        deliver = undefined
      }
    }
  },
  previewResources: transport,
  managedFileVersions: {
    inspect: async () => ({ ok: true, value: inspect }),
    saveTextEdit: async (request: ManagedFileVersionSaveTextEditRequest) => {
      saves.push(request)
      if (new URLSearchParams(location.search).has('success')) {
        const saved = {
          ...version,
          id: `v${saves.length + 1}`,
          versionNumber: saves.length + 1
        }
        inspect.headVersionId = saved.id
        inspect.selectedVersionId = saved.id
        inspect.text = request.content
        inspect.versions = [...inspect.versions, saved]
        return { ok: true, value: { kind: 'created', version: saved, headVersionId: saved.id } }
      }
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
void Promise.resolve(prepareI18nLocale(locale)).then(() => {
  initI18n(locale)
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
        onSendDocumentRequest={async (request) => {
          requests.push(request)
          if (request.text.includes('fixture-selection')) {
            deliver?.({ handle: 'fixture-selection', markdown: 'Revised **evidence**' })
          }
          return true
        }}
        onAddAnnotation={(annotation) => {
          if (new URLSearchParams(location.search).has('reject-selection'))
            return 'visual-model-required'
          annotations.push(annotation)
          return undefined
        }}
      />
    </main>
  )
})
