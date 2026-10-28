import { useTranslation } from 'react-i18next'
import type { ReplaySourceIdentity } from '../../../../../shared/replay'

export const ReplaySourceDetails = ({
  source,
  onInspect
}: {
  source: ReplaySourceIdentity
  onInspect: () => void
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const excludedFiles = source.packageOrigin?.excludedFiles
  if (!excludedFiles?.length) return null

  return (
    <details
      className="mt-2 border-t border-border pt-2 text-xs leading-5 text-muted-foreground"
      onToggle={onInspect}
    >
      <summary className="w-fit cursor-pointer rounded-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
        {t('Not included in this package')}
      </summary>
      <ul className="mt-2 list-disc pl-4">
        {[...new Set(excludedFiles.map((file) => file.filename))].map((filename) => (
          <li key={filename} className="break-all">
            {filename}
          </li>
        ))}
      </ul>
    </details>
  )
}
