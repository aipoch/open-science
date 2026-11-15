import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import type { ImageErrorDetail } from '../../../shared/image-model-error'

export function ImageErrorNotice({ error }: { error: ImageErrorDetail }): React.JSX.Element {
  const { t } = useTranslation()
  const titles = {
    NOT_CONFIGURED: t('Configure an image model in Settings.'),
    UNSUPPORTED_OPTION: t('These image settings are unsupported. Adjust the output settings.'),
    PROVIDER_ERROR: t('The image provider could not complete the request.'),
    OUTCOME_UNKNOWN: t('Image result unconfirmed.'),
    AUTHENTICATION_FAILED: t('Authentication failed. Check the API key.'),
    ACCESS_DENIED: t('Image access denied. Check model permissions.'),
    QUOTA_EXCEEDED: t('Image quota exhausted. Check the provider balance or usage limit.'),
    RATE_LIMITED: t('Too many image requests. Wait before sending again.'),
    CONTENT_BLOCKED: t(
      'The provider blocked this image request. Revise the image or instructions.'
    ),
    SOURCE_UNAVAILABLE: t('Source image unavailable. Select an image from this project.'),
    INVALID_REQUEST: t(
      'The image provider rejected the parameters. Check the model and output settings.'
    ),
    CANCELLED: t('Image request cancelled before submission.'),
    TIMED_OUT: t('Image request timed out before submission.')
  }
  return (
    <ErrorNotice
      inline
      level={
        error.code === 'CANCELLED'
          ? 'info'
          : error.code === 'OUTCOME_UNKNOWN' ||
              error.code === 'RATE_LIMITED' ||
              error.code === 'TIMED_OUT'
            ? 'warning'
            : 'error'
      }
      title={titles[error.code]}
    />
  )
}
