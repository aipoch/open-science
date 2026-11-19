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
      className="min-w-0 space-y-1"
    >
      <p className="whitespace-pre-wrap break-words text-base font-medium leading-6 text-text-000 [overflow-wrap:anywhere]">
        {input.query}
      </p>
      {input.freshness || input.max_results !== undefined ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-200">
          {input.freshness ? <span>{freshness[input.freshness]}</span> : null}
          {input.freshness && input.max_results !== undefined ? (
            <span aria-hidden="true">·</span>
          ) : null}
          {input.max_results !== undefined ? (
            <span>
              {t('Up to {{count}} results', {
                count: input.max_results,
                defaultValue_one: 'Up to {{count}} result'
              })}
            </span>
          ) : null}
        </div>
      ) : null}
      {input.allowed_domains?.length ? (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
          <span className="text-text-200">{t('Limit to these sites')}</span>
          <ul className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-text-100">
            {input.allowed_domains.map((domain, index) => (
              <li key={index} className="min-w-0 [overflow-wrap:anywhere]">
                {domain}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
