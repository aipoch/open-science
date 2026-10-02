import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import * as Dialog from '@/components/ui/dialog'
import {
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { PreviewFileItem } from '@/stores/preview-workbench-store'
import { ArrowLeft, Download, MoreHorizontal, Pencil, Quote, Search, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  LiteratureCitationStyleView,
  LiteratureItemType,
  LiteratureItemView,
  LiteratureMetadataField
} from '../../../../../shared/literature'
import { LiteratureCitationPanel } from './LiteratureCitationPanel'
import type { LiteratureDetailController } from './LiteratureDetailController'
import { type LiteratureDetailSnapshot } from './LiteratureDetailController'
import { LiteratureFullTextLookup } from './LiteratureFullTextLookup'
import { LiteratureMetadataCompletion } from './LiteratureMetadataCompletion'
import { LiteratureMetadataEditor } from './LiteratureMetadataEditor'
import { fullCreatorLabel, publicationSummary } from '../literature-item-display'
import type { useLiteratureMetadata } from '../workflows/useLiteratureMetadata'
const LiteratureDetailBoundary = ({
  children,
  controller
}: Readonly<{
  children: (snapshot: LiteratureDetailSnapshot) => ReactNode
  controller: LiteratureDetailController
}>): React.JSX.Element => {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  )
  return <>{children(snapshot)}</>
}
const hasLiteratureDetailChildLayer = (): boolean =>
  Boolean(
    document.querySelector(
      '[data-slot="dropdown-menu-content"], [data-slot="select-content"], [data-radix-popper-content-wrapper]'
    )
  )
export function LiteratureDetailDialog({
  detailController,
  previewItem,
  selectedItemDialogRef,
  detailTagMenuOpenRef,
  detailSelectOpenRef,
  childLayerDismissGuardUntilRef,
  closeSelectedItemDetail,
  detailInitiatorRef,
  libraryEntryRef,
  metadata,
  discardMetadataDialog,
  leaveMetadataEditor,
  itemTypeLabels,
  changeDetailMode,
  isAddingPdf,
  pdfStaging,
  pdfInputRef,
  updateMetadataItem,
  loadEntries,
  trackMetadataDirty,
  removedDetailItemId,
  metadataFieldLabel,
  handleDetailSelectOpenChange,
  citationStyleRef,
  citationLocale,
  citationStyles,
  setJournalsOpen,
  setCitationStylesOpen,
  renderOverview
}: {
  detailController: LiteratureDetailController
  previewItem: PreviewFileItem | undefined
  selectedItemDialogRef: React.RefObject<HTMLDivElement | null>
  detailTagMenuOpenRef: React.RefObject<boolean>
  detailSelectOpenRef: React.RefObject<boolean>
  childLayerDismissGuardUntilRef: React.RefObject<number>
  closeSelectedItemDetail: () => void
  detailInitiatorRef: React.RefObject<HTMLElement | null>
  libraryEntryRef: React.RefObject<HTMLButtonElement | null>
  metadata: ReturnType<typeof useLiteratureMetadata>
  discardMetadataDialog: React.JSX.Element
  leaveMetadataEditor: () => void
  itemTypeLabels: Record<LiteratureItemType, string>
  changeDetailMode: ReturnType<typeof useLiteratureMetadata>['changeMode']
  isAddingPdf: boolean
  pdfStaging: { notice: React.ReactNode }
  pdfInputRef: React.RefObject<HTMLInputElement | null>
  updateMetadataItem: (updated: LiteratureItemView) => void
  loadEntries: (force?: boolean, preservePage?: boolean) => Promise<boolean | undefined>
  trackMetadataDirty: (dirty: boolean) => void
  removedDetailItemId: string | undefined
  metadataFieldLabel: (field: LiteratureMetadataField) => string
  handleDetailSelectOpenChange: (open: boolean) => void
  citationStyleRef: React.RefObject<string>
  citationLocale: 'zh-CN' | 'en-US'
  citationStyles: LiteratureCitationStyleView[] | undefined
  setJournalsOpen: React.Dispatch<React.SetStateAction<boolean>>
  setCitationStylesOpen: React.Dispatch<React.SetStateAction<boolean>>
  renderOverview: (item: LiteratureItemView) => React.ReactNode
}): React.JSX.Element | null {
  const { t } = useTranslation()
  return (
    <LiteratureDetailBoundary controller={detailController}>
      {({ item: selectedItem, open, generation }) => {
        return (
          <Dialog.Root open={open}>
            {selectedItem ? (
              <Dialog.Portal>
                {/* Keep the panel and scrim mounted while the portaled preview owns focus.
                    Only release Radix's scroll lock: changing Root.modal remounts Content. */}
                {!previewItem ? <Dialog.Overlay className="hidden" /> : null}
                <div
                  aria-hidden="true"
                  data-state={open ? 'open' : 'closed'}
                  className={cn(dialogOverlayClassName, 'pointer-events-auto')}
                  onPointerDownCapture={(event) => {
                    const dialogBounds = selectedItemDialogRef.current?.getBoundingClientRect()
                    const pointInsideDialog = Boolean(
                      dialogBounds &&
                      event.clientX >= dialogBounds.left &&
                      event.clientX <= dialogBounds.right &&
                      event.clientY >= dialogBounds.top &&
                      event.clientY <= dialogBounds.bottom
                    )

                    if (pointInsideDialog) {
                      event.preventDefault()
                      event.stopPropagation()
                    }
                  }}
                  onClick={(event) => {
                    const dialogBounds = selectedItemDialogRef.current?.getBoundingClientRect()
                    const pointInsideDialog = Boolean(
                      dialogBounds &&
                      event.clientX >= dialogBounds.left &&
                      event.clientX <= dialogBounds.right &&
                      event.clientY >= dialogBounds.top &&
                      event.clientY <= dialogBounds.bottom
                    )

                    if (
                      pointInsideDialog ||
                      detailTagMenuOpenRef.current ||
                      detailSelectOpenRef.current ||
                      Date.now() <= childLayerDismissGuardUntilRef.current ||
                      hasLiteratureDetailChildLayer()
                    ) {
                      return
                    }

                    closeSelectedItemDetail()
                  }}
                />
                <Dialog.Content
                  ref={selectedItemDialogRef}
                  onCloseAutoFocus={(event) => {
                    event.preventDefault()
                    if (detailController.getSnapshot().open || previewItem) return
                    const initiator = detailInitiatorRef.current
                    if (initiator?.isConnected && !initiator.closest('[inert], [hidden]')) {
                      initiator.focus()
                      if (document.activeElement === initiator && initiator !== document.body)
                        return
                    }
                    libraryEntryRef.current?.focus()
                  }}
                  className={dialogPanelClassName(
                    cn(
                      'flex w-[min(760px,calc(100vw-2rem))] flex-col p-0',
                      metadata.mode === 'full-text'
                        ? 'max-h-[calc(100vh-2rem)]'
                        : 'h-[min(840px,calc(100vh-2rem))]'
                    )
                  )}
                  onInteractOutside={(event) => {
                    event.preventDefault()
                  }}
                  onEscapeKeyDown={(event) => {
                    event.preventDefault()
                    if (
                      detailSelectOpenRef.current ||
                      detailTagMenuOpenRef.current ||
                      Date.now() <= childLayerDismissGuardUntilRef.current
                    ) {
                      return
                    }
                    closeSelectedItemDetail()
                  }}
                >
                  {discardMetadataDialog}
                  <div className={cn(dialogHeaderClassName, 'shrink-0 items-start px-5 py-3')}>
                    <div className="flex min-w-0 flex-1 items-start gap-2">
                      {metadata.mode !== 'view' ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0"
                          aria-label={t('Back')}
                          disabled={metadata.saving}
                          onClick={leaveMetadataEditor}
                        >
                          <ArrowLeft className="size-4" aria-hidden="true" />
                        </Button>
                      ) : null}
                      <div className="min-w-0 flex-1">
                        {metadata.mode !== 'view' ? (
                          <>
                            <Dialog.Title className={cn(dialogTitleClassName, 'truncate')}>
                              {metadata.mode === 'edit'
                                ? t('Edit metadata')
                                : metadata.mode === 'complete'
                                  ? t('Complete metadata')
                                  : metadata.mode === 'full-text'
                                    ? t('Find full-text PDF')
                                    : t('Citation')}
                            </Dialog.Title>
                            <Dialog.Description
                              className={cn(dialogDescriptionClassName, 'mt-0.5 truncate text-xs')}
                            >
                              {selectedItem.item.title}
                            </Dialog.Description>
                          </>
                        ) : (
                          <>
                            <div className="mb-1.5 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground">
                              <span className="rounded bg-bg-200 px-1.5 py-0.5 font-medium text-foreground">
                                {itemTypeLabels[selectedItem.item.itemType]}
                              </span>
                              {publicationSummary(selectedItem.item) ? (
                                <span className="min-w-0 break-words">
                                  {publicationSummary(selectedItem.item)}
                                </span>
                              ) : null}
                            </div>
                            <Dialog.Title
                              className={cn(
                                dialogTitleClassName,
                                'line-clamp-3 break-words leading-snug'
                              )}
                            >
                              {selectedItem.item.title}
                            </Dialog.Title>
                            <Dialog.Description className="sr-only">
                              {fullCreatorLabel(selectedItem.item) ||
                                itemTypeLabels[selectedItem.item.itemType]}
                            </Dialog.Description>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {metadata.mode === 'view' ? (
                        <DropdownMenu modal={false}>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              className="transition-none"
                              aria-label={t('More actions')}
                            >
                              <MoreHorizontal className="size-4" aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onSelect={() => {
                                changeDetailMode('edit')
                              }}
                            >
                              <Pencil className="mr-2 size-4" aria-hidden="true" />
                              {t('Edit metadata')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => {
                                metadata.resetCompletion()
                                changeDetailMode('complete')
                              }}
                            >
                              <Search className="mr-2 size-4" aria-hidden="true" />
                              {t('Complete metadata')}
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => changeDetailMode('full-text')}>
                              <Download className="mr-2 size-4" aria-hidden="true" />
                              {t('Find full-text PDF')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => {
                                changeDetailMode('citation')
                              }}
                            >
                              <Quote className="mr-2 size-4" aria-hidden="true" />
                              {t('Citation')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className={dialogCloseButtonClassName}
                        aria-label={t('Close')}
                        disabled={isAddingPdf || metadata.saving}
                        onClick={closeSelectedItemDetail}
                      >
                        <X className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>
                  {isAddingPdf ? pdfStaging.notice : null}
                  {metadata.mode === 'full-text' ? (
                    <LiteratureFullTextLookup
                      key={`${selectedItem.id}:${selectedItem.metadataRevision}`}
                      item={selectedItem}
                      onCompleteMetadata={() => changeDetailMode('complete')}
                      onUpload={() => {
                        changeDetailMode('view')
                        requestAnimationFrame(() => pdfInputRef.current?.click())
                      }}
                      onAdded={(updated) => {
                        updateMetadataItem(updated)
                        if (detailController.getSnapshot().generation === generation) {
                          detailController.replace(updated)
                          changeDetailMode('view')
                        }
                        void loadEntries(true)
                      }}
                    />
                  ) : metadata.mode === 'edit' ? (
                    <>
                      {metadata.awaitingReload || metadata.externallyUpdated() ? (
                        <ErrorNotice
                          className="mx-5 mt-4 w-auto shrink-0"
                          role="alert"
                          tone="amber"
                          description={
                            metadata.awaitingReload
                              ? t('The reference was saved, but could not be reloaded.')
                              : t(
                                  'This reference changed while you were editing. Your draft has been kept.'
                                )
                          }
                          primaryButton={
                            metadata.awaitingReload
                              ? {
                                  label: t('Retry'),
                                  loading: metadata.saving,
                                  onClick: () => void metadata.reloadSaved()
                                }
                              : {
                                  label: t('Load latest version'),
                                  disabled: metadata.saving,
                                  description: t(
                                    'Discard this draft and load the latest saved metadata.'
                                  ),
                                  onClick: metadata.loadLatest
                                }
                          }
                        />
                      ) : null}
                      <LiteratureMetadataEditor
                        onDirtyChange={trackMetadataDirty}
                        key={`${selectedItem.id}:${metadata.editBase?.metadataRevision}`}
                        item={metadata.editBase?.item ?? selectedItem.item}
                        saving={metadata.saving || metadata.awaitingReload}
                        saveDisabled={
                          metadata.externallyUpdated() || removedDetailItemId === selectedItem.id
                        }
                        error={
                          removedDetailItemId === selectedItem.id
                            ? t('This reference is no longer in your Library.')
                            : metadata.awaitingReload || metadata.externallyUpdated()
                              ? undefined
                              : metadata.error
                        }
                        className="min-h-0 flex-1 max-h-none"
                        onCancel={leaveMetadataEditor}
                        onSave={(item) => void metadata.save(item)}
                      />
                    </>
                  ) : metadata.mode === 'complete' ? (
                    <LiteratureMetadataCompletion
                      selectedItem={selectedItem}
                      metadata={metadata}
                      metadataFieldLabel={metadataFieldLabel}
                      onOpenChange={handleDetailSelectOpenChange}
                    />
                  ) : metadata.mode === 'citation' ? (
                    <LiteratureCitationPanel
                      key={`${selectedItem.id}:${selectedItem.metadataRevision}`}
                      initialStyle={citationStyleRef.current}
                      itemId={selectedItem.id}
                      locale={citationLocale}
                      styles={citationStyles}
                      onOpenChange={handleDetailSelectOpenChange}
                      onStyleChange={(style) => {
                        citationStyleRef.current = style
                      }}
                      onManageStyles={() => {
                        closeSelectedItemDetail()
                        setJournalsOpen(false)
                        setCitationStylesOpen(true)
                      }}
                    />
                  ) : (
                    renderOverview(selectedItem)
                  )}
                </Dialog.Content>
              </Dialog.Portal>
            ) : null}
          </Dialog.Root>
        )
      }}
    </LiteratureDetailBoundary>
  )
}
