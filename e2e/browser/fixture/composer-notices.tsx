import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ComposerNoticeSlot } from '@/components/composer-notice/ComposerNoticeSlot'
import { TooltipProvider } from '@/components/ui/tooltip'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { useComposerNotices } from '@/lib/composer-notice/use-composer-notices'
import type { FailureCategory } from '../../../src/shared/failure/contract'
import type { NoticeActionHandlers } from '@/lib/composer-notice/catalog'
import '@/assets/main.css'

const query = new URLSearchParams(location.search)
const locale = query.get('locale') === 'zh-Hans' ? 'zh-Hans' : 'en'
const previewState = query.get('state') ?? 'default'
const category = (query.get('category') ?? 'service') as FailureCategory
const raw = 'Example diagnostic with an unusually long upstream response.\n'.repeat(30)
if (query.has('dark')) document.documentElement.classList.add('dark')

export function Fixture(): React.JSX.Element {
  const [blocked, setBlocked] = useState(false)
  const [actions, setActions] = useState(0)
  const notices = useComposerNotices({
    sessionId: 'fixture',
    recovery:
      category === 'session' || blocked ? { cause: 'connection-lost', error: raw } : undefined,
    turn:
      category === 'session'
        ? undefined
        : {
            promptMessageId: 'prompt',
            outcome: {
              kind: 'failed',
              settledAt: 2,
              failure: {
                category,
                diagnostics: {
                  ...(['configuration', 'service', 'input'].includes(category)
                    ? {
                        status:
                          category === 'configuration' ? 401 : category === 'input' ? 413 : 503,
                        provider: 'Example Provider',
                        model: 'example-model-with-a-long-name',
                        requestId: 'request-'.repeat(18)
                      }
                    : { code: category === 'environment' ? 'ENOENT' : '-32603' }),
                  raw
                }
              }
            }
          },
    operations: query.has('fold')
      ? [
          {
            id: 'upload',
            message: 'An upload failed',
            failure: { category: 'internal', diagnostics: { raw: 'Upload failed.' } },
            occurredAt: 1
          },
          {
            id: 'input',
            message: 'An attachment needs adjustment',
            failure: { category: 'input', diagnostics: { raw: 'Attachment too large.' } }
          }
        ]
      : []
  })
  const run = (): void => {
    if (previewState === 'error') throw new Error('The retry operation failed in this fixture.')
    setActions((count) => count + 1)
  }
  const handlers: NoticeActionHandlers = Object.fromEntries(
    [
      'retry',
      'resume',
      'open-provider-settings',
      'open-environment',
      'compact',
      'remove-attachments',
      'new-session',
      'report'
    ].map((id) => [
      id,
      {
        run,
        busy: previewState === 'loading' && id === 'retry',
        disabled: () => previewState === 'disabled'
      }
    ])
  )
  return (
    <TooltipProvider>
      <main className="mx-auto w-full max-w-3xl p-4 text-foreground">
        <ComposerNoticeSlot
          notices={notices.notices}
          handlers={handlers}
          onDismiss={notices.dismiss}
        />
        <textarea
          aria-label="Message"
          placeholder="Message"
          className="h-28 w-full resize-none rounded-2xl border border-border bg-card p-4"
        />
        <div className="mt-6 flex gap-4 text-xs text-muted-foreground">
          <button onClick={() => setBlocked(true)}>Simulate disconnection</button>
          <output data-testid="action-count">{actions}</output>
        </div>
      </main>
    </TooltipProvider>
  )
}
void Promise.resolve(prepareI18nLocale(locale)).then(() => {
  initI18n(locale)
  createRoot(document.getElementById('root')!).render(<Fixture />)
})
