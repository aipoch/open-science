import '@/assets/main.css'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { WorkspaceWebFetchActivityRow } from '@/pages/workspace/WorkspaceWebFetchActivityRow'
import { readWebFetchResult } from '@/pages/workspace/workspace-web-fetch-details'
import { getToolExecutionPhase } from '@/pages/workspace/tool-execution-phase'
import { fetchActivity, fetchResult } from '@/pages/workspace/workspace-web-fetch-test-fixtures'
import { sanitizeToolActivity } from '../../../src/shared/session-persistence/tool-activity'
import { normalizeActivityAfterRestore } from '../../../src/shared/session-persistence/restore'
import type { ToolActivity } from '@/stores/session-store-contract'

const params = new URLSearchParams(location.search)
const scenario = params.get('scenario') ?? 'success'
const language = params.get('lang') === 'zh-Hans' ? 'zh-Hans' : 'en'
const storageKey = `web-fetch-fixture:${scenario}`
const fixtureActivity = (): ToolActivity => {
  const saved = localStorage.getItem(storageKey)
  if (saved)
    return normalizeActivityAfterRestore(sanitizeToolActivity(JSON.parse(saved))!) as ToolActivity
  const result = fetchResult()
  result.document!.text =
    '# Saved evidence\n<script>fetch("https://tracker.example/script")</script>\n![tracking](https://tracker.example/pixel)\n' +
    'A public page excerpt. '.repeat(70)
  result.document!.truncated = true
  const url = 'https://example.org/' + 'long-path-segment/'.repeat(35)
  result.request = { url }
  result.document!.final_url = url + 'final'
  if (scenario === 'failure') {
    result.status = 'error'
    delete result.document
    result.error = { code: 'EXTRACTION_FAILED', retryable: false }
  }
  const activity = fetchActivity({
    status: scenario === 'failure' ? 'failed' : 'completed',
    ...(scenario === 'cancelled' ? { toolDisposition: 'cancelled' as const } : {}),
    rawInput: { url },
    toolContent: [{ type: 'content', content: { type: 'text', text: JSON.stringify(result) } }]
  })
  const projection = sanitizeToolActivity(activity)!
  localStorage.setItem(storageKey, JSON.stringify(projection))
  return projection as ToolActivity
}
const activity = fixtureActivity()
export const App = (): React.JSX.Element => {
  const [expanded, setExpanded] = useState(false)
  return (
    <main className="min-h-screen bg-bg-100 p-3 text-text-000">
      <div className="mx-auto min-w-0 max-w-3xl">
        <WorkspaceWebFetchActivityRow
          activity={activity}
          result={readWebFetchResult(activity)}
          phase={getToolExecutionPhase(activity, undefined)}
          isExpanded={expanded}
          onToggle={(_id, open) => setExpanded(open)}
        />
      </div>
    </main>
  )
}
void Promise.resolve(prepareI18nLocale(language)).then(() => {
  initI18n(language)
  createRoot(document.getElementById('root')!).render(<App />)
})
