import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCcw } from 'lucide-react'

import type { AcpContextRecoveryState } from '../../../../shared/acp'
import { ErrorNotice } from '@/components/error-notice'

type ContextRecoveryNoticeProps = {
  state?: AcpContextRecoveryState
  onRecover: () => Promise<void>
}

export const ContextRecoveryNotice = ({
  state,
  onRecover
}: ContextRecoveryNoticeProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const running =
    pending ||
    Boolean(state && ['compacting', 'preparing', 'replacing', 'continuing'].includes(state.phase))
  const recover = async (): Promise<void> => {
    if (running) return
    setPending(true)
    setError(undefined)
    try {
      await onRecover()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <ErrorNotice
      className="mb-2"
      role={running ? 'status' : 'alert'}
      icon={RotateCcw}
      tone="amber"
      title={running ? t('Recovering session…') : t('Session context needs recovery')}
      description={
        error ??
        state?.reason ??
        t(
          'Your conversation and files are preserved. Recovery prepares a smaller context so work can continue.'
        )
      }
      primaryButton={
        state?.phase === 'blocked' && !state.canRetry
          ? undefined
          : {
              label: t('Recover session'),
              onClick: () => void recover(),
              loading: running
            }
      }
    />
  )
}
