import type { PreviewFileRendererProps } from '@/pages/workspace/previews/preview-types'
import '@/assets/main.css'
import { useState } from 'react'
import { useImageComposerHost } from '@/pages/workspace/image-edit/image-composer-bridge'
import { imageEditorScope } from '@/pages/workspace/image-edit/image-editor-state'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { PreviewFileContent } from '@/pages/workspace/previews/PreviewFileContent'
import { FilePreviewDialog } from '@/pages/workspace/FilePreviewDialog'
import { PreviewPanelSurface } from '@/pages/workspace/PreviewPanel'
import { useNavigationStore } from '@/stores/navigation-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { ImageEditingProvider } from '@/pages/workspace/image-edit/ImageEditingProvider'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'
import { createLinearConversationGraph } from '../../../src/shared/conversation-graph'
import type { ImageTask, ImageTaskStart } from '../../../src/shared/image-task'

initI18n('en')
const canvas = document.createElement('canvas')
canvas.width = 1200
canvas.height = 800
const ctx = canvas.getContext('2d')!
const picture = (fill: string): string => {
  ctx.fillStyle = '#faf8f1'
  ctx.fillRect(0, 0, 1200, 800)
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.arc(600, 360, 180, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#253340'
  ctx.font = '40px sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('Image editing study', 600, 660)
  return canvas.toDataURL('image/png')
}
const source = picture('#547c91')
const result = picture('#dfae4d')
let tasks: ImageTask[] = []
const requests: ImageTaskStart[] = []
const settings = {
  availableProviders: [],
  imageModel: { serviceId: '11111111-1111-4111-8111-111111111111', modelId: 'image-model' },
  services: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Image model',
      adapter: 'minimax',
      configured: true,
      models: [{ id: 'image-model', wireModelId: 'fixture-image', presetId: 'minimax-h3/official' }]
    }
  ]
}
window.api = {
  previewResources: {
    acquire: async (request: { versionId?: string }) => ({
      id: crypto.randomUUID(),
      url: request.versionId === 'v1' ? source : result,
      size: 20000,
      width: new URLSearchParams(location.search).has('noDimensions') ? undefined : 1200,
      height: new URLSearchParams(location.search).has('noDimensions') ? undefined : 800,
      mimeType: 'image/png',
      version: 1
    }),
    release: async () => undefined
  },
  reviewer: { onUpdated: () => () => {} },
  settings: { getImageModels: async () => settings },
  artifacts: {
    getLineage: async () => {
      if (!new URLSearchParams(location.search).has('versions')) return undefined
      const versions = [1, 2].map((versionNumber) => ({
        versionId: `v${versionNumber}`,
        versionNumber,
        artifactId: 'source',
        projectId: 'p',
        sessionId: 's',
        state: 'finalized',
        isPublished: true,
        name: 'source.png',
        mimeType: 'image/png',
        size: 20000
      }))
      return {
        versions,
        selectedVersion: versions[0],
        headVersion: versions[1],
        imageDependencies: []
      }
    },
    getVersionProvenance: async () => undefined
  },
  imageTasks: {
    list: async () => tasks,
    get: async ({ id }: { id: string }) => tasks.find((task) => task.id === id),
    start: async (request: ImageTaskStart) => {
      requests.push(request)
      const task: ImageTask = {
        ...request,
        state: 'running',
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      tasks = [task, ...tasks]
      return task
    },
    cancel: async ({ id }: { id: string }) => {
      tasks = tasks.map((task) =>
        task.id === id ? { ...task, state: 'cancelled', updatedAt: Date.now() } : task
      )
    }
  }
} as unknown as typeof window.api
Object.assign(window, {
  imageEditFixture: {
    requests,
    finish: () => {
      tasks = tasks.map((task) =>
        task.state === 'running'
          ? {
              ...task,
              state: 'succeeded',
              updatedAt: Date.now(),
              result: {
                artifactId: 'source',
                versionId: `v${requests.length + 1}`,
                versionNumber: requests.length + 1,
                name: 'edited.png',
                mimeType: 'image/png',
                size: 20000,
                checksum: 'a'.repeat(64)
              }
            }
          : task
      )
    }
  }
})
useSessionStore.setState({
  ...createInitialSessionState(),
  selectedSessionId: 's',
  sessions: [
    {
      id: 's',
      projectId: 'p',
      cwd: '/workspace',
      title: 'Image',
      status: 'idle',
      agentFrameworkId: 'codex',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      conversationGraph: createLinearConversationGraph({
        sessionId: 's',
        messages: [],
        createdAt: 1,
        updatedAt: 1
      })
    }
  ]
})
const fullSession = useSessionStore.getState().sessions[0]
window.api.sessions = { loadOne: async () => fullSession } as unknown as typeof window.api.sessions
if (new URLSearchParams(location.search).has('paged')) {
  useSessionStore.setState({
    sessions: [
      {
        ...fullSession,
        contentLoaded: false,
        conversationGraph: undefined,
        historyPage: {
          revision: 1,
          hasMore: true,
          totalItems: 150,
          messageBranchId: fullSession.conversationGraph?.branches[0]?.id
        }
      }
    ]
  })
}

const item: PreviewFileRendererProps['item'] = {
  id: 'source',
  type: 'file',
  format: 'image',
  source: 'artifact',
  projectId: 'p',
  sessionId: 's',
  artifactId: 'source',
  managedFileId: 'source',
  selectedVersionId: 'v1',
  versionNumber: 1,
  path: 'artifact-version:p/s/source/v1',
  name: 'source.png',
  title: 'source.png',
  mimeType: 'image/png'
}
const workbench = new URLSearchParams(location.search).has('workbench')
if (workbench) {
  useNavigationStore.setState({ activeProjectId: 'p' })
  usePreviewWorkbenchStore.getState().upsertAndActivateItem(item)
}

export function Layout(): React.JSX.Element {
  const preview = workbench ? (
    <PreviewPanelSurface onAddAnnotation={() => undefined} />
  ) : (
    <PreviewFileContent item={item} onAddAnnotation={() => undefined} />
  )
  const session = useSessionStore((state) => state.sessions[0])
  const { active, attachHost } = useImageComposerHost(imageEditorScope(session), true)
  const [draft, setDraft] = useState('Keep my conversation draft')
  const [expanded, setExpanded] = useState(false)
  if (!new URLSearchParams(location.search).has('conversation')) return preview
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '420px 1fr', height: '100%' }}>
      <section
        data-testid="conversation-pane"
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          padding: 16,
          borderRight: '1px solid #8884'
        }}
      >
        <div ref={attachHost} hidden={!active} />
        <textarea
          aria-label="Conversation draft"
          hidden={active}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </section>
      <section data-testid="preview-pane" style={{ minWidth: 0, minHeight: 0 }}>
        {new URLSearchParams(location.search).has('preview') ? (
          <button onClick={() => setExpanded(true)}>Open full screen preview</button>
        ) : null}
        {preview}
      </section>
      {expanded ? (
        <FilePreviewDialog
          item={item}
          onAddAnnotation={() => undefined}
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </div>
  )
}
createRoot(document.getElementById('root')!).render(
  <main style={{ height: '100vh', width: '100vw' }}>
    <ImageEditingProvider>
      <Layout />
    </ImageEditingProvider>
  </main>
)
