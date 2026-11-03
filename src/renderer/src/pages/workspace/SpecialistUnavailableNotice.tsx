import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'

// This notice belongs to the Specialist picker's attempted-send popover, not the composer queue.
export const SpecialistUnavailableNotice = ({
  onChoose,
  onDismiss
}: {
  onChoose: () => void
  onDismiss: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <ErrorNotice
      inline
      role="status"
      data-testid="specialist-unavailable-notice"
      title={t('This Specialist is no longer available')}
      description={`${t('Choose another Specialist before sending a message.')} ${t('Your draft is preserved.')}`}
      primaryButton={{ label: t('Choose Specialist'), variant: 'default', onClick: onChoose }}
      dismissButton={{ label: t('Close'), onClick: onDismiss }}
    />
  )
}
