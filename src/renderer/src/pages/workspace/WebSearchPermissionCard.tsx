import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SearchInput } from '../../../../shared/web-tools'
import { WorkspaceToolCodeBlock } from './WorkspaceToolCodeBlock'

export const WebSearchPermissionCard = ({
  input,
  code
}: {
  input: SearchInput
  code: string
}): React.JSX.Element => {
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
      className="min-w-0 overflow-hidden rounded-lg border border-border-200 bg-bg-000"
    >
      <div className="flex items-start gap-3 p-4">
        <Search className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-3">
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-text-000 [overflow-wrap:anywhere]">
            {input.query}
          </p>
          {input.freshness || input.max_results !== undefined ? (
            <div className="flex flex-wrap gap-2 text-xs text-text-200">
              {input.freshness ? (
                <span className="rounded-md bg-bg-100 px-2 py-1">{freshness[input.freshness]}</span>
              ) : null}
              {input.max_results !== undefined ? (
                <span className="rounded-md bg-bg-100 px-2 py-1">
                  {t('Up to {{count}} results', {
                    count: input.max_results,
                    defaultValue_one: 'Up to {{count}} result'
                  })}
                </span>
              ) : null}
            </div>
          ) : null}
          {input.allowed_domains?.length ? (
            <div className="space-y-1 text-xs">
              <p className="text-text-300">{t('Limit to these sites')}</p>
              <ul className="flex flex-wrap gap-x-3 gap-y-1 text-text-100">
                {input.allowed_domains.map((domain, index) => (
                  <li key={index} className="min-w-0 [overflow-wrap:anywhere]">
                    {domain}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
      <details className="border-t border-border-200/70 px-4 py-2 text-xs text-text-300">
        <summary className="cursor-pointer">{t('Input')}</summary>
        <div className="mt-2">
          <WorkspaceToolCodeBlock code={code} language="json" copyable />
        </div>
      </details>
    </section>
  )
}
