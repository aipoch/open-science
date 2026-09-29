import { useTranslation } from 'react-i18next'
import type { ReplaySourceIdentity } from '../../../../../shared/replay'

export const ReplaySourceDetails = ({
  source,
  onInspect
}: {
  source: ReplaySourceIdentity
  onInspect: () => void
}): React.JSX.Element | null => {
  const { t, i18n } = useTranslation()
  const origin = source.packageOrigin
  if (!origin) return null
  const date = new Date(origin.importedAt).toLocaleString(i18n.resolvedLanguage ?? i18n.language)
  return (
    <details
      className="max-h-52 shrink-0 overflow-auto border-b border-border-200 bg-bg-000 px-3 py-2 text-xs text-text-300"
      onToggle={onInspect}
    >
      <summary className="cursor-pointer font-medium text-text-100">
        {t('Imported research history')}
      </summary>
      <p className="mt-2">{t('Imported on {{date}}', { date })}</p>
      <h3 className="mt-2 font-medium text-text-100">{t('Package source')}</h3>
      <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt>{t('Source project')}</dt>
        <dd className="break-all font-mono">{origin.sourceProjectId}</dd>
        <dt>{t('Source Session')}</dt>
        <dd className="break-all font-mono">{origin.sourceSessionId}</dd>
        <dt>{t('Source fingerprint')}</dt>
        <dd className="break-all font-mono">{source.fingerprint}</dd>
      </dl>
      <p className="mt-2 leading-5">
        {t(
          'Original evidence is retained separately; local references and evidence hashes are derived during import.'
        )}
      </p>
      {origin.excludedFiles?.length ? (
        <details className="mt-2">
          <summary className="cursor-pointer">{t('Not included in this package')}</summary>
          <p className="mt-1">{t('Excluded when this package was exported.')}</p>
          <ul className="mt-1 list-disc pl-4">
            {[...new Set(origin.excludedFiles.map((file) => file.filename))].map((filename) => (
              <li key={filename} className="break-all">
                {filename}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </details>
  )
}
