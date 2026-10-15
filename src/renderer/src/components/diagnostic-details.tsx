import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from 'react-i18next'

const DiagnosticDetails = ({
  detail,
  copyable = false
}: {
  detail?: string
  copyable?: boolean
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [copyFailed, setCopyFailed] = useState(false)
  if (!detail?.trim()) return null

  return (
    <details className="mt-1 text-xs text-muted-foreground">
      <summary className="w-fit cursor-pointer select-none hover:text-foreground">
        {t('Details')}
      </summary>
      {copyable && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(detail)
              setCopyFailed(false)
            } catch {
              setCopyFailed(true)
            }
          }}
        >
          {t('Copy')}
        </Button>
      )}
      {copyFailed && (
        <p role="status">{t('Could not copy details. Select the text and copy it manually.')}</p>
      )}
      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[11px] leading-4 text-muted-foreground">
        {detail}
      </pre>
    </details>
  )
}

export { DiagnosticDetails }
