import '@/assets/main.css'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { WorkspaceElicitationCard } from '@/pages/workspace/WorkspaceElicitationCard'
import { ResizableBottomPanel } from '@/pages/workspace/ResizableBottomPanel'
import type { ElicitationProjection, PendingElicitationRequest } from '../../../src/shared/acp'
import { isLocale } from '../../../src/shared/locale'

const params = new URLSearchParams(location.search)
const requestedLocale = params.get('locale')
const locale = isLocale(requestedLocale) ? requestedLocale : 'en'
const count = Number(params.get('questions') ?? 3)
const prompts = [
  'Your message is just a number, and this session has no active plan or attached data yet. What kind of work should I start on?',
  'What data or material should I use for this task?',
  'What would you like me to deliver?'
]
const fields = Array.from({ length: count }, (_, index) => [
  {
    id: `question_${index}`,
    label: `Question ${index + 1}`,
    description: prompts[index % prompts.length],
    kind: 'single-select' as const,
    options: [
      {
        value: 'literature',
        label: 'Literature review / evidence synthesis',
        description: 'Search real literature sources, verify citations, and synthesize findings.'
      },
      {
        value: 'data',
        label: 'Analyze data files',
        description: 'Upload or point me to a dataset and I will explore, clean, and analyze it.'
      },
      {
        value: 'report',
        label: 'Make a figure or report',
        description: 'Produce a publication-grade figure or report from your data or notes.'
      }
    ]
  },
  { id: `question_${index}_custom`, label: 'Other', kind: 'text' as const }
]).flat()
const request: PendingElicitationRequest = {
  requestId: 'browser-question',
  sessionId: 'session',
  toolCallId: 'ask',
  message: 'Please answer the following questions.',
  fields
}

export function Fixture(): React.JSX.Element {
  const [projection, setProjection] = useState<ElicitationProjection>({
    message: request.message,
    fields,
    state: 'pending'
  })
  const [collapsed, setCollapsed] = useState(false)
  const [focusRequestId, setFocusRequestId] = useState(0)
  const pending = projection.state === 'pending'
  return (
    <main className="flex h-screen flex-col bg-bg-10 text-text-000">
      <div data-testid="transcript-viewport" className="min-h-0 flex-1 overflow-y-auto px-6 pt-6">
        <div className="mx-auto max-w-4xl">
          <div className="mb-8 flex justify-end">
            <span className="rounded-2xl bg-bg-200 px-4 py-2">2</span>
          </div>
          <WorkspaceElicitationCard
            elicitation={projection}
            request={pending ? request : undefined}
            variant={pending ? 'pending-placeholder' : 'default'}
            onReveal={
              pending
                ? () => {
                    setCollapsed(false)
                    setFocusRequestId((current) => current + 1)
                  }
                : undefined
            }
          />
          <p className="mt-6 text-sm">
            Pick the task type and add any topic, file, or goal in the free-text field.
          </p>
        </div>
      </div>
      <div className="relative mx-auto w-full max-w-4xl px-2 pb-2 md:px-4">
        <form
          aria-label="Message composer"
          inert={pending}
          aria-hidden={pending}
          className={`rounded-2xl border border-border-200 bg-bg-000 p-4 ${pending ? 'invisible pointer-events-none' : ''}`}
          onSubmit={(event) => event.preventDefault()}
        >
          <textarea aria-label="Message" className="h-16 w-full resize-none bg-transparent" />
        </form>
        {pending ? (
          <div className="absolute inset-x-2 bottom-2 md:inset-x-4">
            <ResizableBottomPanel
              ariaLabel="Resize question panel"
              testId="elicitation-composer"
              scrollTestId="elicitation-composer-scroll"
              collapsed={collapsed}
              constrainGrowthToOverflow
              contentScrollSelector='[data-testid="elicitation-options"]'
              minimumContentSelector='[data-elicitation-option-row="true"]'
              minimumContentIndex={1}
            >
              <WorkspaceElicitationCard
                elicitation={projection}
                request={request}
                embedded
                collapsed={collapsed}
                onCollapsedChange={setCollapsed}
                focusRequestId={focusRequestId}
                onRespond={async (response) =>
                  setProjection({
                    ...projection,
                    state: response.action === 'accept' ? 'answered' : 'declined',
                    answers: response.answers
                  })
                }
              />
            </ResizableBottomPanel>
          </div>
        ) : null}
      </div>
    </main>
  )
}

void (async () => {
  await prepareI18nLocale(locale)
  initI18n(locale)
  createRoot(document.getElementById('root')!).render(<Fixture />)
})()
