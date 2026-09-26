import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PreviewPanelSurface } from '@/pages/workspace/PreviewPanel'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import type { NotebookPreviewItem } from '@/pages/workspace/NotebookPreview'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useNotebookEnvStore } from '@/stores/notebook-env-store'
import type { NotebookRunRecord } from '../../../src/shared/notebook'

initI18n('en')
document.documentElement.classList.toggle('dark', new URLSearchParams(location.search).has('dark'))
const reference = {
  sessionId: 'session',
  projectId: 'project',
  workspaceCwd: '/fixture',
  notebookSessionRoot: '/fixture/notebook',
  dataRoot: '/fixture/data',
  runtimeRoot: '/fixture/runtime',
  runJsonPath: '/fixture/run.json'
}
const item: NotebookPreviewItem = {
  id: 'notebook',
  sessionId: 'session',
  title: 'Notebook',
  type: 'tool',
  toolKind: 'notebook',
  notebook: reference
}
const run: NotebookRunRecord = {
  runId: 'run',
  cellId: 'cell',
  source: 'agent',
  kernelKind: 'python',
  script: 'print(1)',
  status: 'completed',
  startedAt: 0,
  text: { stdout: '1', stderr: '', traceback: '', plain: [] },
  outputs: [],
  artifacts: [],
  workingFiles: [],
  rootFrameId: 'root',
  agentFrameId: 'root'
}
// Only runtime transport is stubbed; tab, close control, Notebook and focus styles are production UI.
window.api = {
  notebook: {
    state: async () => ({
      ...reference,
      id: 'session',
      cwd: '/fixture',
      kernelStatus: 'idle',
      cells: [],
      runCount: 1,
      runs: [run],
      recentRuns: [run],
      runStaleness: {},
      environments: []
    }),
    onChanged: () => () => undefined
  }
} as unknown as typeof window.api
useNotebookEnvStore.setState({
  status: { pythonReady: true, rReady: false, version: 3, provisioning: false },
  ui: { kind: 'ready' }
})
useSessionStore.setState({
  sessions: [
    {
      id: 'session',
      conversationGraph: { rootFrameId: 'root', frames: [{ id: 'root', kind: 'root' }] }
    } as ChatSession
  ],
  selectedSessionId: 'session'
})
useNavigationStore.setState({ activeProjectId: 'project' })
usePreviewWorkbenchStore.getState().activateProject('project')
usePreviewWorkbenchStore.getState().upsertAndActivateItem(item)
createRoot(document.getElementById('root')!).render(
  <TooltipProvider>
    <button type="button">Before preview</button>
    <main style={{ height: 600, width: 440 }}>
      <PreviewPanelSurface />
    </main>
  </TooltipProvider>
)
