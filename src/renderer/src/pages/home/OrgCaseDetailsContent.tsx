import { useTranslation } from 'react-i18next'
import { LoaderCircle } from 'lucide-react'
import type { OrgCaseDetail, OrgCaseErrorCode, OrgCaseItem } from '../../../../shared/org-cases'
import { formatPackageBytes } from '../../../../shared/session-package'
import { ErrorNotice } from '@/components/error-notice'
import { Notice } from '@/components/notice'
import { describeOrgCaseError, orgCaseErrorNoticeActions } from './org-case-errors'

function formatOrgCaseDate(iso: string): string {
  const timestamp = Date.parse(iso)
  if (!Number.isFinite(timestamp)) return iso
  return new Date(timestamp).toLocaleDateString()
}

export const OrgCaseDetailsContent = ({
  item,
  detail,
  detailLoading,
  detailError,
  onRetryDetail,
  onOpenLabSettings
}: {
  item: OrgCaseItem | OrgCaseDetail
  detail?: OrgCaseDetail | null
  detailLoading?: boolean
  detailError?: OrgCaseErrorCode | null
  onRetryDetail?: () => void
  onOpenLabSettings?: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const active = detail ?? item
  const originalFilename: string =
    detail?.original_filename ??
    ('original_filename' in item ? String((item as OrgCaseDetail).original_filename ?? '') : '')
  const extraOmissions = Math.max(
    0,
    active.summary.omission_count - active.summary.omissions.length
  )
  const detailErrorPresentation = detailError ? describeOrgCaseError(detailError, t) : null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <code className="rounded-md border border-border bg-muted/50 px-2 py-0.5 font-mono font-medium tracking-wider text-foreground">
          {active.code}
        </code>
        <span>
          {t('Author')}: {active.owner.display_name || t('Unknown author')}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {t('Size')}: {formatPackageBytes(active.size_bytes)}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {t('Created')}: {formatOrgCaseDate(active.created_at)}
        </span>
        {originalFilename ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="truncate font-mono text-[11px]">{originalFilename}</span>
          </>
        ) : null}
      </div>

      {detailLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          <span>{t('Refreshing case details…')}</span>
        </div>
      ) : null}

      {detailErrorPresentation ? (
        <ErrorNotice
          inline
          level={detailErrorPresentation.level}
          title={detailErrorPresentation.title}
          description={detailErrorPresentation.description}
          {...orgCaseErrorNoticeActions(detailErrorPresentation, t, {
            onOpenLabSettings,
            onRetry: onRetryDetail
          })}
        />
      ) : null}

      <div className="space-y-1.5">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('Description')}
        </h4>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
          {active.description || t('No description provided.')}
        </p>
      </div>

      <div className="space-y-2.5 rounded-xl border border-border/80 bg-muted/20 p-3.5">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('Package summary')}
          </h4>
          {active.summary.features.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {active.summary.features.map((feature) => (
                <span
                  key={feature}
                  className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                >
                  {feature}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">{t('Included files')}</dt>
            <dd className="mt-0.5 font-medium text-foreground">{active.summary.file_count}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('Content size')}</dt>
            <dd className="mt-0.5 font-medium text-foreground">
              {formatPackageBytes(active.summary.total_bytes)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('Excluded files')}</dt>
            <dd className="mt-0.5 font-medium text-foreground">{active.summary.excluded_files}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('Omissions')}</dt>
            <dd className="mt-0.5 font-medium text-foreground">{active.summary.omission_count}</dd>
          </div>
        </dl>

        {active.summary.omissions.length > 0 || extraOmissions > 0 ? (
          <div className="space-y-1.5 border-t border-border/60 pt-2.5">
            {active.summary.omissions.map((omission, index) => (
              <div
                key={`${omission.kind}-${index}`}
                className="flex items-start gap-2 text-xs text-muted-foreground"
              >
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                  {omission.kind}
                </span>
                <span>{omission.description || omission.kind}</span>
              </div>
            ))}
            {extraOmissions > 0 ? (
              <p className="text-xs text-muted-foreground">
                {t('+{{count}} additional omissions', {
                  count: extraOmissions,
                  defaultValue_one: '+{{count}} additional omission'
                })}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <Notice
        inline
        level="info"
        description={t(
          'Organization cases may include prompts, files, and outputs shared by teammates. Review the package summary and destination project carefully before importing.'
        )}
      />
    </div>
  )
}
