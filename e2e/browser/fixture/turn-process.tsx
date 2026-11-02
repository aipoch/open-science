import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { useSearchMessageFocusStore } from '@/stores/search-message-focus-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { initI18n, prepareI18nLocale } from '@/i18n'
import type { ChatSession, ChatMessage } from '@/stores/session-store-contract'

const params = new URLSearchParams(location.search)
const locale = params.get('locale') === 'zh-Hans' ? 'zh-Hans' : 'en'
const failed = params.has('failed')
const noop = (): void => {}
window.api = {
  platform: 'darwin',
  localFs: { listGrantedRoots: async () => [] },
  reviewer: { getForSession: async () => [] },
  compute: { listJobs: async () => [] },
  window: {
    announceWindowFindReady: () => noop,
    onShowWindowFind: () => noop,
    onHideWindowFind: () => noop
  }
} as unknown as typeof window.api
const now = 1793000000000
const message = (
  id: string,
  role: 'user' | 'agent',
  content: string,
  index: number
): ChatMessage => ({
  id,
  role,
  content,
  status: 'complete',
  eventIds: [],
  createdAt: now + index * 1000,
  updatedAt: now + index * 1000,
  sortIndex: index,
  ...(role === 'agent' ? { responseToMessageId: 'prompt' } : {})
})
const session: ChatSession = {
  id: 'turn-process-fixture',
  projectId: 'default',
  title: 'Transcript',
  cwd: '/workspace',
  status: failed ? 'error' : 'idle',
  createdAt: now,
  updatedAt: now + 5000,
  messages: [
    {
      ...message(
        'prompt',
        'user',
        locale === 'zh-Hans'
          ? '检查这份数据，并总结分析结果。'
          : 'Check this dataset and summarize the analysis.',
        0
      ),
      turnOutcome: failed
        ? { kind: 'failed', settledAt: now + 5000, error: 'The analysis service disconnected.' }
        : { kind: 'completed', settledAt: now + 5000 }
    },
    message(
      'progress-1',
      'agent',
      locale === 'zh-Hans'
        ? '我会先检查数据结构和缺失值。'
        : 'I’ll check the data structure and missing values first.',
      1
    ),
    message(
      'progress-2',
      'agent',
      locale === 'zh-Hans'
        ? '数据检查已结束，正在计算汇总指标。'
        : 'Data checks are complete. Calculating summary statistics.',
      2
    ),
    {
      ...message(
        'answer',
        'agent',
        failed
          ? locale === 'zh-Hans'
            ? '已完成数据检查，但汇总计算尚未完成。\n\n当前结果不完整，请恢复连接后重试。'
            : 'Data checks finished, but summary calculation did not complete.\n\nThese results are partial. Reconnect and try again.'
          : locale === 'zh-Hans'
            ? '数据检查完成。\n\n- 共检查 240 条记录，没有发现缺失值。\n- 各组数据格式一致，可以进行后续比较。\n- 建议先核对异常值，再开展统计分析。'
            : 'Data checks are complete.\n\n- Checked 240 records with no missing values.\n- Groups use consistent formats and are ready for comparison.\n- Review outliers before running the statistical analysis.',
        3
      ),
      completedAt: now + 5000
    }
  ]
}

import { WorkspaceMessageScroller } from '@/pages/workspace/WorkspaceMessageScroller'
import { TurnOutcomeNotice } from '@/pages/workspace/TurnOutcomeNotice'
const actions = {
  artifactRetryDisabled: false,
  onRetryArtifact: noop,
  onReportError: noop,
  resolveError: () =>
    locale === 'zh-Hans'
      ? '分析服务连接中断。请恢复连接后重试。'
      : 'The analysis service disconnected. Reconnect and try again.'
}
if (params.has('long')) {
  session.messages.splice(
    1,
    2,
    ...Array.from({ length: 120 }, (_, index) =>
      message(`progress-${index + 1}`, 'agent', `Intermediate step ${index + 1}`, (index + 1) / 100)
    )
  )
}

export function Fixture(): React.JSX.Element {
  const [input, setInput] = useState(session)
  return (
    <main className="flex h-screen flex-col bg-bg-10 text-text-000">
      <header className="flex items-center justify-between border-b border-border-200 px-8 py-4 text-sm">
        <span>Open-Science · {locale === 'zh-Hans' ? '数据分析' : 'Data analysis'}</span>
        <button
          onClick={() => setInput({ ...session, status: 'running', agentPromptInFlight: true })}
        >
          Running
        </button>
        <button
          onClick={() =>
            useSearchMessageFocusStore.getState().request({
              projectId: session.projectId,
              sessionId: session.id,
              messageId: 'progress-2',
              navigationRevision: useNavigationStore.getState().userNavigationRevision
            })
          }
        >
          Find intermediate
        </button>
      </header>
      <WorkspaceMessageScroller
        activeSession={input}
        onSendEditedMessage={async () => ({ ok: false })}
        turnOutcomeActions={actions}
        trailingContent={
          failed ? (
            <TurnOutcomeNotice
              promptMessageId="prompt"
              outcome={{
                kind: 'failed',
                settledAt: now + 5000,
                error: 'The analysis service disconnected.'
              }}
              actions={actions}
            />
          ) : undefined
        }
      />
      <footer className="mx-auto mb-6 w-[min(90%,760px)] rounded-2xl border border-border-200 bg-bg-000 p-5 text-sm text-text-300">
        {locale === 'zh-Hans' ? '继续提问…' : 'Ask a follow-up…'}
      </footer>
    </main>
  )
}
void Promise.resolve(prepareI18nLocale(locale)).then(() => {
  initI18n(locale)
  createRoot(document.getElementById('root')!).render(<Fixture />)
})
