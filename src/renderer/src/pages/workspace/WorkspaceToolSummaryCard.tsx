import { FileText, FlaskConical, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ToolSummary } from './notebook-tool-presentation'

const WorkspaceToolSummaryCard = ({
  summary,
  file = false
}: {
  summary: ToolSummary
  file?: boolean
}): React.JSX.Element => {
  const Icon = file ? FileText : FlaskConical
  const { t } = useTranslation()
  const renderError = (error: string): React.JSX.Element => (
    <div
      role="status"
      className="mt-2 rounded-md bg-status-failure-surface p-3 text-xs text-status-failure-foreground"
    >
      <p className="max-h-32 overflow-auto whitespace-pre-wrap break-words">
        {error.slice(0, 2000)}
      </p>
      {error.length > 2000 ? <p className="mt-2">{t('Output truncated')}</p> : null}
    </div>
  )
  return (
    <section
      data-testid="tool-summary-card"
      aria-label={summary.title}
      className="min-w-0 overflow-hidden rounded-xl border border-border-200 bg-bg-000"
    >
      <div className="flex items-center gap-3 border-b border-border-200/70 px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h4 className="text-[13px] font-medium text-text-000">{summary.title}</h4>
          {summary.subtitle ? (
            <p className="break-words text-xs text-text-200">{summary.subtitle}</p>
          ) : null}
        </div>
      </div>
      {summary.fields.length ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 px-4 py-3 text-xs">
          {summary.fields.map((field, index) => (
            <div key={index} className="contents">
              <dt className="text-text-300">{field.label}</dt>
              <dd className="min-w-0 break-all text-text-100">
                {field.expandable ? (
                  <details>
                    <summary className="cursor-pointer">
                      {field.value.split(/[\\/]/u).filter(Boolean).slice(-2).join('/')}
                    </summary>
                    <p className="mt-2 text-text-300">{field.value}</p>
                  </details>
                ) : (
                  field.value
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {summary.rows?.length ? (
        <div className="divide-y divide-border-200/70 border-t border-border-200/70">
          {summary.rows.map((row, index) => (
            <div key={index} className="px-4 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0 break-all text-xs font-medium text-text-100">
                  {row.title}
                </span>
                {row.status ? (
                  <span className="shrink-0 rounded bg-bg-200 px-1.5 py-0.5 text-[10px] text-text-200">
                    {row.status}
                  </span>
                ) : null}
              </div>
              {row.detail ? (
                <p className="mt-1 break-words text-[11px] text-text-300">{row.detail}</p>
              ) : null}
              {row.error ? renderError(row.error) : null}
            </div>
          ))}
        </div>
      ) : null}
      {summary.error ? <div className="m-3">{renderError(summary.error)}</div> : null}
      {summary.note ? (
        <div className="flex items-start gap-2 border-t border-border-200/70 bg-bg-100 px-4 py-3 text-[11px] leading-5 text-text-200">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <p>{summary.note}</p>
        </div>
      ) : null}
    </section>
  )
}
export { WorkspaceToolSummaryCard }
