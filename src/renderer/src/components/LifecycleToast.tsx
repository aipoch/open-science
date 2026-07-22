import { useEffect } from 'react'
import { X } from 'lucide-react'

import type { ExternalSessionNotice } from '@/hooks/useLifecycleSync'

const AUTO_DISMISS_MS = 6000

const LifecycleToast = ({
  notice,
  onDismiss,
  onView
}: {
  notice: ExternalSessionNotice | undefined
  onDismiss: () => void
  onView: () => void
}): React.JSX.Element | null => {
  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => window.clearTimeout(timeout)
  }, [notice, onDismiss])

  if (!notice) return null

  return (
    <div
      role="status"
      data-testid="lifecycle-toast"
      className="fixed right-3 top-3 z-50 flex max-w-sm items-center gap-3 rounded-lg border border-border-100 bg-bg-200 px-3 py-2 text-sm text-text-100 shadow-lg"
    >
      <span className="min-w-0 flex-1 truncate" title={notice.title}>
        Session created externally
      </span>
      <button
        type="button"
        onClick={onView}
        className="shrink-0 rounded px-2 py-1 text-xs font-medium text-accent-main-100 hover:bg-bg-300"
      >
        View
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="shrink-0 rounded p-1 text-text-300 hover:bg-bg-300 hover:text-text-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}

export { LifecycleToast }
