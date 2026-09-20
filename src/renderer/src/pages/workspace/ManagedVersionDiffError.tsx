import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import type { ManagedFileVersionErrorCode } from '../../../../shared/managed-file-versions'

type Props = {
  error: { code?: ManagedFileVersionErrorCode }
  onRetry: () => void
  onView: () => void
}

export const ManagedVersionDiffError = ({ error, onRetry, onView }: Props): React.JSX.Element => {
  const { t } = useTranslation()
  const description = (() => {
    switch (error.code) {
      case 'DIFF_INPUT_LIMIT_EXCEEDED':
        return t(
          'A version exceeds the 2 MiB comparison input limit. Preview or download each version to compare the complete files.'
        )
      case 'DIFF_OUTPUT_LIMIT_EXCEEDED':
        return t(
          'The changes exceed the comparison display limit, even with unchanged sections omitted. Preview or download each version to compare the complete files.'
        )
      case 'DIFF_TIMEOUT':
        return t(
          'Comparison took too long. You can retry, but complex changes may reach the time limit again.'
        )
      case 'DIFF_CONCURRENCY_LIMIT':
        return t('Other comparisons are running. Wait for them to finish, then retry.')
      case 'STORAGE_UNAVAILABLE':
        return t(
          'Version storage is unavailable. Check that the storage location is accessible, then retry.'
        )
      default:
        return t(
          'This comparison could not be completed. Return to the version preview to check the file.'
        )
    }
  })()
  const retryable =
    !error.code ||
    ['DIFF_TIMEOUT', 'DIFF_CONCURRENCY_LIMIT', 'STORAGE_UNAVAILABLE'].includes(error.code)
  return (
    <div className="p-4">
      <ErrorNotice
        role="alert"
        tone="amber"
        title={t('Diff could not be loaded.')}
        description={description}
        primaryButton={
          retryable
            ? { label: t('Retry'), onClick: onRetry }
            : { label: t('View version'), onClick: onView }
        }
        secondaryButton={retryable ? { label: t('View version'), onClick: onView } : undefined}
      />
    </div>
  )
}
