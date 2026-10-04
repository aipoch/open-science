import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { PreviewPanelSurface } from '@/pages/workspace/PreviewPanel'
import { SideChatProvider } from '@/pages/workspace/use-side-chat-controller'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'

void initI18n('en')
const params = new URLSearchParams(location.search)
document.documentElement.classList.toggle('dark', params.has('dark'))
// Runtime transport only is stubbed; the controller, panels, overlays and tab strip are real.
window.api = {
  sideChat: {
    list: async () => ({
      revision: 1,
      chats: [
        {
          revision: 1,
          sideSessionId: 'side',
          parentSessionId: 'parent',
          projectId: 'project',
          running: params.has('running'),
          entries: [
            {
              id: 'answer',
              kind: 'message',
              role: 'assistant',
              text: 'Compare the confidence intervals before drawing conclusions.'
            }
          ]
        }
      ]
    }),
    onEvent: () => () => undefined,
    close: async () => undefined,
    cancel: async () => undefined
  }
} as unknown as typeof window.api
useSessionStore.setState({
  sessions: params.has('missing')
    ? []
    : [
        {
          id: 'parent',
          projectId: 'project',
          title:
            'Comparing treatment outcomes across two independent cohorts with a long session title',
          description: 'Review the effect sizes and uncertainty for each cohort.',
          status: 'idle',
          cwd: '/fixture',
          messages: [],
          createdAt: 1,
          updatedAt: 1
        } satisfies ChatSession
      ]
})
useNavigationStore.setState({
  activeProjectId: 'project',
  openSession: () => {
    document.getElementById('navigation-result')!.textContent = 'Main session opened'
    return true
  }
})
usePreviewWorkbenchStore.getState().activateProject('project')
for (let index = 0; index < 8; index++) {
  usePreviewWorkbenchStore.getState().upsertAndActivateItem({
    id: `file-${index}`,
    sessionId: 'parent',
    projectId: 'project',
    type: 'file',
    title: `cohort-analysis-${index}.txt`,
    name: `cohort-analysis-${index}.txt`,
    path: `/fixture/cohort-analysis-${index}.txt`,
    format: 'text',
    source: 'artifact'
  })
}
createRoot(document.getElementById('root')!).render(
  <SideChatProvider>
    <main className="h-svh min-w-0 bg-bg-10 p-2 text-foreground">
      <div id="navigation-result" role="status" />
      <div className="h-[calc(100%-1.5rem)] min-w-0">
        <PreviewPanelSurface />
      </div>
    </main>
  </SideChatProvider>
)
