import { useTranslation } from 'react-i18next'
import { Download, LoaderCircle, X } from 'lucide-react'
import type {
  OrgCaseDetail,
  OrgCaseDownloadSnapshot,
  OrgCaseErrorCode,
  OrgCaseItem
} from '../../../../shared/org-cases'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import * as Dialog from '@/components/ui/dialog'
import {
  dialogBodyClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { usePackageOperationStore } from '@/stores/package-operation-store'
import {
  describeOrgCaseError,
  formatOrgCaseDownloadLabel,
  orgCaseErrorNoticeActions
} from './org-case-errors'
import { OrgCaseDetailsContent } from './OrgCaseDetailsContent'

export const OrgCaseDetailsDialog = ({
  open,
  onOpenChange,
  caseId,
  item,
  detail,
  detailLoading,
  detailError,
  download,
  downloadError,
  importBusy,
  importDisabled = false,
  onRestoreFocus,
  onRetryDetail,
  onImport,
  onCancelImport,
  onDismissDownloadError,
  onOpenLabSettings
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  caseId?: string
  item: OrgCaseItem | null
  detail?: OrgCaseDetail | null
  detailLoading?: boolean
  detailError?: OrgCaseErrorCode | null
  download: OrgCaseDownloadSnapshot | null
  downloadError: OrgCaseErrorCode | null
  importBusy: boolean
  importDisabled?: boolean
  onRestoreFocus?: () => void
  onRetryDetail: () => void
  onImport: (caseId: string) => void
  onCancelImport: (caseId: string) => void
  onDismissDownloadError: () => void
  onOpenLabSettings?: () => void
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const importDialogOpen = usePackageOperationStore((state) => state.open)

  const targetId = detail?.id ?? item?.id ?? caseId
  if (!targetId) return null

  const activeItem = detail ?? item
  const isDownloading = download?.caseId === targetId
  const progressPercent =
    isDownloading && download.totalBytes && download.totalBytes > 0
      ? Math.min(
          100,
          Math.max(0, Math.round((download.completedBytes / download.totalBytes) * 100))
        )
      : 0
  const detailErrorPresentation =
    !activeItem && detailError ? describeOrgCaseError(detailError, t) : null
  const downloadErrorPresentation = downloadError ? describeOrgCaseError(downloadError, t) : null

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          aria-label={t('Organization case details')}
          onEscapeKeyDown={(event) => {
            if (isDownloading) event.preventDefault()
          }}
          onInteractOutside={(event) => {
            const fromDialog =
              event.target instanceof Element && event.target.closest('[role="dialog"]')
            if (importDialogOpen || isDownloading || fromDialog) event.preventDefault()
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (!usePackageOperationStore.getState().open) {
              onRestoreFocus?.()
            }
          }}
          className={dialogPanelClassName('flex w-[min(92vw,42rem)] flex-col overflow-hidden p-0')}
        >
          <div className={dialogHeaderClassName}>
            <div className="min-w-0">
              <Dialog.Title className={dialogTitleClassName}>
                {activeItem?.name ?? t('Organization case details')}
              </Dialog.Title>
              <Dialog.Description className={dialogDescriptionClassName}>
                {t('Organization case details and package summary')}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t('Close')}>
                <X className="h-4 w-4" />
              </Button>
            </Dialog.Close>
          </div>

          <div className={`${dialogBodyClassName} flex-1 space-y-4 overflow-y-auto`}>
            {activeItem ? (
              <OrgCaseDetailsContent
                item={activeItem}
                detail={detail}
                detailLoading={detailLoading}
                detailError={detailError}
                onRetryDetail={onRetryDetail}
                onOpenLabSettings={onOpenLabSettings}
              />
            ) : detailErrorPresentation ? (
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
            ) : (
              <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="h-4 w-4 animate-spin" />
                <span>{t('Refreshing case details…')}</span>
              </div>
            )}

            {downloadErrorPresentation ? (
              <ErrorNotice
                inline
                level={downloadErrorPresentation.level}
                title={downloadErrorPresentation.title}
                description={downloadErrorPresentation.description}
                dismissButton={{ label: t('Dismiss'), onClick: onDismissDownloadError }}
                {...orgCaseErrorNoticeActions(downloadErrorPresentation, t, {
                  onOpenLabSettings,
                  onRetry: !importDisabled && !importBusy ? () => onImport(targetId) : undefined
                })}
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
                    style={{ width: `${download.state === 'verifying' ? 100 : progressPercent}%` }}
                  />
                </div>
              </div>
            ) : null}
          </div>

          <div className={dialogFooterClassName}>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('Close')}
            </Button>
            {activeItem ? (
              isDownloading ? (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => onCancelImport(targetId)}
                >
                  <X className="mr-1.5 h-4 w-4" />
                  {t('Cancel')}
                </Button>
              ) : (
                <Button
                  type="button"
                  disabled={importBusy || importDisabled || detailError === 'not-found'}
                  onClick={() => onImport(targetId)}
                >
                  <Download className="mr-1.5 h-4 w-4" />
                  {t('Import')}
                </Button>
              )
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
