import { Loader2, Play } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

type SessionInterruptedBannerProps = {
  message: string
  isDisabled: boolean
  isResuming: boolean
  onResume: () => void
}

const resumeButtonClassName =
  'gap-1.5 rounded-md text-[12px] text-text-000 hover:bg-bg-300 hover:text-text-000'

// Neutral recovery banner for a session interrupted by an app restart. The Resume button re-attaches
// the ACP runtime; while that request is in flight it is disabled so a second click cannot double-resume.
const SessionInterruptedBanner = ({
  message,
  isDisabled,
  isResuming,
  onResume
}: SessionInterruptedBannerProps): React.JSX.Element => {
  const { t } = useTranslation()

  return (
    <div className="mb-2 flex items-center gap-3 rounded-lg border border-border-200 bg-bg-200 px-3 py-2">
      <p className="min-w-0 flex-1 text-[12px] leading-5 text-text-100">{message}</p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={resumeButtonClassName}
        onClick={onResume}
        disabled={isDisabled || isResuming}
        aria-label={t('Resume session')}
      >
        {isResuming ? (
          <Loader2 className="size-3.5 animate-spin" strokeWidth={2} aria-hidden="true" />
        ) : (
          <Play className="size-3.5" strokeWidth={2} aria-hidden="true" />
        )}
        {isResuming ? t('Resuming…') : t('Resume')}
      </Button>
    </div>
  )
}

export { SessionInterruptedBanner }
