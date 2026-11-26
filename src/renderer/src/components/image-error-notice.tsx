import { useTranslation } from 'react-i18next'
import { ComposerNoticeSlot } from '@/components/notices/ComposerNoticeSlot'
import type {
  ComposerNotice,
  NoticeActionHandlers
} from '@/components/notices/composer-notice-catalog'
import { classifyFailure } from '../../../shared/failure/classify'
import { ErrorNotice } from '@/components/error-notice'
import { useSettingsStore } from '@/stores/settings-store'
import type { ImageErrorDetail } from '../../../shared/image-model-error'

function useImageErrorTitles(error?: ImageErrorDetail): Record<ImageErrorDetail['code'], string> {
  const { t } = useTranslation()
  return {
    NOT_CONFIGURED: t('Configure an image model in Settings.'),
    UNSUPPORTED_OPTION: t('These image settings are unsupported. Adjust the output settings.'),
    PROVIDER_ERROR: t('The image provider could not complete the request.'),
    OUTCOME_UNKNOWN: t('Image result unconfirmed.'),
    AUTHENTICATION_FAILED: t('Authentication failed. Check the API key.'),
    ACCESS_DENIED: t('Image access denied. Check model permissions.'),
    QUOTA_EXCEEDED:
      error?.providerCode?.toLowerCase() === 'quotaexceeded'
        ? t('Image usage or request limit reached. Check the provider limits.')
        : t('Image quota exhausted. Check the provider balance or usage limit.'),
    RATE_LIMITED: t('Too many image requests. Wait before sending again.'),
    CONTENT_BLOCKED: t(
      'The provider blocked this image request. Revise the image or instructions.'
    ),
    SOURCE_UNAVAILABLE: t('Source image unavailable. Select an image from this project.'),
    EDIT_CONTEXT_CHANGED: t('The conversation changed. Reopen the image editor and try again.'),
    INVALID_REQUEST: t(
      'The image provider rejected the parameters. Check the model and output settings.'
    ),
    SOURCE_LIMIT_EXCEEDED: t(
      'This image is outside the selected model’s input limits. Choose another model or image.'
    ),
    STORAGE_FULL: t('There is not enough storage space to save this file.'),
    CANCELLED: t('Image request cancelled before submission.'),
    TIMED_OUT: t('Image request timed out before submission.')
  }
}

export function ImageErrorNotice({ error }: { error: ImageErrorDetail }): React.JSX.Element {
  const { t } = useTranslation()
  const titles = useImageErrorTitles(error)
  const fields = [
    error.httpStatus && error.httpStatus >= 400 ? `status: ${error.httpStatus}` : undefined,
    error.providerCode ? `providerCode: ${error.providerCode}` : undefined,
    error.parameter ? `parameter: ${error.parameter}` : undefined,
    error.requestId ? `requestId: ${error.requestId}` : undefined
  ].filter(Boolean)
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
      errorCode={fields.length ? [`code: ${error.code}`, ...fields].join('\n') : undefined}
      diagnosticsLabel={t('Details')}
    />
  )
}

export function ImageComposerNotices({
  error,
  task,
  notices,
  handlers
}: {
  error?: ImageErrorDetail
  task?: { id: string; updatedAt: number; provider?: string; model?: string }
  notices: readonly ComposerNotice[]
  handlers: NoticeActionHandlers
}): React.JSX.Element {
  const { t } = useTranslation()
  const titles = useImageErrorTitles(error)
  const needsSettings =
    error?.code === 'NOT_CONFIGURED' ||
    error?.code === 'AUTHENTICATION_FAILED' ||
    error?.code === 'ACCESS_DENIED' ||
    error?.code === 'QUOTA_EXCEEDED'
  const failure =
    error &&
    classifyFailure({
      origin: task ? 'provider' : 'operation',
      status: error.httpStatus && error.httpStatus >= 400 ? error.httpStatus : undefined,
      code: error.code,
      provider: task?.provider,
      model: task?.model,
      requestId: error.requestId
    })
  const unconfirmed = error?.code === 'OUTCOME_UNKNOWN'
  const modelNotice: ComposerNotice | undefined = error &&
    failure && {
      id: task?.id ?? error.code,
      source: 'operation',
      operation: 'image-edit',
      occurredAt: task?.updatedAt ?? 0,
      failure: {
        ...failure,
        diagnostics: {
          ...failure.diagnostics,
          ...(error.providerCode ? { providerCode: error.providerCode } : {}),
          ...(error.parameter ? { parameter: error.parameter } : {})
        },
        ...(unconfirmed
          ? { category: 'service', reason: 'service/image-observation' }
          : needsSettings && failure.category !== 'configuration'
            ? { category: 'configuration', reason: undefined }
            : {}),
        ...(task ? { responseMessage: titles[error.code] } : {})
      },
      summary:
        !task || unconfirmed
          ? { title: titles[error.code] }
          : { title: t('Model provider error'), description: titles[error.code] }
    }
  return (
    <ComposerNoticeSlot
      notices={modelNotice ? [modelNotice, ...notices] : notices}
      handlers={{
        ...handlers,
        'open-provider-settings': {
          run: () => useSettingsStore.getState().openSettingsToImageServices()
        }
      }}
    />
  )
}
