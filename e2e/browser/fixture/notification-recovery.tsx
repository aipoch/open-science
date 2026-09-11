import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { isLocale } from '../../../src/shared/locale'
import { initI18n } from '@/i18n'
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
initI18n(isLocale(locale) ? locale : 'en')
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
    markRead: async () => {},
    markAllRead: async () => {}
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
export const BrokenSurface = (): React.JSX.Element => {
  throw new Error('synthetic entire surface error')
}
createRoot(document.getElementById('root')!).render(
  <main className="min-h-screen bg-bg-000 p-4 text-text-000">
    <h1>Notification quality fixture</h1>
    <NotificationBell />
    <button type="button">Following action</button>
    <ConnectorApprovalDialog />
    <div className="mt-4">
      <NotificationErrorBoundary surface="center">
        <BrokenSurface />
      </NotificationErrorBoundary>
    </div>
  </main>
)
