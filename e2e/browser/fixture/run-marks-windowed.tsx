import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { LiteratureRendererProvider } from '@/pages/literature/public/host'
import { literatureRendererHost } from '@/lib/literature-renderer-host'
import { WorkspaceMessageScroller } from '@/pages/workspace/WorkspaceMessageScroller'
import type { ChatSession } from '@/stores/session-store-contract'

initI18n('en')
window.api = {
  platform: 'darwin',
  reviewer: { getForSession: async () => [] },
  compute: { jobsList: async () => [] },
  localFs: { listGrantedRoots: async () => [] }
} as unknown as Window['api']

const count = Number(new URLSearchParams(location.search).get('count') ?? 120)
const session: ChatSession = {
  id: 'run-navigation',
  projectId: 'default',
  title: 'Variable history',
  cwd: '/workspace',
  status: 'idle',
  createdAt: 1,
  updatedAt: count * 3,
  messages: Array.from({ length: count * 2 }, (_, index) => {
    const turn = Math.floor(index / 2)
    const user = index % 2 === 0
    return {
      id: `${user ? 'user' : 'agent'}-${turn}`,
      role: user ? ('user' as const) : ('agent' as const),
      responseToMessageId: user ? undefined : `user-${turn}`,
      content: `${user ? 'Message' : 'Reply'} ${turn + 1}\n\n${'Historical message with variable height.\n'.repeat(1 + ((turn + (user ? 0 : 5)) % 13))}`,
      status: 'complete' as const,
      eventIds: [],
      createdAt: turn * 3 + (user ? 1 : 3),
      updatedAt: turn * 3 + (user ? 1 : 3)
    }
  }),
  activities: Array.from({ length: count }, (_, turn) => ({
    id: `tool-${turn}`,
    kind: 'tool' as const,
    title: `Inspect history ${turn + 1}`,
    promptMessageId: `user-${turn}`,
    status: 'completed' as const,
    eventIds: [],
    sortIndex: turn * 3 + 2,
    createdAt: turn * 3 + 2,
    updatedAt: turn * 3 + 2
  }))
}

createRoot(document.getElementById('root')!).render(
  <LiteratureRendererProvider host={literatureRendererHost}>
    <section data-session-id="run-navigation" className="h-screen">
      <WorkspaceMessageScroller
        activeSession={session}
        onSendEditedMessage={() => ({ ok: true, disposition: 'sent' })}
      />
    </section>
  </LiteratureRendererProvider>
)
