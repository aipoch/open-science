import {
  AUTOMATIC_CLASSIFICATION_RUN_LIMIT,
  AUTOMATIC_CLASSIFICATION_DAY_LIMIT
} from '../../../../shared/classification'
import { SMART_COLLECTION_RESUME_UNAVAILABLE } from '../../../../shared/literature-smart-collections'
import type { SmartCollectionState } from './smart-collection-state'
import { SmartCollectionIcon } from '@/components/app-icons/custom-glyphs'
import { formatSmartRule, parseSmartRule } from './smart-rule-fields'
import { SmartRuleSummary } from './SmartRuleSummary'
import { setSmartReevaluationConfirmation } from './smart-collection-preferences'
import { classificationFailureText } from './smart-collection-decisions'
import { isCollectionOnlyChange, useLiteratureChanges } from './useLiteratureChanges'
import { useCallback, useEffect, useId, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Pencil,
  Download,
  FileText,
  Check,
  LoaderCircle,
  MoreHorizontal,
  Eye,
  RotateCcw,
  Play,
  Pause,
  Info,
  Sparkles,
  Trash2,
  ChevronDown
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ErrorNotice } from '@/components/error-notice'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { ActionMenuProvider, ActionMenuTarget, useActionMenu } from '@/components/action-menu'
import { useSettingsStore } from '@/stores/settings-store'
import type {
  SmartCollectionView,
  SmartScope
} from '../../../../shared/literature-smart-collections'

const catalog = {
  bibtex: { labelKey: 'BibTeX', icon: FileText },
  ris: { labelKey: 'RIS', icon: FileText },
  review: { labelKey: 'Review with agent', icon: Sparkles },
  preview: { labelKey: 'Trial run (up to 20 references)', icon: Eye },
  recompute: { labelKey: 'Re-evaluate all', icon: RotateCcw },
  reset: { labelKey: 'Reset manual decisions', icon: RotateCcw },
  details: { labelKey: 'Run details', icon: Info },
  confirmation: { labelKey: 'Restore re-analysis confirmation', icon: RotateCcw },
  remove: { labelKey: 'Delete collection', icon: Trash2, danger: true }
}
const recipe = (
  ['review', 'preview', 'recompute', 'reset', 'details', 'confirmation', 'remove'] as const
).map((action) => ({
  kind: 'action' as const,
  action
}))
function MoreActions(): React.JSX.Element {
  const { t } = useTranslation()
  const { openMenu } = useActionMenu()
  return (
    <Button
      variant="outline"
      size="icon"
      aria-label={t('Collection actions')}
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        openMenu({
          targetId: 'smart-actions',
          pointer: { x: bounds.right, y: bounds.bottom },
          align: 'end',
          focusTarget: event.currentTarget
        })
      }}
    >
      <MoreHorizontal className="size-4" aria-hidden="true" />
    </Button>
  )
}
export function SmartCollectionPanel({
  collectionId,
  state,
  name,
  description,
  onViewChange,
  onEdit,
  onDelete,
  onReview,
  onOpenScope,
  onOpenProcess,
  onRunPendingChange,
  processOpen = false,
  searchActions,
  onExport,
  exportDisabled,
  decisionPending = false,
  singleReevaluation = false
}: {
  decisionPending?: boolean
  singleReevaluation?: boolean
  collectionId: string
  state: SmartCollectionState
  name: string
  description: string
  onViewChange?: (view: SmartCollectionView | undefined, updating: boolean) => void
  onEdit?: () => void
  onDelete?: () => void
  onReview?: () => void
  onOpenScope?: (scope: SmartScope) => void
  onOpenProcess?: () => void
  onRunPendingChange?: (pending: boolean) => void
  processOpen?: boolean
  onExport?: (format: 'bibtex' | 'ris') => Promise<boolean>
  exportDisabled?: boolean
  searchActions?: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const progressStatusId = useId()
  const settingsOpen = useSettingsStore((state) => state.isSettingsOpen)
  const view = useSyncExternalStore(state.subscribe, state.getSnapshot)
  const [revision, setRevision] = useState(0)
  useLiteratureChanges((event) => {
    if (
      !isCollectionOnlyChange(event) ||
      event?.collectionIds?.includes(collectionId) ||
      (view?.scope.kind === 'collection' && event?.collectionIds?.includes(view.scope.id))
    )
      setRevision((value) => value + 1)
  })
  const [error, setError] = useState(false)
  const [resumeUnavailable, setResumeUnavailable] = useState(false)
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [updatePending, setUpdatePending] = useState(false)
  const [updateRunId, setUpdateRunId] = useState<string>()
  const updated = updateRunId === view?.run?.id && view?.run?.state === 'completed'
  useEffect(() => {
    if (!updated) return
    const timer = window.setTimeout(() => setUpdateRunId(undefined), 1800)
    return () => window.clearTimeout(timer)
  }, [updated])
  const [details, setDetails] = useState(false)
  const [runDetails, setRunDetails] = useState(false)
  const [confirmPreview, setConfirmPreview] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmRecompute, setConfirmRecompute] = useState(false)
  const [confirmAbandon, setConfirmAbandon] = useState<string>()
  const [confirmClearPause, setConfirmClearPause] = useState(false)
  const load = useCallback(
    async () =>
      (
        await window.api.literature.transact({
          kind: 'smart-collection',
          offset: 0,
          collectionId,
          action: 'read',
          summaryOnly: true
        })
      ).smart,
    [collectionId]
  )
  useEffect(() => {
    let live = true
    const generation = state.beginRead()
    void load().then(
      (next) => {
        if (live && state.isCurrent(generation)) {
          state.acceptRead(generation, next)
          setRefreshFailed(false)
          if (next?.run?.state !== 'running' && next?.run?.state !== 'queued') setStopping(false)
          setError(false)
        }
      },
      () => {
        if (live && state.isCurrent(generation)) setError(true)
      }
    )
    return () => {
      live = false
    }
  }, [load, settingsOpen, revision, state])
  useEffect(() => {
    if (view !== state.getSnapshot()) return
    onViewChange?.(
      view,
      updatePending || view?.run?.state === 'running' || view?.run?.state === 'queued'
    )
  }, [view, updatePending, onViewChange, state])
  const run = async (
    action:
      | 'refresh'
      | 'recompute'
      | 'preview'
      | 'cancel'
      | 'abandon'
      | 'reset-overrides'
      | 'resume-automatic'
      | 'resume',
    targetRunId?: string
  ): Promise<void> => {
    if (decisionPending || busy || refreshFailed) return
    setResumeUnavailable(false)
    state.beginWrite()
    setBusy(true)
    if (action === 'cancel') setStopping(true)
    const updating =
      action === 'refresh' ||
      action === 'recompute' ||
      action === 'preview' ||
      action === 'resume-automatic' ||
      action === 'resume'
    if (updating) {
      setConfirmRecompute(false)
      setConfirmPreview(false)
      onRunPendingChange?.(true)
      setStopping(false)
      onViewChange?.(view, true)
      setUpdatePending(true)
      setUpdateRunId(undefined)
    }
    try {
      const receipt = await window.api.literature.transact({
        kind: 'smart-collection',
        offset: 0,
        collectionId,
        action,
        ...(action === 'abandon' && targetRunId ? { runId: targetRunId } : {})
      })
      state.finishWrite(receipt.smart)
      setRefreshFailed(receipt.smartRefreshFailed === true)
      if (updating) {
        setUpdateRunId(receipt.smart?.run?.id)
        setUpdatePending(false)
      }
      setError(false)
      setConfirmRecompute(false)
      setConfirmPreview(false)
      setConfirmReset(false)
      setConfirmAbandon(undefined)
      setConfirmClearPause(false)
    } catch (failure) {
      const unavailable = String(failure).includes(SMART_COLLECTION_RESUME_UNAVAILABLE)
      setResumeUnavailable(unavailable)
      if (action === 'cancel') setStopping(false)
      if (updating) setUpdatePending(false)
      setError(!unavailable)
    } finally {
      if (updating) onRunPendingChange?.(false)
      // Reconcile events received while the command receipt was in flight.
      state.finishWrite()
      setRevision((value) => value + 1)
      setBusy(false)
    }
  }
  const running = view?.run?.state === 'running' || view?.run?.state === 'queued'
  const active = updatePending || running
  const disabled =
    refreshFailed ||
    decisionPending ||
    busy ||
    updatePending ||
    running ||
    !view?.configured ||
    !view.sourceAvailable
  const empty = view && !view.run && !view.matches
  const failed = (!refreshFailed && error) || view?.run?.state === 'failed'
  const stopped =
    !view?.run?.abandoned &&
    (view?.run?.state === 'cancelled' || view?.run?.state === 'interrupted')
  const automaticPauseVisible = view?.autoUpdate && Boolean(view.automaticPauseReason)
  const canResumeAutomaticRun =
    automaticPauseVisible &&
    Boolean(view?.automaticPauseRunId) &&
    view?.run?.id === view?.automaticPauseRunId &&
    !view?.run?.abandoned &&
    (view?.run?.state === 'cancelled' ||
      view?.run?.state === 'interrupted' ||
      ((view.automaticPauseReason === 'storage-error' ||
        view.automaticPauseReason === 'interrupted') &&
        view?.run?.state === 'failed')) &&
    view.automaticPauseReason !== 'run-limit'
  const continueAutomaticRun =
    automaticPauseVisible &&
    view?.automaticPauseReason === 'run-limit' &&
    view?.run?.state === 'cancelled' &&
    view.run.id === view.automaticPauseRunId
  const paused =
    automaticPauseVisible &&
    view?.run?.id === view?.automaticPauseRunId &&
    (view?.run?.state === 'interrupted' || continueAutomaticRun)
  const snapshot = view?.run?.snapshot
  const currentRule = parseSmartRule(description)
  const savedRule = snapshot && parseSmartRule(snapshot.description)
  const sameSettings = Boolean(
    snapshot &&
    currentRule &&
    savedRule &&
    formatSmartRule(currentRule) === formatSmartRule(savedRule) &&
    snapshot.model === view?.model &&
    snapshot.evidenceMode === view?.evidenceMode &&
    snapshot.scope.kind === view?.scope.kind &&
    (snapshot.scope.kind === 'library' ||
      (view?.scope.kind !== 'library' && snapshot.scope.id === view?.scope.id))
  )
  const progress = view?.run && !updatePending ? view.run : undefined
  const updateControl = (
    <div
      data-slot="smart-update-control"
      className={`relative flex h-9 shrink-0 items-center ${active && !singleReevaluation ? 'w-52' : stopped && !singleReevaluation ? 'w-fit min-w-36 max-w-[min(24rem,calc(100vw-2rem))]' : 'w-36'}`}
    >
      {active && !singleReevaluation ? (
        <div data-slot="smart-run-progress" className="flex w-full items-center gap-1">
          <button
            type="button"
            aria-label={t('Screening process')}
            aria-describedby={progressStatusId}
            aria-expanded={processOpen}
            title={t('Screening process')}
            disabled={!running || !onOpenProcess}
            onClick={onOpenProcess}
            className="relative min-w-0 flex-1 rounded-md px-1.5 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
          >
            <span id={progressStatusId} role="status" className="flex items-center gap-2 text-xs">
              <LoaderCircle
                className="size-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {stopping ? t('Stopping analysis…') : t('Updating…')}
              </span>
              {!stopping && progress && (
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {progress.done}/{progress.total}
                </span>
              )}
            </span>
            <span
              role="progressbar"
              aria-label={t('Re-evaluate')}
              aria-valuemin={0}
              aria-valuemax={Math.max(1, progress?.total ?? 0)}
              aria-valuenow={progress?.done}
              className="absolute inset-x-1.5 bottom-0 h-0.5 overflow-hidden rounded-full bg-muted"
            >
              <span
                className={`block h-full origin-left bg-primary transition-transform duration-300 ease-out motion-reduce:transition-none ${progress?.total ? '' : 'w-1/4 motion-safe:animate-pulse'}`}
                style={
                  progress?.total
                    ? { transform: `scaleX(${Math.min(1, progress.done / progress.total)})` }
                    : undefined
                }
              />
            </span>
          </button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 gap-1 px-1.5 text-xs"
            aria-label={t('Pause analysis')}
            disabled={busy || updatePending || stopping}
            onClick={() => void run('cancel')}
          >
            <Pause className="size-3.5 shrink-0" aria-hidden="true" />
            {t('Pause')}
          </Button>
        </div>
      ) : failed ? (
        <div className="flex w-full items-center justify-between gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('Analysis failed')}
                className="min-w-0 flex-1 px-1 text-status-failure-foreground"
              >
                <Info className="size-3.5" aria-hidden="true" />
                <span className="truncate">{t('Analysis failed')}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80">
              <ErrorNotice
                inline
                tone="amber"
                description={
                  error
                    ? t('Classification failed. Your rule and saved results are preserved.')
                    : classificationFailureText(t, view?.run?.failure)
                }
                secondaryButton={{
                  label: t('Configure classification model'),
                  onClick: () => useSettingsStore.getState().openSettingsToClassification()
                }}
              />
            </PopoverContent>
          </Popover>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => void run('refresh')}
          >
            {t('Retry')}
          </Button>
        </div>
      ) : stopped ? (
        <div className="flex w-full items-center justify-between gap-2">
          <button
            type="button"
            aria-label={t('Screening process')}
            aria-describedby={progressStatusId}
            aria-expanded={processOpen}
            title={t('Screening process')}
            disabled={!onOpenProcess}
            onClick={onOpenProcess}
            className="min-w-0 flex-1 rounded-md px-1.5 py-2 text-left text-xs text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
          >
            <span id={progressStatusId} role="status" className="block truncate whitespace-nowrap">
              {paused ? t('Automatic updates paused') : t('Paused')} · {view.run?.done}/
              {view.run?.total}
            </span>
          </button>
          <div className="flex items-center gap-1">
            {(view.run?.state === 'interrupted' || view.run?.state === 'cancelled') && !paused && (
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('Abandon run')}
                      disabled={busy || decisionPending || refreshFailed || !view.run?.id}
                      onClick={() => setConfirmAbandon(view.run?.id)}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="bg-black text-white">
                    {t(
                      'Abandon this run. Completed results will be kept, and this run will not resume.'
                    )}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {paused ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={
                  view.automaticPauseReason === 'run-limit'
                    ? t('Continue in a new run')
                    : canResumeAutomaticRun
                      ? t('Resume automatic updates')
                      : t('Start a fresh automatic run')
                }
                disabled={disabled}
                onClick={() => void run('resume-automatic')}
              >
                <RotateCcw className="size-4" aria-hidden="true" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('Resume analysis')}
                disabled={disabled || (automaticPauseVisible && !view.automaticPauseRunId)}
                onClick={() => void run('resume')}
              >
                <Play className="size-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        </div>
      ) : (
        <Button className="w-full" disabled={disabled} onClick={() => void run('refresh')}>
          {active ? (
            <LoaderCircle
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : updated ? (
            <Check className="size-4" aria-hidden="true" />
          ) : null}
          <span aria-live="polite">
            {active ? t('Updating…') : updated ? t('Updated') : t('Update collection')}
          </span>
        </Button>
      )}
    </div>
  )
  const sourceAvailable = Boolean(
    view?.sourceAvailable && (view.scope.kind === 'library' || view.sourceName)
  )
  const scopeContent = (
    <>
      {sourceAvailable && view?.scope.kind !== 'library' && (
        <span
          aria-hidden="true"
          className={`shrink-0 rounded px-1.5 text-[10px] font-semibold leading-4 uppercase ${view?.scope.kind === 'project' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}
        >
          {view?.scope.kind === 'project' ? t('Project') : t('Collection')}
        </span>
      )}
      <span className="truncate">
        {sourceAvailable
          ? view?.scope.kind === 'library'
            ? t('All references')
            : view?.sourceName
          : t('Unavailable')}
      </span>
    </>
  )
  return (
    <section className="shrink-0" aria-label={t('Smart collection')}>
      {refreshFailed && (
        <ErrorNotice
          inline
          tone="amber"
          description={t(
            'Decision saved, but results could not be refreshed. Reload the collection to see the latest results.'
          )}
          primaryButton={{ label: t('Retry'), onClick: () => setRevision((value) => value + 1) }}
        />
      )}
      <div className="flex flex-wrap items-end justify-between gap-4 text-xs text-muted-foreground">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <SmartCollectionIcon className="size-5 shrink-0 text-primary" aria-hidden="true" />
            <h2
              className="truncate text-2xl font-semibold tracking-tight text-foreground"
              title={name}
            >
              {name}
            </h2>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('Collection rule')}
              aria-expanded={details}
              aria-controls={`smart-details-${collectionId}`}
              onClick={() => setDetails((value) => !value)}
            >
              <ChevronDown
                className={details ? 'size-4 rotate-180' : 'size-4'}
                aria-hidden="true"
              />
            </Button>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{t('Smart collection')}</p>
        </div>
        <ActionMenuProvider onActionError={() => setError(true)}>
          <ActionMenuTarget
            asChild
            targetId="smart-actions"
            identityKey={collectionId}
            invocation={collectionId}
            catalog={catalog}
            recipe={[
              {
                kind: 'submenu',
                labelKey: 'Export included references',
                icon: Download,
                actions: ['bibtex', 'ris']
              },
              ...recipe
            ]}
            bindings={{
              bibtex: {
                execute: async () => {
                  await onExport?.('bibtex')
                },
                hidden: !onExport,
                disabled: exportDisabled
              },
              ris: {
                execute: async () => {
                  await onExport?.('ris')
                },
                hidden: !onExport,
                disabled: exportDisabled
              },
              review: { execute: () => onReview?.(), hidden: !onReview },
              preview: {
                execute: () => setConfirmPreview(true),
                disabled,
                hidden: !view?.configured
              },
              recompute: {
                execute: () => setConfirmRecompute(true),
                disabled,
                hidden: !view?.configured
              },
              reset: {
                execute: () => setConfirmReset(true),
                hidden: !view?.overrides,
                disabled: busy || running || decisionPending || refreshFailed
              },
              remove: { execute: () => onDelete?.(), hidden: !onDelete, disabled: active },
              confirmation: {
                execute: () => {
                  if (!setSmartReevaluationConfirmation(true))
                    throw new Error(t('Settings could not be saved'))
                }
              },
              details: {
                execute: () => {
                  setDetails(true)
                  setRunDetails(true)
                },
                hidden: !view?.run
              }
            }}
          >
            <div className="flex items-center gap-2">
              {(view?.configured || stopped) && updateControl}
              <div inert={active || undefined} className="flex items-center gap-2">
                {(!empty || view?.configured) && searchActions}
                <MoreActions />
              </div>
            </div>
          </ActionMenuTarget>
        </ActionMenuProvider>
      </div>
      {resumeUnavailable && (
        <ErrorNotice
          inline
          tone="amber"
          description={t(
            'This run cannot be resumed because its settings, papers, or saved progress have changed.'
          )}
          primaryButton={{
            label: t('Re-evaluate all'),
            onClick: () => setConfirmRecompute(true),
            disabled: busy || decisionPending || refreshFailed
          }}
        />
      )}
      {automaticPauseVisible && !active && (
        <ErrorNotice
          inline
          tone="amber"
          title={t('Automatic updates paused')}
          description={
            view.automaticPauseReason === 'run-limit'
              ? t(
                  'This run reached {{limit}} automatic requests, including retries. Resume to evaluate the remaining references.',
                  { limit: AUTOMATIC_CLASSIFICATION_RUN_LIMIT }
                )
              : view.automaticPauseReason === 'daily-limit'
                ? t(
                    'Automatic requests reached the shared limit of {{limit}} in 24 hours. Wait before resuming.',
                    { limit: AUTOMATIC_CLASSIFICATION_DAY_LIMIT }
                  )
                : t(
                    'The previous automatic run stopped or could not save its progress. Check storage before resuming. Saved results are preserved.'
                  )
          }
          primaryButton={{
            label:
              view.automaticPauseReason === 'run-limit'
                ? t('Continue in a new run')
                : canResumeAutomaticRun
                  ? t('Resume automatic updates')
                  : t('Start a fresh automatic run'),
            onClick: () => void run('resume-automatic'),
            disabled:
              busy || decisionPending || refreshFailed || !view.configured || !view.sourceAvailable
          }}
          secondaryButton={{
            label: view.automaticPauseRunId ? t('Abandon run') : t('Clear automatic pause'),
            onClick: () => {
              if (view.automaticPauseRunId) setConfirmAbandon(view.automaticPauseRunId)
              else setConfirmClearPause(true)
            },
            disabled: busy || decisionPending || refreshFailed
          }}
        />
      )}
      {details && (
        <div
          id={`smart-details-${collectionId}`}
          className="mt-3 min-w-0 rounded-lg border border-border bg-background"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-3">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              {t('Collection rule')}
              {view?.ruleRevision !== undefined && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal tabular-nums text-muted-foreground">{`#${view.ruleRevision}`}</span>
              )}
            </h3>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={active}
              onClick={onEdit}
            >
              <Pencil className="size-3.5" aria-hidden="true" />
              {t('Edit rule')}
            </Button>
          </div>
          <div className="px-4 pb-4 pt-3">
            <SmartRuleSummary rule={description} />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-4 py-3 text-xs text-muted-foreground">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              {t('Scope')}:
              {view && sourceAvailable && onOpenScope ? (
                <button
                  type="button"
                  className="inline-flex min-w-0 items-center gap-1.5 rounded-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={
                    view.scope.kind === 'library'
                      ? t('All references')
                      : `${view.scope.kind === 'project' ? t('Project') : t('Collection')}: ${view.sourceName}`
                  }
                  onClick={() => onOpenScope(view.scope)}
                >
                  {scopeContent}
                </button>
              ) : (
                <span className="inline-flex min-w-0 items-center gap-1.5">{scopeContent}</span>
              )}
            </span>
            {view?.model && <span className="min-w-0 break-all">{view.model}</span>}
            <span>
              {view?.evidenceMode === 'full-text'
                ? t('Use available full text')
                : t('Evidence: title and abstract')}
            </span>
            {view?.autoUpdate && <span>{t('Update automatically')}</span>}
          </div>
          {view?.run && (
            <details
              open={runDetails}
              onToggle={(event) => setRunDetails(event.currentTarget.open)}
              className="group border-t border-border px-4 py-3 text-xs text-muted-foreground"
            >
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-2 rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                <ChevronDown
                  className="size-3.5 shrink-0 -rotate-90 group-open:rotate-0"
                  aria-hidden="true"
                />
                <span className="font-medium text-foreground">{t('Run details')}</span>
                <span>
                  {view.run.done}/{view.run.total} ·{' '}
                  {running
                    ? t('Running…')
                    : view.run.state === 'completed'
                      ? t('Completed')
                      : view.run.state === 'failed'
                        ? t('Analysis failed')
                        : paused
                          ? t('Automatic updates paused')
                          : t('Stopped — update to continue')}
                </span>
                <span className="sm:ml-auto">{new Date(view.run.updatedAt).toLocaleString()}</span>
              </summary>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
                <span>
                  {t('Input: {{input}} · Output: {{output}}', {
                    input: view.run.inputTokens,
                    output: view.run.outputTokens
                  })}
                  {view.run.usageIncomplete ? ` · ${t('Usage may be incomplete')}` : ''}
                </span>
                <span>{t('Manual decisions retained: {{total}}', { total: view.overrides })}</span>
                {snapshot ? (
                  sameSettings ? (
                    <p className="w-full">{t('This run used the current settings.')}</p>
                  ) : (
                    <details key={view.run.id} className="w-full">
                      <summary className="cursor-pointer rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                        {t('View settings used for this run')}
                      </summary>
                      <div className="mt-3 space-y-3 border-l border-border pl-3">
                        <p>{t('Saved at run start. Current settings may have changed.')}</p>
                        <div className="text-foreground">
                          <SmartRuleSummary rule={snapshot.description} />
                        </div>
                        <p className="break-words">
                          {snapshot.model} ·{' '}
                          {snapshot.evidenceMode === 'full-text'
                            ? t('Use available full text')
                            : t('Evidence: title and abstract')}
                        </p>
                      </div>
                    </details>
                  )
                ) : (
                  <p className="w-full">{t('Run settings are unavailable for this older run.')}</p>
                )}
              </div>
            </details>
          )}
        </div>
      )}
      {error && (!view?.configured || active) && (
        <ErrorNotice
          inline
          tone="amber"
          description={t('Classification failed. Your rule and saved results are preserved.')}
          primaryButton={{
            label: t('Retry'),
            onClick: () => setRevision((value) => value + 1)
          }}
        />
      )}
      {view && !view.sourceAvailable ? (
        <div className="py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {t('The collection source is unavailable. No papers will be evaluated.')}
          </p>
          <Button className="mt-4" onClick={onEdit}>
            <Pencil className="size-3.5" aria-hidden="true" />
            {t('Edit rule')}
          </Button>
        </div>
      ) : empty && !view.configured ? (
        <div className="mt-[88px] rounded-2xl border border-dashed border-border px-6 py-20 text-center">
          <SmartCollectionIcon className="mx-auto mb-4 size-7 text-primary" aria-hidden="true" />
          <h3 className="text-lg font-medium">
            {view.configured ? t('Ready to organize') : t('Collection saved')}
          </h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {view.configured
              ? t(
                  'Evaluate references against your collection rules using the evidence selected for each collection.'
                )
              : t('Choose a classification model to start organizing papers.')}
          </p>
          <Button
            className="mt-5"
            onClick={() => useSettingsStore.getState().openSettingsToClassification()}
          >
            {t('Configure classification model')}
          </Button>
        </div>
      ) : view && !view.configured ? (
        <div className="flex flex-wrap items-center gap-2 py-3 text-sm text-muted-foreground">
          <span>
            {t(
              'Configure a classification model to evaluate this collection. Saved results remain available.'
            )}
          </span>
          <Button
            variant="ghost"
            onClick={() => useSettingsStore.getState().openSettingsToClassification()}
          >
            {t('Configure classification model')}
          </Button>
        </div>
      ) : null}
      {!view && !error && (
        <p role="status" className="py-4 text-sm text-muted-foreground">
          {t('Loading…')}
        </p>
      )}
      {confirmPreview && (
        <div
          role="region"
          aria-label={t('Trial run (up to 20 references)')}
          className="my-3 rounded-lg border border-border bg-bg-000 p-4 text-sm"
        >
          <p>
            {t(
              'Evaluate up to 20 eligible references using the selected evidence. This sends text to the classification service, saves results in this collection and may incur costs.'
            )}
          </p>
          <div className="mt-3 flex gap-2">
            <Button disabled={disabled} onClick={() => void run('preview')}>
              {t('Start trial run')}
            </Button>
            <Button variant="outline" onClick={() => setConfirmPreview(false)}>
              {t('Cancel')}
            </Button>
          </div>
        </div>
      )}
      {confirmReset && (
        <div
          role="region"
          aria-label={t('Reset manual decisions')}
          className="my-3 rounded-lg border border-border bg-bg-000 p-4 text-sm"
        >
          <p>
            {t(
              'Reset manual decisions ({{total}})? These references will use model results again.',
              {
                total: view?.overrides ?? 0
              }
            )}
          </p>
          <div className="mt-3 flex gap-2">
            <Button disabled={busy || running} onClick={() => void run('reset-overrides')}>
              {t('Reset manual decisions')}
            </Button>
            <Button variant="outline" onClick={() => setConfirmReset(false)}>
              {t('Cancel')}
            </Button>
          </div>
        </div>
      )}
      {confirmRecompute && (
        <div className="my-3 rounded-lg bg-muted/40 p-4 text-sm">
          <p>
            {t(
              'Re-evaluating all papers repeats classification requests and may incur additional costs.'
            )}
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmRecompute(false)}>
              {t('Cancel')}
            </Button>
            <Button disabled={disabled} onClick={() => void run('recompute')}>
              {t('Re-evaluate all')}
            </Button>
          </div>
        </div>
      )}
      <ConfirmActionDialog
        open={Boolean(confirmAbandon)}
        title={t('Abandon run')}
        description={t(
          'Abandon this run? Completed results will be kept, and this run will not resume.'
        )}
        cancelLabel={t('Cancel')}
        confirmLabel={t('Abandon run')}
        destructive
        loading={busy}
        onCancel={() => setConfirmAbandon(undefined)}
        onConfirm={() => void run('abandon', confirmAbandon)}
      />
      <ConfirmActionDialog
        open={confirmClearPause}
        title={t('Clear automatic pause')}
        description={t('Clear this automatic pause? Runs and classification results will be kept.')}
        cancelLabel={t('Cancel')}
        confirmLabel={t('Clear automatic pause')}
        loading={busy}
        onCancel={() => setConfirmClearPause(false)}
        onConfirm={() => void run('abandon')}
      />
    </section>
  )
}
