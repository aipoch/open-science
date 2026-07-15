import { Upload } from 'lucide-react'

import { cn } from '@/lib/utils'

type FileDropOverlayProps = {
  label: string
  // Border-radius (and any extra) is passed in so the overlay matches the drop target it fills.
  className?: string
}

// Fills a drop target while a file drag is active to signal where files will land. Shared by the
// composer and the settings skill upload areas so every drop zone reads the same visual language.
const FileDropOverlay = ({ label, className }: FileDropOverlayProps): React.JSX.Element => (
  <div
    aria-hidden="true"
    className={cn(
      'pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-primary bg-bg-000/70',
      className
    )}
  >
    <div className="flex flex-col items-center gap-2 text-text-000">
      <Upload className="size-8 text-primary" strokeWidth={2} aria-hidden="true" />
      <span className="text-sm font-medium">{label}</span>
    </div>
  </div>
)

export { FileDropOverlay }
