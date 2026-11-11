import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { LiteratureRendererProvider } from '@/pages/literature/public/host'
import { literatureRendererHost } from '@/lib/literature-renderer-host'
import { WorkspaceMessageScroller } from '@/pages/workspace/WorkspaceMessageScroller'
import type { ChatSession } from '@/stores/session-store-contract'

initI18n('en')
const params = new URLSearchParams(location.search)
const notices = params.has('notices')
window.api = {
  platform: 'darwin',
  reviewer: {
    getForSession: async () => {
      if (notices) throw new Error('Fixture review history load failure')
      return []
    }
  },
  compute: {
    jobsList: async () => {
      if (notices) throw new Error('Fixture remote job load failure')
      return []
    }
  },
  localFs: { listGrantedRoots: async () => [] }
} as unknown as Window['api']

const count = Number(params.get('count') ?? 400)
const session: ChatSession = {
  id: 'first-message-regression',
  projectId: 'default',
  title: 'First message navigation',
  cwd: '/workspace',
  status: 'idle',
  createdAt: 1,
  updatedAt: count,
  messages: Array.from({ length: count }, (_, index) => ({
    id: `history-${index}`,
    role: index % 2 ? 'agent' : 'user',
    content: `Historical message ${index}. ${'A paragraph of conversation history. '.repeat(8)}`,
    status: 'complete',
    eventIds: [],
    createdAt: index + 1,
    updatedAt: index + 1
  }))
}

createRoot(document.getElementById('root')!).render(
  <LiteratureRendererProvider host={literatureRendererHost}>
    <div style={{ height: notices ? 140 : 600, width: 900 }}>
      <WorkspaceMessageScroller
        activeSession={session}
        onSendEditedMessage={() => ({ ok: true, disposition: 'sent' })}
      />
    </div>
  </LiteratureRendererProvider>
)
