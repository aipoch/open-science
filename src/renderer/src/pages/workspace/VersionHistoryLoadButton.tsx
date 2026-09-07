import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

export const VersionHistoryLoadButton = ({
  history
}: {
  history: { nextCursor?: string; loading: boolean; error?: string; loadEarlier: () => void }
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  if (!history.nextCursor) return null
  return (
    <div className="flex flex-wrap items-center gap-2 px-2 py-1">
      <Button variant="ghost" size="xs" disabled={history.loading} onClick={history.loadEarlier}>
        {history.loading
          ? t('Loading earlier versions…')
          : history.error
            ? t('Retry loading earlier versions')
            : t('Load earlier versions')}
      </Button>
      {history.error ? (
        <span role="alert" className="text-xs text-danger-000">
          {history.error}
        </span>
      ) : null}
    </div>
  )
}
