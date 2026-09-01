/* Hallmark · NotebookNetworkProtectionBanner 8-state development preview; not mounted in production. */
import {
  NotebookNetworkProtectionBanner,
  type NotebookNetworkProtectionBannerPreviewState
} from './NotebookNetworkProtectionBanner'

const STATES: NotebookNetworkProtectionBannerPreviewState[] = [
  'default',
  'hover',
  'focus',
  'active',
  'disabled',
  'loading',
  'error',
  'success'
]

const NotebookNetworkProtectionBannerPreview = (): React.JSX.Element => (
  <div className="grid max-w-3xl gap-3 bg-background p-5 text-foreground">
    {STATES.map((state) => (
      <div
        key={state}
        className="grid min-w-0 grid-cols-1 items-start gap-2 sm:grid-cols-[6rem_minmax(0,1fr)]"
      >
        <span className="pt-3 text-xs text-muted-foreground">{state}</span>
        <NotebookNetworkProtectionBanner previewState={state} onOpen={() => undefined} />
      </div>
    ))}
  </div>
)

export { NotebookNetworkProtectionBannerPreview }
