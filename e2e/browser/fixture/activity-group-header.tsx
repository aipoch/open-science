import { useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerProvider,
  MessageScrollerViewport
} from '@/components/ui/message-scroller'
import { WorkspaceActivityGroup } from '@/pages/workspace/WorkspaceActivityGroup'
import type { ToolActivity } from '@/stores/session-store-contract'
import '@/assets/main.css'

const requestedLocale = new URLSearchParams(location.search).get('locale')
const locale = requestedLocale === 'de' || requestedLocale === 'zh-Hans' ? requestedLocale : 'en'
await prepareI18nLocale(locale)
initI18n(locale)
document.documentElement.classList.add('dark')

export const App = (): JSX.Element => {
  const [startedAt] = useState(() => Date.now() - 3000)
  const [mode, setMode] = useState('running')
  const [expanded, setExpanded] = useState(false)
  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const activities: ToolActivity[] = ['data.csv', 'model.py', 'report.md', 'notes.md'].map(
    (name, index) => ({
      id: `tool-${index}`,
      kind: 'tool',
      title: `Read ${name}`,
      providerToolName: 'Read',
      toolKind: 'read',
      status:
        index === 3
          ? mode === 'running'
            ? 'in_progress'
            : mode === 'failed'
              ? 'failed'
              : 'completed'
          : 'completed',
      eventIds: [],
      sortIndex: index,
      createdAt: startedAt,
      updatedAt: startedAt + 1000,
      rawInput: { file_path: `/fixture/${name}` },
      rawOutput: { content: `Contents of ${name}` }
    })
  )
  return (
    <main className="h-screen bg-bg-100 p-4 text-text-000">
      <div className="mb-6 flex gap-4">
        {['running', 'completed', 'failed'].map((value) => (
          <button key={value} onClick={() => setMode(value)}>
            {value}
          </button>
        ))}
      </div>
      <MessageScrollerProvider>
        <MessageScroller className="h-[500px]">
          <MessageScrollerViewport>
            <MessageScrollerContent>
              <WorkspaceActivityGroup
                group={{
                  id: 'fixture',
                  type: 'activity-group',
                  createdAt: 1,
                  sortIndex: 1,
                  activities,
                  title:
                    '检查了多个数据文件，读取了分析代码，并整理了用于最终报告的研究记录与参考资料'
                }}
                isExpanded={expanded}
                onToggleGroup={() => setExpanded((value) => !value)}
                expansionOverrides={overrides}
                onToggleRow={(id, value) =>
                  setOverrides((previous) => ({ ...previous, [id]: value }))
                }
              />
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
