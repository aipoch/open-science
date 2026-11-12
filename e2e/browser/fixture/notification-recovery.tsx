import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { isLocale } from '../../../src/shared/locale'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { ResearchFilmNotificationHost } from '@/components/ResearchFilmNotificationHost'
import { NotificationLiveToast } from '@/components/NotificationLiveToast'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { createLinearConversationGraph } from '../../../src/shared/conversation-graph'
import type { ResearchVideoPresentationStatus } from '../../../src/shared/research-video-presentation'
import { NotificationBell } from '@/components/NotificationBell'
import { NotificationErrorBoundary } from '@/components/NotificationErrorBoundary'
import { ConnectorApprovalDialog } from '@/pages/settings/ConnectorApprovalDialog'
import { useNotificationInboxStore } from '@/stores/notification-inbox-store'
import { useSettingsStore } from '@/stores/settings-store'
import type {
  NotificationInboxItem,
  NotificationInboxSnapshot
} from '../../../src/shared/notifications'

const locale = new URLSearchParams(location.search).get('locale')
const fixtureLocale = isLocale(locale) ? locale : 'en'
const localeReady = Promise.resolve(prepareI18nLocale(fixtureLocale)).then(() =>
  initI18n(fixtureLocale)
)
const filmMode = new URLSearchParams(location.search).has('film')
let finished = false
let starts = 0
const film = {
  id: 'film-task',
  projectId: 'project-film',
  sessionId: 'session-film',
  branchId: 'film-branch',
  sessionTitle: 'A long research conversation about protein folding',
  progress: { phase: 'writing' as const, startedAt: Date.now() }
}
let filmItem: NotificationInboxItem = {
  id: 'film-result',
  sequence: 1,
  dedupeKey: 'film-result',
  kind: 'task.failed',
  source: 'research-film',
  originId: film.id,
  projectId: film.projectId,
  sessionId: film.sessionId,
  branchId: film.branchId,
  title: 'Research video failed',
  summary: 'Open the research film for details.',
  createdAt: Date.now()
}
let broken = true
let reads = 0
let responses = 0
const item: NotificationInboxItem = {
  id: 'pending',
  sequence: 2,
  dedupeKey: 'approval:2',
  kind: 'authorization.required',
  source: 'connector',
  originId: 'request-2',
  title: 'Approval needed',
  summary: 'Pending request',
  createdAt: Date.now(),
  actionState: 'pending',
  readAt: Date.now()
}
const snapshot = (): NotificationInboxSnapshot => {
  if (filmMode)
    return {
      revision: finished ? 2 : 1,
      latestSequence: finished ? 1 : 0,
      unreadCount: finished && !filmItem.readAt ? 1 : 0,
      items: finished ? [filmItem] : [],
      activeResearchFilm: finished ? undefined : film
    }
  const damaged = { ...item, id: 'damaged', title: 'Repaired message', readAt: undefined }
  if (broken)
    Object.defineProperty(damaged, 'title', {
      get() {
        throw new Error('private synthetic payload')
      }
    })
  return { revision: 1, latestSequence: 2, unreadCount: 1, items: [damaged, item] }
}
Object.assign(window, {
  notificationQuality: {
    finishFilm: () => {
      finished = true
      useNotificationInboxStore.setState(snapshot())
    },
    get starts() {
      return starts
    },
    repair: () => {
      broken = false
    },
    get reads() {
      return reads
    },
    get responses() {
      return responses
    }
  }
})
window.api = {
  notifications: {
    getSnapshot: async () => {
      reads++
      return snapshot()
    },
    markRead: async () => {
      if (filmMode) filmItem = { ...filmItem, readAt: Date.now() }
    },
    markAllRead: async () => {}
  },
  researchVideo: {
    status: async (): Promise<ResearchVideoPresentationStatus> =>
      finished
        ? { preflightError: 'Narration installation did not finish. Retry to continue.' }
        : { progress: film.progress },
    start: async () => {
      starts++
      return {}
    }
  },
  settings: {
    replayConnectorApproval: async () => ({
      id: 'request-2',
      connector: 'research',
      displayName: 'Research Connector',
      method: 'analyze',
      argsPreview: '/long/path/'.repeat(50),
      argsJson: '{"path":"' + '/long/path/'.repeat(100) + '"}',
      target: 'https://example.test/' + 'segment/'.repeat(50),
      availableScopes: ['once', 'project', 'global']
    })
  }
} as unknown as Window['api']
useNotificationInboxStore.setState({ ...snapshot(), status: 'ready' })
useSettingsStore.setState({
  pendingApprovals: [],
  respondApproval: async () => {
    responses++
    useSettingsStore.setState({ pendingApprovals: [] })
  }
})
if (filmMode) {
  const graph = createLinearConversationGraph({
    sessionId: film.sessionId,
    messages: [],
    createdAt: 1,
    updatedAt: 1
  })
  graph.branches.push({
    id: film.branchId,
    agentFrameId: graph.rootFrameId,
    createdAt: 1,
    updatedAt: 1
  })
  useSessionStore.setState({
    sessions: [
      {
        id: film.sessionId,
        projectId: film.projectId,
        title: film.sessionTitle,
        cwd: '',
        messages: [],
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
        conversationGraph: graph
      } as ChatSession
    ],
    selectedSessionId: film.sessionId
  })
  useNavigationStore.setState({
    view: 'workspace',
    activeProjectId: film.projectId,
    openSessionById: (_id, _origin, callback) => {
      callback?.()
      return true
    }
  })
}
export const BrokenSurface = (): React.JSX.Element => {
  throw new Error('synthetic entire surface error')
}
void localeReady.then(() => {
  createRoot(document.getElementById('root')!).render(
    <main className="min-h-screen bg-bg-000 p-4 text-text-000">
      <h1>Notification quality fixture</h1>
      <NotificationBell />
      <button type="button">Following action</button>
      {filmMode ? (
        <>
          <NotificationLiveToast />
          <ResearchFilmNotificationHost />
        </>
      ) : (
        <ConnectorApprovalDialog />
      )}
      {!filmMode && (
        <div className="mt-4">
          <NotificationErrorBoundary surface="center">
            <BrokenSurface />
          </NotificationErrorBoundary>
        </div>
      )}
    </main>
  )
})
