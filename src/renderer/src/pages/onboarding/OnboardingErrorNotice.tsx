import { useTranslation } from 'react-i18next'
import { ErrorNotice, type ErrorNoticeButton } from '@/components/error-notice'

export type OnboardingFailure = { summary: string; details: string }

export function OnboardingErrorNotice({
  failure,
  onDismiss,
  retry
}: {
  failure: OnboardingFailure
  onDismiss: () => void
  retry?: ErrorNoticeButton
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ErrorNotice
      key={failure.details}
      inline
      level="warning"
      role="alert"
      description={failure.summary}
      diagnosticsLabel={t('Error details')}
      errorCode={failure.details}
      dismissButton={{ label: t('Dismiss'), onClick: onDismiss }}
      primaryButton={retry}
    />
  )
}
