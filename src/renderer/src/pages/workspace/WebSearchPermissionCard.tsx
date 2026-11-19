import { useTranslation } from 'react-i18next'
import type { SearchInput } from '../../../../shared/web-tools'

export const WebSearchPermissionCard = ({ input }: { input: SearchInput }): React.JSX.Element => {
  const { t } = useTranslation()
  const freshness = {
    day: t('Past 24 hours'),
    week: t('Past week'),
    month: t('Past month'),
    year: t('Past year')
  }

  return (
    <section
      data-testid="web-search-permission-card"
      aria-label={t('Search the web')}
      className="min-w-0 space-y-3"
    >
      <div className="space-y-1 rounded-md bg-muted/60 px-3 py-2.5">
        <p className="text-xs text-text-200">{t('Search query')}</p>
        <p className="whitespace-pre-wrap break-words text-sm leading-5 text-text-000 [overflow-wrap:anywhere]">
          {input.query}
        </p>
      </div>
      {input.freshness || input.max_results !== undefined || input.allowed_domains?.length ? (
        <dl className="flex flex-wrap gap-x-6 gap-y-2 px-1">
          {input.freshness ? (
            <div className="space-y-0.5">
              <dt className="text-xs text-text-200">{t('Time range')}</dt>
              <dd className="text-xs text-text-000">{freshness[input.freshness]}</dd>
            </div>
          ) : null}
          {input.max_results !== undefined ? (
            <div className="space-y-0.5">
              <dt className="text-xs text-text-200">{t('Result limit')}</dt>
              <dd className="text-xs text-text-000">
                {t('Up to {{count}} results', {
                  count: input.max_results,
                  defaultValue_one: 'Up to {{count}} result'
                })}
              </dd>
            </div>
          ) : null}
          {input.allowed_domains?.length ? (
            <div className="min-w-0 basis-full space-y-0.5">
              <dt className="text-xs text-text-200">{t('Limit to these sites')}</dt>
              <dd>
                <ul className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-text-000">
                  {input.allowed_domains.map((domain, index) => (
                    <li key={index} className="min-w-0 [overflow-wrap:anywhere]">
                      {domain}
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </section>
  )
}
