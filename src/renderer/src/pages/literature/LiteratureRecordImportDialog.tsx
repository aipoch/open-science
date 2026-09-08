/* Hallmark · component: import dialog · genre: modern-minimal · theme: Open Science
 * states: default · hover · focus · active · disabled · loading · error · success
 * pre-emit critique: P5 H4 E4 S5 R5 V4
 */
import { useState } from 'react'
import * as Dialog from '@/components/ui/dialog'
import { Check, Info, LoaderCircle, Upload, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { LiteratureErrorNotice } from './LiteratureErrorNotice'
import { Button } from '@/components/ui/button'
import {
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { LiteratureDuplicatePolicyField } from './LiteratureDuplicatePolicyField'
import type {
  LiteratureItemInput,
  LiteratureDuplicatePolicy,
  LiteratureItemType,
  LiteratureRecordImportResult
} from '../../../../shared/literature'

export type RecordImportDraft = Readonly<{
  reading?: boolean
  fileName: string
  content: string
  preview?: LiteratureRecordImportResult
  error?: string
  failedCount?: number
}>
const LITERATURE_IMPORT_PREVIEW_PAGE_SIZE = 100
export const LiteratureRecordImportDialog = ({
  recordImport,
  isImportingRecords,
  destination,
  itemDescription,
  itemTypeLabels,
  onClose,
  duplicatePolicy,
  onDuplicatePolicyChange,
  onImport
}: {
  recordImport: RecordImportDraft
  isImportingRecords: boolean
  destination: string
  itemDescription: (item: LiteratureItemInput) => string
  itemTypeLabels: Record<LiteratureItemType, string>
  onClose: () => void
  duplicatePolicy: LiteratureDuplicatePolicy
  onDuplicatePolicyChange: (value: LiteratureDuplicatePolicy) => void
  onImport: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [recordImportVisibleCount, setRecordImportVisibleCount] = useState(
    LITERATURE_IMPORT_PREVIEW_PAGE_SIZE
  )
  const invalidImportCount =
    recordImport.preview?.entries.filter((entry) => entry.status === 'invalid').length ?? 0
  const truncatedImportCount = recordImport.preview
    ? Math.max(0, recordImport.preview.scannedEntries - recordImport.preview.entries.length)
    : 0
  const skippedImportCount = invalidImportCount + truncatedImportCount
  const existingCount =
    recordImport.preview?.entries.filter((entry) => entry.status === 'existing').length ?? 0
  const conflictCount =
    recordImport.preview?.entries.filter((entry) => entry.status === 'conflict').length ?? 0
  const blockedByConflict = conflictCount > 0 && duplicatePolicy !== 'separate'
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !isImportingRecords) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName(
            'flex max-h-[calc(100dvh-2rem)] w-[min(740px,calc(100vw-2rem))] flex-col p-0'
          )}
        >
          <div className={cn(dialogHeaderClassName, 'shrink-0')}>
            <div className="min-w-0">
              <Dialog.Title className={dialogTitleClassName}>{t('Import references')}</Dialog.Title>
              <Dialog.Description
                className={cn(dialogDescriptionClassName, '[overflow-wrap:anywhere]')}
              >
                {recordImport.fileName}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={dialogCloseButtonClassName}
                disabled={isImportingRecords}
                aria-label={t('Close')}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 overflow-y-auto p-5">
            {recordImport.error && !recordImport.preview ? (
              <LiteratureErrorNotice title={recordImport.error} />
            ) : !recordImport.preview ? (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                {recordImport.reading ? t('Reading…') : t('Loading…')}
              </p>
            ) : (
              <div className="space-y-4">
                {recordImport.error ? <LiteratureErrorNotice title={recordImport.error} /> : null}
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="rounded border border-border-300/80 px-2 py-1 font-medium">
                    {recordImport.preview.format === 'nbib'
                      ? t('PubMed NBIB')
                      : recordImport.preview.format.toUpperCase()}
                  </span>
                  <span>
                    {t('{{count}} references', {
                      count: recordImport.preview.scannedEntries,
                      defaultValue_one: '{{count}} reference'
                    })}
                  </span>
                </div>
                <div className="flex min-w-0 items-baseline gap-2 text-sm">
                  <span className="shrink-0 text-muted-foreground">{t('Import to')}</span>
                  <span className="min-w-0 font-medium [overflow-wrap:anywhere]">
                    {destination}
                  </span>
                </div>
                {!recordImport.preview.imported && recordImport.failedCount === undefined ? (
                  <div
                    className={cn(
                      'grid divide-x divide-border-300/80 border-y border-border-300/80 py-3 text-center',
                      conflictCount > 0 ? 'grid-cols-4' : 'grid-cols-3'
                    )}
                  >
                    <div>
                      <strong className="block text-xl tabular-nums">
                        {recordImport.preview.items.length -
                          (duplicatePolicy === 'separate' ? 0 : existingCount + conflictCount)}
                      </strong>
                      <span className="text-xs text-muted-foreground">{t('New references')}</span>
                    </div>
                    <div>
                      <strong className="block text-xl tabular-nums">{existingCount}</strong>
                      <span className="text-xs text-muted-foreground">{t('Existing')}</span>
                    </div>
                    <div>
                      <strong className="block text-xl tabular-nums">{skippedImportCount}</strong>
                      <span className="text-xs text-muted-foreground">{t('Skipped')}</span>
                    </div>
                    {conflictCount > 0 ? (
                      <div>
                        <strong className="block text-xl tabular-nums">{conflictCount}</strong>
                        <span className="text-xs text-muted-foreground">
                          {t('Conflicting identifiers')}
                        </span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {!recordImport.preview.imported ? (
                  <LiteratureDuplicatePolicyField
                    value={duplicatePolicy}
                    onChange={onDuplicatePolicyChange}
                    disabled={isImportingRecords}
                  />
                ) : null}
                {conflictCount > 0 && !recordImport.preview.imported ? (
                  <LiteratureErrorNotice
                    title={t('Conflicting identifiers')}
                    description={t(
                      'Some identifiers disagree or match different references. Correct the source file or keep separate copies of every reference in this import.'
                    )}
                  />
                ) : null}
                {recordImport.preview.truncated && !recordImport.preview.imported ? (
                  <p
                    role="status"
                    className="flex items-start gap-2 rounded-lg bg-status-warning-surface px-3 py-2.5 text-sm text-status-warning-foreground dark:bg-status-warning-dark-surface dark:text-status-warning-dark-foreground"
                  >
                    <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <span>{t('Only the first 1,000 references will be imported.')}</span>
                  </p>
                ) : null}
                {isImportingRecords ? (
                  <p role="status" className="flex items-start gap-2 text-sm text-muted-foreground">
                    <LoaderCircle
                      className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                    {t('Saving references and authors. Large imports may take a moment.')}
                  </p>
                ) : recordImport.preview.imported ? (
                  <p role="status" className="flex items-center gap-2 text-sm font-medium">
                    <Check className="size-4 text-primary" aria-hidden="true" />
                    {t('Import complete')}
                  </p>
                ) : (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {duplicatePolicy === 'reuse' && conflictCount === 0
                      ? t(
                          'Matching DOI, PMID or PMCID references will be reused. PDFs are not downloaded.'
                        )
                      : t('PDFs are not downloaded.')}
                  </p>
                )}
                {recordImport.preview.items.length === 0 ? (
                  <p role="alert" className="text-sm text-danger-000">
                    {t('No valid references found.')}
                  </p>
                ) : null}
                {recordImport.preview.imported || recordImport.failedCount !== undefined ? (
                  <div className="grid grid-cols-2 gap-3 border-y border-border-300/80 py-3 text-center text-sm sm:grid-cols-4">
                    <div>
                      <strong className="block text-lg">
                        {recordImport.preview.imported?.createdCount ?? 0}
                      </strong>
                      <span className="text-xs text-muted-foreground">{t('Created')}</span>
                    </div>
                    <div>
                      <strong className="block text-lg">
                        {recordImport.preview.imported?.reusedCount ?? 0}
                      </strong>
                      <span className="text-xs text-muted-foreground">{t('Reused')}</span>
                    </div>
                    <div>
                      <strong className="block text-lg">{skippedImportCount}</strong>
                      <span className="inline-flex items-center justify-center gap-0.5 text-xs text-muted-foreground">
                        {t('Skipped')}
                        {skippedImportCount > 0 ? (
                          <TooltipProvider delayDuration={800}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-xs"
                                  className="-my-1 text-muted-foreground"
                                  aria-label={t('Why were references skipped?')}
                                >
                                  <Info className="size-3" aria-hidden="true" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="max-w-72 space-y-1 p-2">
                                {truncatedImportCount > 0 ? (
                                  <p>{t('References after the first 1,000 were skipped.')}</p>
                                ) : null}
                                {invalidImportCount > 0 ? (
                                  <p>
                                    {t(
                                      'Invalid references were skipped. Open View details to review their errors.'
                                    )}
                                  </p>
                                ) : null}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        ) : null}
                      </span>
                    </div>
                    <div>
                      <strong className="block text-lg">{recordImport.failedCount ?? 0}</strong>
                      <span className="text-xs text-muted-foreground">{t('Failed')}</span>
                    </div>
                  </div>
                ) : null}
                <details
                  key={recordImport.preview.imported ? 'imported' : 'preview'}
                  open={!recordImport.preview.imported}
                  className="overflow-hidden rounded-lg border border-border-300/80"
                >
                  <summary className="cursor-pointer bg-bg-100 px-3 py-2.5 text-sm font-medium hover:bg-bg-200 focus-visible:outline-2 focus-visible:outline-ring active:bg-bg-300">
                    {t('View details')} · {recordImport.preview.entries.length}
                  </summary>
                  <div className="max-h-[min(38vh,360px)] overflow-y-auto overscroll-contain divide-y divide-border-300/80 border-t border-border-300/80">
                    {recordImport.preview.entries
                      .slice(0, recordImportVisibleCount)
                      .map((entry) => (
                        <div
                          key={`${entry.index}:${entry.title}`}
                          className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-2 px-3 py-2.5"
                        >
                          <span
                            className="pt-0.5 text-xs tabular-nums text-muted-foreground"
                            aria-hidden="true"
                          >
                            {entry.index + 1}
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-start gap-2">
                              <p
                                title={entry.title}
                                className="min-w-0 flex-1 line-clamp-2 text-sm font-medium [overflow-wrap:anywhere]"
                              >
                                {entry.title || t('Unknown')}
                              </p>
                              {entry.status !== 'ready' ? (
                                <span className="shrink-0 rounded bg-bg-200 px-2 py-0.5 text-[11px] text-muted-foreground">
                                  {entry.status === 'conflict'
                                    ? t('Conflicting identifiers')
                                    : entry.status === 'existing'
                                      ? t('Existing')
                                      : entry.status === 'warning'
                                        ? t('Warning')
                                        : t('Invalid')}
                                </span>
                              ) : null}
                            </div>
                            {entry.item ? (
                              <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                                {itemDescription(entry.item) || itemTypeLabels[entry.item.itemType]}
                              </p>
                            ) : null}
                            {entry.conflict ? (
                              <div className="mt-1 space-y-1 text-xs [overflow-wrap:anywhere]">
                                <p>
                                  {entry.conflict.identifiers
                                    .map(({ scheme, value }) => `${scheme.toUpperCase()}: ${value}`)
                                    .join(' · ')}
                                </p>
                                {entry.conflict.matches.map((match) => (
                                  <p key={match.itemId ?? match.inputIndex}>
                                    {match.inputIndex === undefined
                                      ? t('Library reference: {{title}}', { title: match.title })
                                      : t('File reference {{number}}: {{title}}', {
                                          number: match.inputIndex + 1,
                                          title: match.title
                                        })}
                                  </p>
                                ))}
                              </div>
                            ) : null}
                            {entry.warnings.length > 0 ? (
                              <p className="mt-1 text-xs text-status-warning-foreground dark:text-status-warning-dark-foreground">
                                {entry.warnings
                                  .map((warning) =>
                                    warning === 'uncertain-author-name'
                                      ? t('Check author names. Original text is kept in Extra.')
                                      : warning === 'missing-authors'
                                        ? t('Missing authors')
                                        : warning === 'missing-year'
                                          ? t('Missing year')
                                          : t('Missing journal or venue')
                                  )
                                  .join(' · ')}
                              </p>
                            ) : entry.error ? (
                              <p className="mt-1 line-clamp-2 text-xs text-danger-000">
                                {entry.error}
                              </p>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    {recordImportVisibleCount < recordImport.preview.entries.length ? (
                      <div className="flex justify-center border-t border-border-300/80 p-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setRecordImportVisibleCount((count) =>
                              Math.min(
                                count + LITERATURE_IMPORT_PREVIEW_PAGE_SIZE,
                                recordImport.preview!.entries.length
                              )
                            )
                          }
                        >
                          {t('Show more')}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </details>
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-border-300/80 px-5 py-4">
            {recordImport.preview?.imported ? (
              <Button type="button" onClick={() => onClose()}>
                {t('Done')}
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isImportingRecords}
                  onClick={() => onClose()}
                >
                  {t('Cancel')}
                </Button>
                <Button
                  type="button"
                  disabled={
                    isImportingRecords ||
                    blockedByConflict ||
                    !recordImport.preview ||
                    recordImport.preview.items.length === 0
                  }
                  onClick={() => onImport()}
                >
                  {isImportingRecords ? (
                    <LoaderCircle
                      className="size-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <Upload className="size-4" aria-hidden="true" />
                  )}
                  {isImportingRecords ? t('Importing…') : t('Import references')}
                </Button>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
