import { Loader2, Play } from 'lucide-react'

import { cn } from '@/lib/utils'

type SessionInterruptedBannerProps = {
  message: string
  isResuming: boolean
  onResume: () => void
}

const resumeButtonClassName = cn(
  'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium text-text-000',
  'cursor-pointer transition-colors duration-200 ease-out hover:bg-bg-300',
  'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent'
)

// Neutral recovery banner for a session interrupted by an app restart. The Resume button re-attaches
// the ACP runtime; while that request is in flight it is disabled so a second click cannot double-resume.
const SessionInterruptedBanner = ({
  message,
  isResuming,
  onResume
}: SessionInterruptedBannerProps): React.JSX.Element => (
  <div className="mb-2 flex items-center gap-3 rounded-lg border border-border-200 bg-bg-200 px-3 py-2">
    <p className="min-w-0 flex-1 text-[12px] leading-5 text-text-100">{message}</p>
    <button
      type="button"
      className={resumeButtonClassName}
      onClick={onResume}
      disabled={isResuming}
      aria-label="Resume session"
    >
      {isResuming ? (
        <Loader2 className="size-3.5 animate-spin" strokeWidth={2} aria-hidden="true" />
      ) : (
        <Play className="size-3.5" strokeWidth={2} aria-hidden="true" />
      )}
      {isResuming ? 'Resuming…' : 'Resume'}
    </button>
  </div>
)

export { SessionInterruptedBanner }
