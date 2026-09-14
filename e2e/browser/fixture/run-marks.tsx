import '@/assets/main.css'
import { useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { WorkspaceRunMarks } from '@/pages/workspace/WorkspaceRunMarks'
import type { WorkspaceConversationTimelineItem } from '@/pages/workspace/workspace-conversation-timeline'

initI18n('en')
const count = Number(new URLSearchParams(location.search).get('count') ?? 60)
const items: WorkspaceConversationTimelineItem[] = Array.from({ length: count }, (_, index) =>
  (['user', 'agent'] as const).map((role) => ({
    id: `${role}-${index}`,
    type: 'message' as const,
    sortIndex: index * 2 + (role === 'agent' ? 1 : 0),
    createdAt: index,
    message: {
      id: `${role}-${index}`,
      role,
      content:
        role === 'user'
          ? `${index + 1}. Compare the RNA family annotations in this release`
          : 'The updated annotations link each RNA family to its supporting sequences. Review the alignment and confidence scores before comparing the two releases.',
      responseToMessageId: role === 'agent' ? `user-${index}` : undefined,
      status: 'complete' as const,
      eventIds: [],
      createdAt: index,
      updatedAt: index
    }
  }))
).flat()

export function App(): JSX.Element {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  return (
    <main className="flex h-screen bg-bg-10 text-text-000">
      <aside className="w-48 shrink-0 border-e border-border-200 bg-bg-000 p-6 text-sm text-text-200">
        Open Science
        <p className="mt-8 text-text-000">RNA annotation study</p>
      </aside>
      <section data-session-id="run-marks-fixture" className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-border-200 px-10 py-5 text-sm font-semibold">
          Comparing RNA families
        </header>
        <div className="relative min-h-0 flex-1 ps-8">
          <div
            ref={setViewport}
            role="region"
            aria-label="Conversation"
            className="h-full overflow-y-auto"
          >
            <div className="mx-auto max-w-3xl px-12 pb-96">
              {items.map(
                (item) =>
                  item.type === 'message' && (
                    <article
                      key={item.id}
                      data-message-id={item.id}
                      className={item.message.role === 'user' ? 'pt-8' : 'h-72 pt-6'}
                    >
                      <p
                        className={
                          item.message.role === 'user'
                            ? 'ms-auto w-fit max-w-[90%] rounded-2xl bg-bg-300 px-4 py-3 text-[15px]'
                            : 'text-[15px] leading-7'
                        }
                      >
                        {item.message.content}
                      </p>
                    </article>
                  )
              )}
            </div>
          </div>
          <WorkspaceRunMarks items={items} viewport={viewport} />
        </div>
        <footer className="mx-12 mb-6 rounded-2xl border border-border-200 bg-bg-000 p-5 text-sm text-text-200">
          Ask a follow-up about the annotations…
        </footer>
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
