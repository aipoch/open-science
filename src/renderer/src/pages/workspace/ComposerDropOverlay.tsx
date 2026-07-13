import { Upload } from 'lucide-react'

// Fills the composer input card while a file drag is active to signal the drop target.
const ComposerDropOverlay = (): React.JSX.Element => (
  <div
    aria-hidden="true"
    className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl border-2 border-action-primary bg-bg-000/70"
  >
    <div className="flex flex-col items-center gap-2 text-text-000">
      <Upload className="size-8 text-action-primary" strokeWidth={2} aria-hidden="true" />
      <span className="text-sm font-medium">Drop files to attach</span>
    </div>
  </div>
)

export { ComposerDropOverlay }
