import '@/assets/main.css'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { WorkspaceWebSearchActivityRow } from '@/pages/workspace/WorkspaceWebSearchActivityRow'
import { formatWebSearchDetails } from '@/pages/workspace/workspace-web-search-details'
import { getToolExecutionPhase } from '@/pages/workspace/tool-execution-phase'
import { searchActivity, searchResult } from '@/pages/workspace/workspace-web-search-test-fixtures'
import { sanitizeToolActivity } from '../../../src/shared/session-persistence/tool-activity'
import { normalizeActivityAfterRestore } from '../../../src/shared/session-persistence/restore'
import type { ToolActivity } from '@/stores/session-store-contract'
import { WorkspaceWebFetchActivityRow } from '@/pages/workspace/WorkspaceWebFetchActivityRow'
import { readWebFetchResult } from '@/pages/workspace/workspace-web-fetch-details'
import { fetchActivity, fetchResult } from '@/pages/workspace/workspace-web-fetch-test-fixtures'

const params = new URLSearchParams(location.search)
const operation = params.get('tool') === 'fetch' ? 'fetch' : 'search'
const scenario = params.get('scenario') ?? 'success'
const language = params.get('lang') === 'zh-Hans' ? 'zh-Hans' : 'en'
const storageKey = `web-${operation}-fixture:${scenario}`

const buildSearchActivity = (): ToolActivity => {
  const ordinary = scenario === 'ordinary'
  const result = searchResult(
    ordinary ? 1 : scenario === 'empty' || scenario === 'limited' ? 0 : 10
  )
  if (ordinary) {
    result.request = {
      query: 'open science reproducibility and reusable computational workflows',
      max_results: 1
    }
  } else if (result.sources[0]) {
    result.sources[0].url = 'https://example.org/' + 'long-source-path/'.repeat(35)
    result.sources[0].snippet =
      '<img src="https://tracker.example/pixel"><script>alert(1)</script>\nScientific source text. ' +
      'A longer excerpt for the narrow viewport. '.repeat(12)
  }
  if (scenario === 'limited') {
    result.status = 'error'
    result.error = { code: 'RATE_LIMITED', retryable: true, retry_after_ms: 30000 }
  }
  return searchActivity(
    {
      status:
        scenario === 'limited' ? 'failed' : scenario === 'pending' ? 'in_progress' : 'completed',
      ...(scenario === 'cancelled' ? { toolDisposition: 'cancelled' as const } : {}),
      ...(scenario === 'pending' ? { toolContent: [] } : {})
    },
    result
  )
}

const buildFetchActivity = (): ToolActivity => {
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
  return fetchActivity({
    status: scenario === 'failure' ? 'failed' : 'completed',
    ...(scenario === 'cancelled' ? { toolDisposition: 'cancelled' as const } : {}),
    rawInput: { url },
    toolContent: [{ type: 'content', content: { type: 'text', text: JSON.stringify(result) } }]
  })
}

const initialActivity = (): ToolActivity => {
  const saved = localStorage.getItem(storageKey)
  if (saved)
    return normalizeActivityAfterRestore(sanitizeToolActivity(JSON.parse(saved))!) as ToolActivity
  const activity = operation === 'fetch' ? buildFetchActivity() : buildSearchActivity()
  const projection = sanitizeToolActivity(activity)!
  if (operation === 'fetch' || scenario !== 'pending')
    localStorage.setItem(storageKey, JSON.stringify(projection))
  return projection as ToolActivity
}

export const App = (): React.JSX.Element => {
  const [activity, setActivity] = useState(initialActivity)
  const [expanded, setExpanded] = useState(false)
  const phase = getToolExecutionPhase(activity, undefined)
  const toggle = (_id: string, open: boolean): void => setExpanded(open)
  if (operation === 'search')
    Object.assign(window, {
      updateSearchFixture: () =>
        setActivity((previous) => ({
          ...previous,
          status: 'completed',
          updatedAt: previous.updatedAt + 1,
          toolContent: searchActivity().toolContent
        }))
    })
  return (
    <main className="min-h-screen bg-bg-100 p-3 text-text-000">
      <div className="mx-auto min-w-0 max-w-3xl">
        {operation === 'fetch' ? (
          <WorkspaceWebFetchActivityRow
            activity={activity}
            result={readWebFetchResult(activity)}
            phase={phase}
            isExpanded={expanded}
            onToggle={toggle}
          />
        ) : (
          <WorkspaceWebSearchActivityRow
            activity={activity}
            details={formatWebSearchDetails(activity)}
            phase={phase}
            isExpanded={expanded}
            onToggleSearch={toggle}
          />
        )}
      </div>
    </main>
  )
}
void Promise.resolve(prepareI18nLocale(language)).then(() => {
  initI18n(language)
  createRoot(document.getElementById('root')!).render(<App />)
})
