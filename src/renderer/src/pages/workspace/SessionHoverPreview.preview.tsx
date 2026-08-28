/* SessionHoverPreview 8-state development preview; not mounted in production. */
import { LoaderCircle } from 'lucide-react'

import { SessionHoverPreviewCard } from './SessionHoverPreview'

const STATES = [
  'default',
  'hover',
  'focus',
  'active',
  'disabled',
  'loading',
  'error',
  'success'
] as const
const PREVIEW_TITLE = 'Session title'

const SessionHoverPreviewPreview = (): React.JSX.Element => (
  <div className="grid max-w-md gap-3 bg-background p-5 text-foreground">
    {STATES.map((state) => (
      <div key={state} className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-3">
        <span className="pt-3 text-xs text-muted-foreground">{state}</span>
        {state === 'default' || state === 'disabled' ? (
          <div
            className={
              state === 'disabled'
                ? 'rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground opacity-50'
                : 'rounded-md px-3 py-2 text-sm'
            }
          >
            {PREVIEW_TITLE}
          </div>
        ) : (
          <SessionHoverPreviewCard
            session={{
              title: PREVIEW_TITLE,
              description:
                state === 'loading'
                  ? 'Loading session details…'
                  : state === 'error'
                    ? 'The Session stopped before completing.'
                    : state === 'success'
                      ? 'The Session completed successfully.'
                      : 'A concise description of the Session.'
            }}
            className={
              state === 'focus'
                ? 'outline-2 outline-offset-2 outline-ring'
                : state === 'active'
                  ? 'translate-y-px'
                  : state === 'error'
                    ? 'border-destructive'
                    : state === 'success'
                      ? 'border-primary'
                      : undefined
            }
          />
        )}
        {state === 'loading' ? (
          <LoaderCircle
            className="col-start-2 size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : null}
      </div>
    ))}
  </div>
)

export { SessionHoverPreviewPreview }
