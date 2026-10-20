import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { TokenUsagePanel } from '@/pages/settings/TokenUsagePanel'
import type { PersistedChatSession } from '../../../src/shared/session-persistence'

const parameters = new URLSearchParams(location.search)
const locale = parameters.get('lang') === 'de' ? 'de' : 'en'
await prepareI18nLocale(locale)
initI18n(locale)
document.documentElement.classList.toggle('dark', parameters.has('dark'))
const now = new Date(2026, 9, 2, 12).getTime()
const messages: PersistedChatSession['messages'] = Array.from({ length: 30 }, (_, index) => {
  const timestamp = new Date(2026, 8, 3 + index, 12).getTime()
  const inputTokens = index === 5 ? 0 : (index + 1) * 10_000_000
  return {
    id: `message-${index}`,
    role: 'agent',
    content: '',
    status: 'complete',
    eventIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    turnUsage: { inputTokens, cacheTokens: inputTokens / 2, outputTokens: inputTokens / 4 }
  }
})
const session: PersistedChatSession = {
  id: 'usage-inspection',
  projectId: 'example',
  title: 'Usage inspection',
  cwd: '/example',
  status: 'idle',
  createdAt: messages[0].createdAt,
  updatedAt: now,
  messages,
  artifacts: []
}
createRoot(document.getElementById('root')!).render(
  <main className="min-h-screen bg-background text-foreground">
    <div className="mx-auto max-w-5xl">
      <TokenUsagePanel sessions={[session]} projects={[]} now={now} />
    </div>
    <div className="h-96" />
  </main>
)
