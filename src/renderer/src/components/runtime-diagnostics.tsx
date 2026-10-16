import { useTranslation } from 'react-i18next'
import { saveRuntimeDiagnostics } from './save-runtime-diagnostics'
import { Button } from '@/components/ui/button'

// Save only the payload currently shown in the open disclosure; never fetch or send extra data.
export const RuntimeDiagnostics = ({ text }: { text: string }): React.JSX.Element => {
  const { t } = useTranslation()
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
      <Button variant="outline" className="mt-2" onClick={() => saveRuntimeDiagnostics(text)}>
        {t('Save diagnostics')}
      </Button>
    </details>
  )
}
