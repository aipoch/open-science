import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import * as Dialog from '@/components/ui/dialog'
import {
  CircleCheck,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Pencil,
  StepForward,
  X
} from 'lucide-react'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'
import { ErrorNotice } from '@/components/error-notice'
import type {
  ComparisonCell,
  ComparisonField,
  ComparisonRequest,
  ComparisonResult
} from '../../../../../shared/literature-comparison'
import { comparisonCellView, type ComparisonEvidenceTarget } from './comparison-display'

type ReviewProps = {
  onExtractCell?: () => void
  extractionBlocked?: boolean
  inline?: boolean
  navigation?: {
    position: number
    total: number
    reviewed: number
    onPrevious: () => void
    onNext: () => void
    hasNextAwaiting?: boolean
    onNextAwaiting?: () => void
  }
  loadCellHistory?: (tableId: string, cellId: string) => Promise<ComparisonCell>
  panelRef?: React.Ref<HTMLDivElement>
  onDraftStatusChange?: (status: { pending: boolean; failed: boolean }) => void
  referenceTitle?: string
  tableId: string
  sourceKey: string
  cell: ComparisonCell
  field: ComparisonField
  onClose: () => void
  onOpenItem: (target: ComparisonEvidenceTarget) => void
  command: (request: ComparisonRequest) => Promise<ComparisonResult>
}

export function ComparisonCellReview({
  panelRef,
  inline = false,
  onClose,
  onDraftStatusChange,
  ...props
}: ReviewProps): React.JSX.Element {
  const { t } = useTranslation()
  const { navigation } = props
  const blockedRef = useRef(false)
  const [blocked, setBlocked] = useState(false)
  const report = useCallback(
    (status: { pending: boolean; failed: boolean }) => {
      blockedRef.current = status.pending || status.failed
      setBlocked(blockedRef.current)
      onDraftStatusChange?.(status)
    },
    [onDraftStatusChange]
  )
  // Keep the cell's save queue mounted when resizing moves its controls between surfaces.
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const bodySlot = <div ref={setHost} className="flex min-h-0 flex-1 flex-col" />
  const navigationControls = navigation && (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={blocked || navigation.position <= 1}
        aria-label={t('Previous cell')}
        title={t('Previous cell')}
        onClick={navigation.onPrevious}
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
      </Button>
      <span
        className="text-xs tabular-nums text-muted-foreground"
        title={t('Reviewed cells: {{reviewed}}', { reviewed: navigation.reviewed })}
      >
        {navigation.position}/{navigation.total}{' '}
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={blocked || navigation.position >= navigation.total}
        aria-label={t('Next cell')}
        title={t('Next cell')}
        onClick={navigation.onNext}
      >
        <ChevronRight aria-hidden="true" className="size-4" />
      </Button>
    </div>
  )
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !blockedRef.current) onClose()
      }}
    >
      {inline ? (
        <div
          ref={panelRef}
          role="complementary"
          aria-label={t('Review cell')}
          className="flex min-h-0 w-[clamp(20rem,33vw,32rem)] shrink-0 flex-col border-l border-border bg-card"
        >
          <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border px-5">
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t('Review cell')}</h2>
            {navigationControls}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('Close')}
              title={t('Close')}
              disabled={blocked}
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </Button>
          </header>
          {bodySlot}
        </div>
      ) : (
        <Dialog.DrawerContent
          title={t('Review cell')}
          closeLabel={t('Close')}
          closeDisabled={blocked}
          headerActions={navigationControls}
          ref={panelRef}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {bodySlot}
        </Dialog.DrawerContent>
      )}
      <CellReviewBody
        key={JSON.stringify([props.tableId, props.cell.id])}
        {...props}
        host={host}
        onClose={onClose}
        onDraftStatusChange={report}
      />
    </Dialog.Root>
  )
}
function CellReviewBody({
  host,
  onExtractCell,
  extractionBlocked,
  referenceTitle,
  tableId,
  sourceKey,
  cell,
  field,
  onClose,
  onOpenItem,
  command,
  loadCellHistory,
  onDraftStatusChange,
  navigation
}: ReviewProps & { host: HTMLDivElement | null }): React.JSX.Element | null {
  const { t } = useTranslation()
  const formatDate = useDateTimeFormat()
  const [draft, setDraft] = useState(cell.manual?.value ?? '')
  const [editRequested, setEditRequested] = useState(false)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (editRequested) editorRef.current?.focus()
  }, [editRequested])
  const [manualEdited, setManualEdited] = useState(Boolean(cell.manual))
  // Saved manual values remain pristine until this review queues a local write.
  const draftDirty = useRef(false)
  const [localWrite, setLocalWrite] = useState(false)
  const [loadedHistory, setLoadedHistory] = useState<{
    key: string
    evidenceKey: string
    cell: ComparisonCell
  }>()
  const [historyError, setHistoryError] = useState(false)
  const [retry, setRetry] = useState(0)
  const latestAttemptId = cell.history.at(-1)?.id
  const evidenceKey = JSON.stringify([
    tableId,
    cell.id,
    latestAttemptId,
    field.version,
    sourceKey,
    cell.status
  ])
  const historyKey = JSON.stringify([evidenceKey, cell.manual])
  const evidenceReady = !loadCellHistory || loadedHistory?.evidenceKey === evidenceKey
  const historyReady =
    !loadCellHistory || loadedHistory?.key === historyKey || (localWrite && evidenceReady)
  useEffect(() => {
    if (!loadCellHistory || historyReady) return
    let active = true
    void loadCellHistory(tableId, cell.id).then(
      (loaded) => {
        if (!active) return
        // A new attempt arriving mid-read requires a new projection before confirmation.
        if (loaded.history.at(-1)?.id !== latestAttemptId) {
          setHistoryError(true)
          return
        }
        if (!draftDirty.current) {
          setDraft(loaded.manual?.value ?? '')
          setManualEdited(Boolean(loaded.manual))
        }
        setLoadedHistory({ key: historyKey, evidenceKey, cell: loaded })
        setHistoryError(false)
      },
      () => {
        if (active) setHistoryError(true)
      }
    )
    return () => {
      active = false
    }
  }, [
    loadCellHistory,
    tableId,
    cell.id,
    latestAttemptId,
    evidenceKey,
    historyKey,
    historyReady,
    retry
  ])
  const reviewCell =
    loadedHistory && evidenceReady
      ? loadedHistory.key === historyKey
        ? loadedHistory.cell
        : { ...cell, history: loadedHistory.cell.history }
      : cell
  const view = comparisonCellView(reviewCell, field, sourceKey)
  const [pending, setPending] = useState(0)
  const saving = pending > 0
  const [slowSave, setSlowSave] = useState(false)
  useEffect(() => {
    if (!saving) return
    const timer = setTimeout(() => setSlowSave(true), 400)
    return () => clearTimeout(timer)
  }, [saving])
  const [failed, setFailed] = useState(false)
  const queue = useRef(Promise.resolve())
  const queuedDraft = useRef<Extract<ComparisonRequest, { action: 'edit-cell' }> | undefined>(
    undefined
  )
  const pendingCount = useRef(0)
  const failedSave = useRef(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const discardFocus = useRef<HTMLElement | null>(null)
  const discarded = useRef(false)
  const save = (value: string, confirmed: boolean): void => {
    draftDirty.current = true
    setLocalWrite(true)
    // Bind at edit time: queued saves must not adopt a refreshed rule or source.
    const request: ComparisonRequest = {
      action: 'edit-cell',
      tableId,
      cellId: cell.id,
      value,
      confirmed,
      expectedFieldVersion: field.version,
      expectedSourceKey: sourceKey,
      ...(confirmed && view.attempt ? { expectedAttemptId: view.attempt.id } : {})
    }
    const queued = queuedDraft.current
    if (
      !confirmed &&
      queued &&
      queued.tableId === tableId &&
      queued.cellId === cell.id &&
      queued.expectedSourceKey === sourceKey &&
      queued.expectedFieldVersion === field.version
    ) {
      queued.value = value
      return
    }
    queuedDraft.current = confirmed ? undefined : request
    // A short batching window caps write frequency while the navigation guard remains active.
    const ready = confirmed ? undefined : new Promise<void>((resolve) => setTimeout(resolve, 200))
    pendingCount.current += 1
    onDraftStatusChange?.({ pending: true, failed: failedSave.current })
    setPending((count) => count + 1)
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        try {
          await ready
          if (queuedDraft.current === request) queuedDraft.current = undefined
          await command(request)
          failedSave.current = false
          setFailed(false)
        } catch {
          failedSave.current = true
          setFailed(true)
        } finally {
          pendingCount.current -= 1
          if (pendingCount.current === 0) setSlowSave(false)
          onDraftStatusChange?.({ pending: pendingCount.current > 0, failed: failedSave.current })
          setPending((count) => count - 1)
        }
      })
  }
  const confirmationDisabled =
    pending > 0 ||
    failed ||
    view.stale ||
    !historyReady ||
    reviewCell.status !== 'succeeded' ||
    view.attempt?.status !== 'succeeded'
  const needsExtraction =
    historyReady &&
    (view.stale || reviewCell.status !== 'succeeded' || view.attempt?.status !== 'succeeded')
  const confirmValue = (value: string): void => {
    setDraft(value)
    save(value, true)
  }
  const attempts = evidenceReady ? [...reviewCell.history].reverse() : []
  const showEditor = editRequested || manualEdited || failed
  const revise = !showEditor && (
    <Button
      size="sm"
      variant="ghost"
      className="gap-1.5 text-muted-foreground"
      onClick={() => setEditRequested(true)}
    >
      <Pencil aria-hidden="true" />
      {t('Revise')}
    </Button>
  )
  const renderAttempt = (
    attempt: ComparisonCell['history'][number],
    index: number
  ): React.JSX.Element => (
    <section key={attempt.id} className="min-w-0 text-sm">
      <h3 className="mb-1 text-xs font-medium text-muted-foreground">
        {index === 0
          ? t('Latest machine result')
          : t('Field version {{version}}', { version: attempt.fieldVersion })}
      </h3>
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 whitespace-pre-wrap text-lg font-semibold leading-snug">
          {attempt.value ||
            (attempt.status === 'failed' ? t('Extraction failed') : t('Insufficient evidence'))}
        </p>
        {index === 0 && revise}
        {index === 0 &&
          manualEdited &&
          draft !== (attempt.value ?? '') &&
          attempt.status === 'succeeded' && (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              disabled={confirmationDisabled}
              aria-label={t('Adopt latest machine value and confirm evidence')}
              title={t('Adopt latest machine value and confirm evidence')}
              onClick={() => confirmValue(attempt.value ?? '')}
            >
              {t('Use and confirm')}
            </Button>
          )}
      </div>
      <div className="mt-3 border-l-2 border-primary/40 pl-4">
        {attempt.evidence.map((evidence, index) => (
          <blockquote key={index} className="mb-1 leading-6">
            <p className="whitespace-pre-wrap">{evidence.quote}</p>
            {evidence.pageStart !== null && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t('Pages {{start}}–{{end}}', {
                  start: evidence.pageStart,
                  end: evidence.pageEnd ?? evidence.pageStart
                })}
              </p>
            )}
          </blockquote>
        ))}
        <Button
          className="h-auto gap-1.5 px-0 py-1 text-xs"
          variant="link"
          size="sm"
          onClick={() =>
            onOpenItem(
              (attempt.coverage === 'full-text' || attempt.coverage === 'passages') &&
                attempt.attachmentVersionId
                ? {
                    kind: 'document',
                    itemId: cell.itemId,
                    attachmentVersionId: attempt.attachmentVersionId,
                    page: attempt.evidence[0]?.pageStart ?? undefined
                  }
                : { kind: 'reference', itemId: cell.itemId }
            )
          }
        >
          <ExternalLink className="size-3.5" aria-hidden="true" />
          {(attempt.coverage === 'full-text' || attempt.coverage === 'passages') &&
          attempt.attachmentVersionId
            ? t('Open source page')
            : t('Open reference')}
        </Button>
      </div>
      <details className="mt-3 text-xs text-muted-foreground">
        <summary className="w-fit cursor-pointer rounded-sm font-medium focus-visible:keyboard-focus">
          {t('Details')}
        </summary>
        <div className="mt-2 space-y-1">
          {index === 0 && field.rule !== attempt.fieldSnapshot?.rule && (
            <p>
              <span className="font-medium">{t('Extraction requirements')}</span> · {field.rule}
            </p>
          )}
          {attempt.fieldSnapshot && (
            <div className="mb-3">
              <p className="font-medium">{attempt.fieldSnapshot.name}</p>
              <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                {attempt.fieldSnapshot.rule}
              </p>
            </div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            {t('Field version {{version}}', { version: attempt.fieldVersion })} ·{' '}
            <time dateTime={attempt.at}>
              {Number.isFinite(Date.parse(attempt.at)) ? formatDate(attempt.at) : attempt.at}
            </time>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('Actual coverage')}:{' '}
            {attempt.coverage === 'full-text'
              ? t('Full text')
              : attempt.coverage === 'passages'
                ? t('Selected passages')
                : attempt.coverage === 'abstract'
                  ? t('Abstract')
                  : t('Unavailable')}
          </p>
          {index === 0 && reviewCell.manual && (
            <p className="mt-2 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
              <span>
                {t('Field version {{version}}', { version: reviewCell.manual.fieldVersion })}
              </span>
              <span>{t('Current rule: v{{version}}', { version: field.version })}</span>
            </p>
          )}
          {attempt.sourcePolicy && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('Source policy')}:{' '}
              {attempt.sourcePolicy === 'abstract' ? t('Abstract only') : t('Require full text')}
            </p>
          )}
          {attempt.model && <p className="text-xs text-muted-foreground">{attempt.model}</p>}
          <p className="mt-2 break-all text-xs text-muted-foreground">
            {t('Source version')}: {attempt.attachmentFilename ?? t('Reference snapshot')} ·{' '}
            {t('Version {{version}}', {
              version:
                attempt.attachmentVersionNumber ?? attempt.metadataRevision ?? attempt.fieldVersion
            })}
          </p>
        </div>
      </details>
    </section>
  )
  return host
    ? createPortal(
        <>
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 [overflow-wrap:anywhere]">
            <header className="mb-5 space-y-2">
              {referenceTitle && <p className="text-sm text-muted-foreground">{referenceTitle}</p>}
              <h2 className="text-xl font-semibold tracking-tight">{field.name}</h2>
              {!attempts.length && <p className="text-sm text-muted-foreground">{field.rule}</p>}
            </header>
            {(view.stale || view.needsReview) && (
              <p role="status" className="my-3 text-sm text-status-warning-foreground">
                {reviewCell.manual && reviewCell.manual.fieldVersion !== field.version
                  ? t('Rule changed. Review the saved manual value again.')
                  : t('Needs review')}
              </p>
            )}

            {loadCellHistory &&
              (!evidenceReady || (!historyReady && historyError)) &&
              (historyError ? (
                <ErrorNotice
                  title={t('Evidence history could not be loaded.')}
                  primaryButton={{
                    label: t('Retry'),
                    onClick: () => {
                      setHistoryError(false)
                      setRetry((value) => value + 1)
                    }
                  }}
                />
              ) : (
                <p role="status" className="text-sm text-muted-foreground">
                  {t('Loading')}
                </p>
              ))}
            {attempts.length > 0 && (
              <section
                aria-label={t('Machine results and evidence')}
                tabIndex={0}
                className="border-t border-border py-5 focus-visible:keyboard-focus"
              >
                {renderAttempt(attempts[0], 0)}
                {attempts.length > 1 && (
                  <details className="my-4">
                    <summary className="cursor-pointer text-sm font-semibold">
                      {t('Machine history')} ({attempts.length - 1})
                    </summary>
                    <div className="mt-3">
                      {attempts.slice(1).map((attempt, index) => renderAttempt(attempt, index + 1))}
                    </div>
                  </details>
                )}
              </section>
            )}
            {!attempts.length && revise}
            {showEditor && (
              <label className="mt-4 block text-sm font-medium">
                {t('Manual value')}
                <Textarea
                  className="mt-2"
                  ref={editorRef}
                  maxLength={8000}
                  value={draft}
                  disabled={discardOpen}
                  onChange={(e) => {
                    if (discardOpen) return
                    setDraft(e.target.value)
                    setManualEdited(true)
                    save(e.target.value, false)
                  }}
                />
              </label>
            )}
            {failed && (
              <ErrorNotice
                title={t('Draft could not be saved.')}
                primaryButton={{
                  label: t('Retry'),
                  disabled: discardOpen,
                  onClick: () => {
                    if (!discardOpen) save(draft, false)
                  }
                }}
                secondaryButton={{
                  label: t('Discard changes'),
                  disabled: pending > 0 || discardOpen,
                  onClick: () => {
                    if (pendingCount.current > 0 || !failedSave.current) return
                    discardFocus.current = document.activeElement as HTMLElement | null
                    setDiscardOpen(true)
                  }
                }}
              />
            )}
            {needsExtraction && (
              <p className="mt-2 text-sm text-muted-foreground">
                {reviewCell.status === 'running'
                  ? t('Running')
                  : t('Extract this cell to review its evidence before confirming.')}
              </p>
            )}
          </div>
          <footer className="flex shrink-0 items-center justify-end gap-3 border-t border-border bg-card px-5 py-3">
            <span role="status" className="mr-auto text-xs text-muted-foreground">
              {saving ? (
                slowSave ? (
                  t('Saving…')
                ) : null
              ) : view.confirmed && !failed ? (
                <span className="inline-flex items-center gap-1.5 text-status-success-foreground dark:text-status-success-dark-foreground">
                  <CircleCheck className="size-4" aria-hidden="true" />
                  {t('Confirmed')}
                </span>
              ) : manualEdited && !failed ? (
                t('Saved')
              ) : null}
            </span>
            {navigation?.onNextAwaiting && (!view.confirmed || navigation.hasNextAwaiting) && (
              <Button
                size={view.confirmed ? 'sm' : 'icon-sm'}
                variant={view.confirmed ? 'default' : 'ghost'}
                disabled={saving || failed || !navigation.hasNextAwaiting}
                aria-label={t('Next cell awaiting review')}
                title={t('Next cell awaiting review')}
                onClick={navigation.onNextAwaiting}
              >
                {view.confirmed && t('Next to review')}
                <StepForward className="size-4" aria-hidden="true" />
              </Button>
            )}
            {needsExtraction && onExtractCell ? (
              <Button
                disabled={extractionBlocked || saving || failed || reviewCell.status === 'running'}
                onClick={onExtractCell}
              >
                {t('Extract this cell')}
              </Button>
            ) : !view.confirmed ? (
              <Button
                disabled={confirmationDisabled}
                onClick={() => confirmValue(manualEdited ? draft : (view.attempt?.value ?? ''))}
              >
                {navigation
                  ? manualEdited
                    ? t('Confirm revision')
                    : t('Confirm result')
                  : t('Confirm value')}
              </Button>
            ) : null}
          </footer>
          <ConfirmActionDialog
            open={discardOpen}
            title={t('Discard unsaved changes?')}
            description={t('Your unsaved changes will be lost.')}
            cancelLabel={t('Keep editing')}
            confirmLabel={t('Discard changes')}
            destructive
            loading={pending > 0}
            onCancel={() => setDiscardOpen(false)}
            onCloseAutoFocus={(event) => {
              if (discarded.current) {
                // The page restores focus to the review's owning control after unmount.
                event.preventDefault()
              } else if (discardFocus.current?.isConnected) {
                event.preventDefault()
                discardFocus.current.focus()
              }
            }}
            onConfirm={() => {
              // A stale dialog must never release the leave guard for queued writes.
              if (pendingCount.current > 0 || !failedSave.current) return
              discarded.current = true
              failedSave.current = false
              onDraftStatusChange?.({ pending: false, failed: false })
              setDiscardOpen(false)
              onClose()
            }}
          />
        </>,
        host
      )
    : null
}
