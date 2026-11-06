import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { saveRuntimeDiagnostics } from './save-runtime-diagnostics'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from './error-notice'

// Export only the payload currently shown in the disclosure; never fetch or send extra data.
export const RuntimeDiagnostics = ({ text }: { text: string }): React.JSX.Element => {
  const { t } = useTranslation()
  const [copyResult, setCopyResult] = useState<{ text: string; success: boolean }>()
  const currentResult = copyResult?.text === text ? copyResult : undefined
  return (
    <details className="mt-4 min-w-0 text-sm">
      <summary className="cursor-pointer font-medium">{t('Diagnostics')}</summary>
      <p className="my-2 text-xs text-muted-foreground">
        {t('Review local paths before sharing. Nothing is sent automatically.')}
      </p>
      <pre
        tabIndex={0}
        className="max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs"
      >
        {text}
      </pre>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={async () => {
            setCopyResult(undefined)
            try {
              await navigator.clipboard.writeText(text)
              setCopyResult({ text, success: true })
            } catch {
              setCopyResult({ text, success: false })
            }
          }}
        >
          {currentResult?.success ? t('Copied') : t('Copy diagnostics')}
        </Button>
        <Button variant="outline" onClick={() => saveRuntimeDiagnostics(text)}>
          {t('Save diagnostics')}
        </Button>
      </div>
      {currentResult?.success === false ? (
        <ErrorNotice
          inline
          level="warning"
          role="status"
          className="mt-2"
          description={t('Could not copy diagnostics. Select and copy the text above.')}
        />
      ) : null}
    </details>
  )
}
