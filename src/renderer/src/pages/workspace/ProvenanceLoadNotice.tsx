import { Check, ChevronDown, Copy, TriangleAlert } from 'lucide-react'
import { useId, useState } from 'react'
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
  const diagnosticsId = useId()
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-md flex-col gap-5 p-5">
      <div role="alert">
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
        />
      </div>
      <div className="min-w-0 border-t border-border pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="focus-visible:transition-none"
            aria-expanded={showDiagnostics}
            aria-controls={diagnosticsId}
            onClick={() => setShowDiagnostics((shown) => !shown)}
          >
            <ChevronDown
              className={showDiagnostics ? 'size-3.5' : 'size-3.5 -rotate-90'}
              aria-hidden="true"
            />
            {showDiagnostics ? t('Hide diagnostics') : t('View diagnostics')}
          </Button>
          {showDiagnostics ? (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto focus-visible:transition-none"
              onClick={() => {
                setCopyFailed(false)
                setCopied(false)
                void Promise.resolve()
                  .then(() => navigator.clipboard.writeText(diagnostics))
                  .then(() => setCopied(true))
                  .catch(() => setCopyFailed(true))
              }}
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              <span aria-live="polite">{copied ? t('Copied') : t('Copy diagnostics')}</span>
            </Button>
          ) : null}
        </div>
        <div id={diagnosticsId} hidden={!showDiagnostics} className="mt-3 min-w-0 space-y-2">
          <pre
            tabIndex={0}
            aria-label={t('View diagnostics')}
            className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-muted p-3 text-xs leading-5 text-muted-foreground select-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {diagnostics}
          </pre>
          {copyFailed ? (
            <p className="text-sm text-danger-000" role="alert">
              {t('Could not copy diagnostics. Select and copy the text above.')}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
