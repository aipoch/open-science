import { TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import type { ProvenanceReadFailure } from '../../../../shared/provenance-read-result'

export const ProvenanceLoadNotice = ({
  failure,
  diagnostics,
  onRetry
}: {
  failure: ProvenanceReadFailure
  diagnostics: string
  onRetry?: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex flex-col items-center gap-3 p-5" role="alert">
      <ErrorNotice
        icon={TriangleAlert}
        tone={failure.kind === 'integrity-failed' ? 'red' : 'amber'}
        title={
          failure.kind === 'integrity-failed'
            ? t('Provenance integrity error')
            : t('Provenance could not be loaded')
        }
        description={failure.message}
        primaryButton={onRetry ? { label: t('Retry'), onClick: onRetry } : undefined}
        secondaryButton={{ label: t('View diagnostics'), onClick: () => setShowDiagnostics(true) }}
      />
      {showDiagnostics ? (
        <div className="w-full min-w-0 space-y-2">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
            {diagnostics}
          </pre>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setCopyFailed(false)
              void Promise.resolve()
                .then(() => navigator.clipboard.writeText(diagnostics))
                .then(() => setCopied(true))
                .catch(() => setCopyFailed(true))
            }}
          >
            {copied ? t('Copied') : t('Copy diagnostics')}
          </Button>
          {copyFailed ? (
            <p className="text-sm text-danger-000">
              {t('Could not copy diagnostics. Select and copy the text above.')}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
