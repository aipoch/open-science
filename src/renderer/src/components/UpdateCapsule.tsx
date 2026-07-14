import { ArrowUp } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useUpdateStore } from '@/stores/update-store'

// External "update available" affordance shown only while an update exists (sidebar footer + home
// header). Clicking opens the shared update dialog (version + notes + download). Renders nothing when
// there is no update — zero nagging.
const UpdateCapsule = ({ className }: { className?: string }): React.JSX.Element | null => {
  const status = useUpdateStore((state) => state.status)
  const openDialog = useUpdateStore((state) => state.openDialog)

  const isVisible =
    status.state === 'available' || status.state === 'downloading' || status.state === 'ready'
  if (!isVisible) return null

  return (
    <button
      type="button"
      onClick={() => openDialog()}
      aria-label={`Update available: ${status.latest}`}
      className={cn(
        'inline-flex h-8 items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2.5 text-xs font-medium text-primary transition-colors duration-150 ease-out hover:border-primary/30 hover:bg-primary/15',
        className
      )}
    >
      <ArrowUp className="size-3.5" strokeWidth={2.5} aria-hidden="true" />
      Update
    </button>
  )
}

export { UpdateCapsule }
