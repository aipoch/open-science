import { useTranslation } from 'react-i18next'
import { Download, X } from 'lucide-react'
import type {
  OrgCaseDetail,
  OrgCaseDownloadSnapshot,
  OrgCaseErrorCode,
  OrgCaseItem
} from '../../../../shared/org-cases'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import * as Dialog from '@/components/ui/dialog'
import { describeOrgCaseError, formatOrgCaseDownloadLabel } from './org-case-errors'
import { OrgCaseDetailsContent } from './OrgCaseDetailsContent'

export const OrgCaseDetailsDialog = ({
  open,
  onOpenChange,
  item,
  detail,
  detailLoading,
  detailError,
  download,
  downloadError,
  importBusy,
  onRetryDetail,
  onImport,
  onCancelImport,
  onDismissDownloadError,
  onOpenLabSettings
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: OrgCaseItem | null
  detail?: OrgCaseDetail | null
  detailLoading?: boolean
  detailError?: OrgCaseErrorCode | null
  download: OrgCaseDownloadSnapshot | null
  downloadError: OrgCaseErrorCode | null
  importBusy: boolean
  onRetryDetail: () => void
  onImport: (caseId: string) => void
  onCancelImport: (caseId: string) => void
  onDismissDownloadError: () => void
  onOpenLabSettings: () => void
}): React.JSX.Element | null => {
  const { t } = useTranslation()

  if (!item) return null

  const isDownloading = download?.caseId === item.id
  const progressPercent =
    isDownloading && download.totalBytes && download.totalBytes > 0
      ? Math.min(
          100,
          Math.max(0, Math.round((download.completedBytes / download.totalBytes) * 100))
        )
      : 0
  const downloadErrorPresentation = downloadError ? describeOrgCaseError(downloadError, t) : null

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/45 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-label={t('Organization case details')}
          className="fixed left-1/2 top-1/2 flex max-h-[85vh] w-[min(92vw,42rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-bg-000 shadow-xl focus:outline-none"
        >
          <div className="flex items-start justify-between gap-4 border-b border-border/80 px-5 py-4">
            <div className="min-w-0 space-y-1">
              <Dialog.Title className="truncate text-base font-semibold text-foreground">
                {detail?.name ?? item.name}
              </Dialog.Title>
              <Dialog.Description className="text-xs text-muted-foreground">
                {t('Organization case details and package summary')}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t('Close')}>
                <X className="h-4 w-4" />
              </Button>
            </Dialog.Close>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            <OrgCaseDetailsContent
              item={item}
              detail={detail}
              detailLoading={detailLoading}
              detailError={detailError}
              onRetryDetail={onRetryDetail}
              onOpenLabSettings={onOpenLabSettings}
            />

            {downloadErrorPresentation ? (
              <ErrorNotice
                inline
                level={downloadErrorPresentation.level}
                title={downloadErrorPresentation.title}
                description={downloadErrorPresentation.description}
                dismissButton={{ label: t('Dismiss'), onClick: onDismissDownloadError }}
                primaryButton={
                  downloadErrorPresentation.canOpenLabSettings
                    ? { label: t('Open Lab Settings'), onClick: onOpenLabSettings }
                    : downloadErrorPresentation.canRetry
                      ? { label: t('Retry'), onClick: () => onImport(item.id) }
                      : undefined
                }
              />
            ) : null}

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
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-[width] duration-200"
                    style={{ width: `${download.state === 'verifying' ? 100 : progressPercent}%` }}
                  />
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border/80 px-5 py-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('Close')}
            </Button>
            {isDownloading ? (
              <Button type="button" variant="destructive" onClick={() => onCancelImport(item.id)}>
                <X className="mr-1.5 h-4 w-4" />
                {t('Cancel')}
              </Button>
            ) : (
              <Button type="button" disabled={importBusy} onClick={() => onImport(item.id)}>
                <Download className="mr-1.5 h-4 w-4" />
                {t('Import')}
              </Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
