import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Download, X } from 'lucide-react'
import type {
  OrgCaseDetail,
  OrgCaseDownloadSnapshot,
  OrgCaseErrorCode,
  OrgCaseItem
} from '../../../../shared/org-cases'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import {
  describeOrgCaseError,
  formatOrgCaseDownloadLabel,
  orgCaseErrorNoticeActions
} from '../home/org-case-errors'
import { OrgCaseDetailsContent } from '../home/OrgCaseDetailsContent'

export const OrgCaseDetailsPage = ({
  caseId,
  item,
  detail,
  detailLoading,
  detailError,
  download,
  downloadError,
  importBusy,
  importDisabled = false,
  onBack,
  onLoadDetail,
  onImport,
  onCancelImport,
  onDismissDownloadError,
  onOpenLabSettings
}: {
  caseId: string
  item?: OrgCaseItem | null
  detail?: OrgCaseDetail | null
  detailLoading: boolean
  detailError: OrgCaseErrorCode | null
  download: OrgCaseDownloadSnapshot | null
  downloadError: OrgCaseErrorCode | null
  importBusy: boolean
  importDisabled?: boolean
  onBack: () => void
  onLoadDetail: (caseId: string) => void
  onImport: (caseId: string) => void
  onCancelImport: (caseId: string) => void
  onDismissDownloadError: () => void
  onOpenLabSettings?: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const backRef = useRef<HTMLButtonElement>(null)
  const autoRequestedCaseIdRef = useRef<string | null>(null)
  const onLoadDetailRef = useRef(onLoadDetail)

  useEffect(() => {
    onLoadDetailRef.current = onLoadDetail
  }, [onLoadDetail])

  useEffect(() => {
    backRef.current?.focus({ preventScroll: true })
  }, [caseId])

  useEffect(() => {
    if (detail || detailError || autoRequestedCaseIdRef.current === caseId) {
      return
    }
    autoRequestedCaseIdRef.current = caseId
    if (!detailLoading) {
      onLoadDetailRef.current(caseId)
    }
  }, [caseId, detail, detailError, detailLoading])

  const active = detail ?? item
  const isDownloading = download?.caseId === caseId
  const progressPercent =
    isDownloading && download.totalBytes && download.totalBytes > 0
      ? Math.min(
          100,
          Math.max(0, Math.round((download.completedBytes / download.totalBytes) * 100))
        )
      : 0
  const detailErrorPresentation = detailError ? describeOrgCaseError(detailError, t) : null
  const downloadErrorPresentation = downloadError ? describeOrgCaseError(downloadError, t) : null

  return (
    <section
      aria-label={t('Organization case details')}
      className="flex h-full flex-col overflow-hidden"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/80 px-5 py-3">
        <Button
          ref={backRef}
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={onBack}
        >
          <ArrowLeft className="h-4 w-4" />
          {t('Back to list')}
        </Button>

        {active ? (
          isDownloading ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => onCancelImport(caseId)}
            >
              <X className="mr-1.5 h-3.5 w-3.5" />
              {t('Cancel')}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={importBusy || importDisabled || detailError === 'not-found'}
              onClick={() => onImport(caseId)}
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {t('Import')}
            </Button>
          )
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto max-w-3xl space-y-4">
          {active ? (
            <>
              <h2 className="text-lg font-semibold text-foreground">{active.name}</h2>

              {isDownloading ? (
                <div className="space-y-1.5 rounded-lg border border-border/80 bg-muted/30 p-3">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-foreground">
                      {formatOrgCaseDownloadLabel(download, t)}
                    </span>
                    <span className="text-muted-foreground">
                      {download.state === 'verifying' ? '100%' : `${progressPercent}%`}
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label={formatOrgCaseDownloadLabel(download, t)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={download.state === 'verifying' ? 100 : progressPercent}
                    className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className="h-full bg-primary transition-[width] duration-200"
                      style={{
                        width: `${download.state === 'verifying' ? 100 : progressPercent}%`
                      }}
                    />
                  </div>
                </div>
              ) : null}

              {downloadErrorPresentation ? (
                <ErrorNotice
                  inline
                  level={downloadErrorPresentation.level}
                  title={downloadErrorPresentation.title}
                  description={downloadErrorPresentation.description}
                  dismissButton={{ label: t('Dismiss'), onClick: onDismissDownloadError }}
                  {...orgCaseErrorNoticeActions(downloadErrorPresentation, t, {
                    onOpenLabSettings,
                    onRetry: !importDisabled && !importBusy ? () => onImport(caseId) : undefined
                  })}
                />
              ) : null}

              <OrgCaseDetailsContent
                item={active}
                detail={detail}
                detailLoading={detailLoading}
                detailError={detailError}
                onRetryDetail={() => onLoadDetail(caseId)}
                onOpenLabSettings={onOpenLabSettings}
              />
            </>
          ) : detailErrorPresentation ? (
            <ErrorNotice
              level={detailErrorPresentation.level}
              title={detailErrorPresentation.title}
              description={detailErrorPresentation.description}
              {...orgCaseErrorNoticeActions(detailErrorPresentation, t, {
                onOpenLabSettings,
                onRetry: () => onLoadDetail(caseId)
              })}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t('Refreshing case details…')}</p>
          )}
        </div>
      </div>
    </section>
  )
}
