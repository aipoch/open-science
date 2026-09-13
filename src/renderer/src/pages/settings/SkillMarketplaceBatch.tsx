import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ChevronDown, Download, ListChecks, LoaderCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { SettingsSegmentedControl } from './SettingsSegmentedControl'
import type {
  SkillMarketplaceBatch,
  SkillMarketplaceBatchRequest
} from '../../../../shared/skill-marketplace'

export type MarketplaceBatchMode = 'install' | 'update' | undefined

// Progress is a projection only. Closing/unmounting Settings never stops the main-process job.
export function SkillMarketplaceBatchControls({
  expanded,
  heading,
  onOpen,
  onExit,
  onRefresh,
  refreshing = false,
  disabled = false,
  request,
  mode,
  filteredCount,
  filteredSelectedCount = 0,
  modeCounts = { install: 0, update: 0 },
  showSelection,
  onModeChange,
  onSelectFiltered,
  onClearSelection,
  onBusyChange,
  onChanged,
  children
}: {
  expanded: boolean
  heading?: React.ReactNode
  onOpen: () => void
  onExit: () => void
  onRefresh?: () => void
  refreshing?: boolean
  disabled?: boolean
  request?: SkillMarketplaceBatchRequest
  mode: MarketplaceBatchMode
  filteredCount: number
  filteredSelectedCount?: number
  modeCounts?: { install: number; update: number }
  showSelection: boolean
  onModeChange: (mode: MarketplaceBatchMode) => void
  onSelectFiltered: () => void
  onClearSelection: () => void
  onBusyChange: (busy: boolean) => void
  onChanged: () => void
  children?: (selection: React.ReactNode) => React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const [batch, setBatch] = useState<SkillMarketplaceBatch | null>(null)
  const [ready, setReady] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const [draft, setDraft] = useState<SkillMarketplaceBatchRequest>()
  const [dismissedBatchId, setDismissedBatchId] = useState<string>()
  const generation = useRef(0)
  const mounted = useRef(false)
  const inFlight = useRef(false)
  const resumePolling = useRef<() => void>(() => {})
  const lastState = useRef<string | undefined>(undefined)
  const onChangedRef = useRef(onChanged)
  const confirmTrigger = useRef<HTMLElement | null>(null)
  const progressHeading = useRef<HTMLHeadingElement>(null)
  const reviewHeading = useRef<HTMLHeadingElement>(null)
  const selectionAction = useRef<HTMLButtonElement>(null)
  const selectAll = useRef<HTMLInputElement>(null)
  const restoreActionFocus = useRef(false)
  const active = batch?.status === 'running' || batch?.status === 'stopping'
  const selectionLocked = !ready || active || pending || Boolean(draft) || disabled
  if (!expanded && draft) setDraft(undefined)
  useEffect(() => {
    onChangedRef.current = onChanged
  }, [onChanged])
  useEffect(() => {
    onBusyChange(selectionLocked)
  }, [selectionLocked, onBusyChange])
  useLayoutEffect(() => {
    if (selectAll.current)
      selectAll.current.indeterminate =
        filteredSelectedCount > 0 && filteredSelectedCount < filteredCount
  }, [filteredSelectedCount, filteredCount, expanded, showSelection])
  useLayoutEffect(() => {
    if (draft) reviewHeading.current?.focus({ preventScroll: true })
    else if (restoreActionFocus.current) {
      restoreActionFocus.current = false
      ;(confirmTrigger.current?.isConnected
        ? confirmTrigger.current
        : (selectionAction.current ?? progressHeading.current ?? selectAll.current)
      )?.focus({ preventScroll: true })
    }
  }, [draft])
  useEffect(() => {
    mounted.current = true
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    let reading = false
    const schedule = (delay: number): void => {
      clearTimeout(timer)
      if (!disposed && document.visibilityState !== 'hidden')
        timer = setTimeout(() => void poll(), delay)
    }
    const poll = async (): Promise<void> => {
      if (disposed || document.visibilityState === 'hidden') return
      if (inFlight.current || reading) {
        schedule(1000)
        return
      }
      reading = true
      let delay = 1000
      const key = ++generation.current
      try {
        const value = await window.api.settings.getSkillMarketplaceBatch()
        if (disposed || key !== generation.current) return
        setBatch((current) => (JSON.stringify(current) === JSON.stringify(value) ? current : value))
        delay = value?.status === 'running' || value?.status === 'stopping' ? 1000 : 10000
        setReady(true)
        setError((current) =>
          current === t('Could not load installation progress.') ? undefined : current
        )
        const state = value && `${value.id}/${value.status}`
        if (
          value &&
          state !== lastState.current &&
          (value.status === 'completed' || value.status === 'stopped')
        )
          onChangedRef.current()
        lastState.current = state ?? undefined
      } catch {
        if (!disposed && key === generation.current) {
          setReady(false)
          setError(t('Could not load installation progress.'))
        }
      } finally {
        reading = false
        schedule(delay)
      }
    }
    const visibilityChanged = (): void => {
      clearTimeout(timer)
      ++generation.current
      if (document.visibilityState !== 'hidden') void poll()
    }
    resumePolling.current = () => schedule(1000)
    document.addEventListener('visibilitychange', visibilityChanged)
    void poll()
    return () => {
      disposed = true
      mounted.current = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibilityChanged)
      resumePolling.current = () => {}
    }
  }, [t])

  const confirm = (value: SkillMarketplaceBatchRequest): void => {
    confirmTrigger.current =
      document.activeElement instanceof HTMLElement &&
      document.activeElement.closest('[data-slot="skill-marketplace-batch-dock"]')
        ? document.activeElement
        : selectionAction.current
    setDraft(structuredClone(value))
  }
  const start = async (): Promise<void> => {
    if (!draft || inFlight.current) return
    inFlight.current = true
    const key = ++generation.current
    setPending(true)
    setError(undefined)
    try {
      const result = await window.api.settings.startSkillMarketplaceBatch(draft)
      if (!mounted.current) return
      if (result.ok) {
        setBatch(result.value)
        lastState.current = `${result.value.id}/${result.value.status}`
        if (result.value.status === 'completed' || result.value.status === 'stopped')
          onChangedRef.current()
        onClearSelection()
      } else setError(`${t('Could not start batch installation.')} (${result.error})`)
    } catch {
      if (mounted.current) setError(t('Could not start batch installation.'))
    } finally {
      if (mounted.current) {
        // Invalidate a progress read that began before this mutation settled.
        generation.current = Math.max(generation.current, key) + 1
        setPending(false)
        restoreActionFocus.current = true
        setDraft(undefined)
      }
      inFlight.current = false
      resumePolling.current()
    }
  }
  const stop = async (): Promise<void> => {
    if (!batch || inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError(undefined)
    ++generation.current
    try {
      const stopped = await window.api.settings.stopSkillMarketplaceBatch(batch.id)
      if (mounted.current && stopped)
        setBatch((current) =>
          current && current.id === batch.id && current.status === 'running'
            ? { ...current, status: 'stopping' }
            : current
        )
    } catch {
      if (mounted.current) setError(t('Could not stop batch installation.'))
    } finally {
      ++generation.current
      inFlight.current = false
      if (mounted.current) setPending(false)
      resumePolling.current()
    }
  }
  const labels = {
    queued: t('Queued'),
    installing: t('Installing…'),
    succeeded: t('Installed'),
    failed: t('Failed'),
    skipped: t('Skipped'),
    stopped: t('Stopped')
  }
  const finished =
    batch?.items.filter(({ status }) => status !== 'queued' && status !== 'installing').length ?? 0
  const failed = batch?.items.filter(({ status }) => status === 'failed').length ?? 0
  const selectedCount = request?.items.length ?? 0
  const showProgress = Boolean(
    batch && (active || (batch.id !== dismissedBatchId && !selectedCount))
  )
  const selection =
    expanded && showSelection ? (
      <label className="flex min-h-9 min-w-0 items-center gap-2 text-xs">
        <input
          ref={selectAll}
          type="checkbox"
          className="size-4 shrink-0 accent-primary"
          aria-label={t('Select all filtered results ({{total}})', { total: filteredCount })}
          checked={filteredCount > 0 && filteredSelectedCount === filteredCount}
          disabled={selectionLocked || !filteredCount}
          onChange={(event) => (event.target.checked ? onSelectFiltered() : onClearSelection())}
        />
        <span>{t('Select all filtered results ({{total}})', { total: filteredCount })}</span>
      </label>
    ) : null
  if (!expanded && !heading && !active) return <>{children?.(null)}</>
  return (
    <div
      className={expanded ? 'skill-marketplace-batch-layout' : 'space-y-4'}
      data-slot="skill-marketplace-batch"
    >
      <div className={expanded ? 'skill-marketplace-batch-scroll space-y-4 p-5' : 'space-y-4'}>
        {heading || expanded || active ? (
          <div
            className="flex flex-wrap items-center justify-between gap-2"
            data-slot="skill-marketplace-header"
          >
            {heading}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={expanded ? onExit : onOpen}>
                {expanded ? (
                  <ArrowLeft data-icon="inline-start" aria-hidden="true" />
                ) : (
                  <ListChecks data-icon="inline-start" aria-hidden="true" />
                )}
                {expanded ? t('Back to Marketplace') : t('Batch manage')}
                {!expanded && active ? (
                  <>
                    <LoaderCircle
                      className="size-3.5 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                    <span role="status" className="tabular-nums">
                      {finished}/{batch.items.length}
                    </span>
                  </>
                ) : null}
              </Button>
              {onRefresh ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onRefresh}
                  disabled={refreshing || (expanded && selectionLocked)}
                >
                  <RefreshCw
                    className={
                      refreshing ? 'size-4 animate-spin motion-reduce:animate-none' : 'size-4'
                    }
                    aria-hidden="true"
                  />
                  {t('Refresh')}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {expanded && showSelection ? (
          <fieldset disabled={selectionLocked} className="min-w-0">
            <SettingsSegmentedControl
              value={mode ?? 'install'}
              ariaLabel={t('Batch operation')}
              columnWidth="min(10rem, calc((100cqw - 2.75rem) / 2))"
              segmentClassName="px-3 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:opacity-50"
              onValueChange={(value) => {
                if (!selectionLocked) onModeChange(value)
              }}
              options={[
                {
                  value: 'install',
                  label: (
                    <span
                      className="flex min-w-0 items-center gap-2 whitespace-nowrap"
                      title={t('Not installed')}
                    >
                      <span className="truncate">{t('Not installed')}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {modeCounts.install}
                      </span>
                    </span>
                  )
                },
                {
                  value: 'update',
                  label: (
                    <span
                      className="flex min-w-0 items-center gap-2 whitespace-nowrap"
                      title={t('Updates')}
                    >
                      <span className="truncate">{t('Updates')}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {modeCounts.update}
                      </span>
                    </span>
                  )
                }
              ]}
            />
          </fieldset>
        ) : null}
        {children ? children(selection) : selection}
      </div>
      {expanded && (error || draft || showProgress || (showSelection && selectedCount > 0)) ? (
        <div
          data-slot="skill-marketplace-batch-dock"
          className="skill-marketplace-batch-dock space-y-3"
        >
          {expanded && error ? (
            <ErrorNotice
              role="alert"
              tone="amber"
              title={error}
              secondaryButton={{ label: t('Dismiss'), onClick: () => setError(undefined) }}
            />
          ) : null}
          {draft ? (
            <section
              data-slot="skill-marketplace-batch-review"
              data-testid="skill-marketplace-batch-confirm"
              aria-label={t('Review selection')}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !pending) {
                  event.stopPropagation()
                  restoreActionFocus.current = true
                  setDraft(undefined)
                }
              }}
              className="space-y-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h4 ref={reviewHeading} tabIndex={-1} className="text-sm font-medium">
                  {t('Review selection')} · {draft.items.length}
                </h4>
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => {
                      restoreActionFocus.current = true
                      setDraft(undefined)
                    }}
                  >
                    {t('Cancel', { ns: 'common' })}
                  </Button>
                  <Button size="sm" disabled={pending || disabled} onClick={() => void start()}>
                    {pending ? (
                      <LoaderCircle
                        aria-hidden="true"
                        className="size-4 animate-spin motion-reduce:animate-none"
                      />
                    ) : null}
                    {draft.items.some(({ expectedVersion }) => expectedVersion !== null)
                      ? t('Update selected')
                      : t('Install selected')}
                  </Button>
                </div>
              </div>
              <details className="skill-marketplace-disclosure">
                <summary>
                  <span>{t('Details')}</span>
                  <ChevronDown aria-hidden="true" className="size-4" />
                </summary>
                <div className="mb-3 space-y-2 text-xs text-muted-foreground">
                  <p>
                    {t(
                      'Installing downloads and verifies the package. Bundled scripts are not run during installation.'
                    )}
                  </p>
                  <p>
                    {t(
                      'Installation continues when Settings is closed. Quitting the app stops the queue.'
                    )}
                  </p>
                </div>
                <ul className="max-h-40 overflow-auto space-y-1 text-xs">
                  {draft.items.map(({ id, version, expectedVersion }) => (
                    <li key={id} className="break-words">
                      {id}: {expectedVersion ? `${expectedVersion} → ` : ''}
                      {version}
                    </li>
                  ))}
                </ul>
              </details>
            </section>
          ) : showProgress && batch ? (
            <section className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 ref={progressHeading} tabIndex={-1} className="text-sm font-medium">
                  {active
                    ? t('Batch installation')
                    : batch.status === 'stopped'
                      ? t('Batch stopped')
                      : t('Batch complete')}
                </h4>
                <span role="status" className="text-xs tabular-nums">
                  {finished}/{batch.items.length}
                </span>
              </div>
              <progress
                className="h-1.5 w-full accent-primary"
                value={finished}
                max={batch.items.length}
                aria-label={t('Batch installation')}
              />
              {failed ? (
                <p className="text-xs text-status-warning-foreground dark:text-status-warning-dark-foreground">
                  {t('Failed: {{total}}', { total: failed })}
                </p>
              ) : null}
              {active ? (
                <p className="text-xs text-muted-foreground">
                  {t(
                    'Installation continues when Settings is closed. Quitting the app stops the queue.'
                  )}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                {active ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto"
                    disabled={pending || batch.status === 'stopping'}
                    onClick={() => void stop()}
                  >
                    {batch.status === 'stopping' ? t('Stopping…') : t('Stop after current item')}
                  </Button>
                ) : null}
                {!active && batch.items.some(({ status }) => status === 'failed') ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled || !ready || pending}
                    onClick={() =>
                      confirm({
                        snapshotId: batch.snapshotId,
                        items: batch.items
                          .filter(({ status }) => status === 'failed')
                          .map(({ id, version, expectedVersion }) => ({
                            id,
                            version,
                            expectedVersion
                          }))
                      })
                    }
                  >
                    {t('Retry failed items')}
                  </Button>
                ) : null}
                {!active ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto"
                    onClick={() => {
                      setDismissedBatchId(batch.id)
                      selectAll.current?.focus({ preventScroll: true })
                    }}
                  >
                    {t('Done')}
                  </Button>
                ) : null}
              </div>
              {batch.refreshFailed ? (
                <ErrorNotice
                  tone="amber"
                  title={t(
                    'Skills were installed, but runtime refresh failed. Restart the app to reload them.'
                  )}
                />
              ) : null}
              <details className="skill-marketplace-disclosure">
                <summary>
                  <span>{t('Details')}</span>
                  <ChevronDown className="size-4" aria-hidden="true" />
                </summary>
                <ul className="max-h-60 space-y-2 overflow-auto pt-2 text-xs">
                  {batch.items.map((item) => (
                    <li key={item.id} className="flex items-start justify-between gap-3">
                      <span className="min-w-0 break-words">
                        {item.id} <span className="text-muted-foreground">{item.version}</span>
                      </span>
                      <span className="shrink-0 text-right">
                        {labels[item.status]}
                        {item.result && !item.result.ok ? (
                          <span className="block text-muted-foreground">{item.result.error}</span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            </section>
          ) : showSelection && selectedCount > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span role="status" className="text-sm font-medium tabular-nums">
                  {t('Selected: {{selected}}', { selected: selectedCount })}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={selectionLocked}
                  onClick={() => {
                    onClearSelection()
                    selectAll.current?.focus({ preventScroll: true })
                  }}
                >
                  {t('Clear selection')}
                </Button>
              </div>
              <Button
                ref={selectionAction}
                size="sm"
                className="ml-auto"
                disabled={selectionLocked}
                onClick={() => request && confirm(request)}
              >
                {mode === 'update' ? (
                  <RefreshCw data-icon="inline-start" aria-hidden="true" />
                ) : (
                  <Download data-icon="inline-start" aria-hidden="true" />
                )}
                {mode === 'update' ? t('Update selected') : t('Install selected')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
