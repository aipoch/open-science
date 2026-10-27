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
  const date = origin
    ? new Date(origin.importedAt).toLocaleString(i18n.resolvedLanguage ?? i18n.language)
    : undefined
  return (
    <details className="text-xs leading-5 text-muted-foreground" onToggle={onInspect}>
      <summary className="w-fit cursor-pointer rounded-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
        {t('Details')}
      </summary>
      <p className="mt-3">
        {t('Presentation timing is reconstructed; recorded results are unchanged.')}
      </p>
      {origin ? (
        <>
          <p className="mt-3">{t('Imported on {{date}}', { date })}</p>
          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
            <dt>{t('Source project')}</dt>
            <dd className="break-all font-mono">{origin.sourceProjectId}</dd>
            <dt>{t('Source Session')}</dt>
            <dd className="break-all font-mono">{origin.sourceSessionId}</dd>
            <dt>{t('Source fingerprint')}</dt>
            <dd className="break-all font-mono">{source.fingerprint}</dd>
          </dl>
        </>
      ) : null}
      {origin?.excludedFiles?.length ? (
        <section className="mt-3">
          <h3 className="font-medium">{t('Not included in this package')}</h3>
          <ul className="mt-1 list-disc pl-4">
            {[...new Set(origin.excludedFiles.map((file) => file.filename))].map((filename) => (
              <li key={filename} className="break-all">
                {filename}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </details>
  )
}
