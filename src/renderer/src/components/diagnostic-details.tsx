import { useTranslation } from 'react-i18next'

const DiagnosticDetails = ({ detail }: { detail?: string }): React.JSX.Element | null => {
  const { t } = useTranslation()
  if (!detail?.trim()) return null

  return (
    <details className="mt-1 text-xs text-muted-foreground">
      <summary className="w-fit cursor-pointer select-none hover:text-foreground">
        {t('Details')}
      </summary>
      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[11px] leading-4 text-muted-foreground">
        {detail}
      </pre>
    </details>
  )
}

export { DiagnosticDetails }
