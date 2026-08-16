import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Cpu,
  HardDrive,
  MemoryStick,
  Pin,
  RefreshCw,
  Zap
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DETAILS_DOC_MAX_LENGTH } from '../../../../shared/compute'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useComputeStore } from '@/stores/compute-store'
import { probedLabel } from './compute-probed-label'

type ComputeHostDetailProps = {
  providerId: string
  // Called after the host is removed (SettingsPage returns to the list).
  onRemoved: () => void
}

// The four error slots on this page survive the action that produced them — they sit in state until the
// user retries. Storing a rendered sentence would freeze it in the language that was active when the
// failure happened, so a slot holds either a catalog key (+ params) resolved at render, or a message
// handed up verbatim from main, which is passed through untranslated in every locale.
type DetailError =
  | { kind: 'key'; key: DetailErrorKey; params?: Record<string, string | number> }
  | { kind: 'message'; message: string }

type DetailErrorKey =
  | 'Probe failed unexpectedly.'
  | 'Details must be {{limit}} characters or fewer.'
  | 'Failed to save details.'
  | 'Failed to set scratch root.'
  | 'Must be an integer between 1 and 500.'
  | 'Failed to set concurrency limit.'

// Wraps a caught error: a real Error keeps its message, anything else falls back to the catalog.
const failure = (err: unknown, key: DetailErrorKey): DetailError =>
  err instanceof Error ? { kind: 'message', message: err.message } : { kind: 'key', key }

// Host detail page for issues 02 + 03: probe button, probe failure banner, resource summary,
// details editor, scratch root editor, and concurrent job limit editor.
export function ComputeHostDetail({
  providerId,
  onRemoved
}: ComputeHostDetailProps): React.JSX.Element {
  const { t } = useTranslation()
  const { t: tCommon } = useTranslation()
  // Resolves a stored error slot at render time, so a language switch re-renders it in the new language.
  const errorText = (error: DetailError | undefined): string | undefined =>
    error === undefined
      ? undefined
      : error.kind === 'message'
        ? error.message
        : t(error.key, error.params)
  const hosts = useComputeStore((state) => state.hosts)
  const isLoaded = useComputeStore((state) => state.isLoaded)
  const loadHosts = useComputeStore((state) => state.loadHosts)
  const deleteHost = useComputeStore((state) => state.deleteHost)
  const probeHost = useComputeStore((state) => state.probeHost)
  const probingIds = useComputeStore((state) => state.probingIds)
  const saveDetails = useComputeStore((state) => state.saveDetails)
  const setScratch = useComputeStore((state) => state.setScratch)
  const setConcurrency = useComputeStore((state) => state.setConcurrency)

  const [probeError, setProbeError] = useState<DetailError | undefined>(undefined)

  // Details editor state
  const [detailsDoc, setDetailsDoc] = useState<string>('')
  const [originalDoc, setOriginalDoc] = useState<string>('')
  const [isEditingDetails, setIsEditingDetails] = useState(false)
  const [detailsSaving, setDetailsSaving] = useState(false)
  const [detailsError, setDetailsError] = useState<DetailError | undefined>(undefined)
  const [isSkeleton, setIsSkeleton] = useState(false)
  const detailsLoadedRef = useRef(false)

  // Scratch root editor state
  const [isEditingScratch, setIsEditingScratch] = useState(false)
  const [scratchInput, setScratchInput] = useState('')
  const [scratchSaving, setScratchSaving] = useState(false)
  const [scratchError, setScratchError] = useState<DetailError | undefined>(undefined)

  // Concurrency editor state
  const [isEditingConcurrency, setIsEditingConcurrency] = useState(false)
  const [concurrencyInput, setConcurrencyInput] = useState('')
  const [concurrencySaving, setConcurrencySaving] = useState(false)
  const [concurrencyError, setConcurrencyError] = useState<DetailError | undefined>(undefined)

  // Details expand/collapse state
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false)
  const [needsExpand, setNeedsExpand] = useState(false)
  const detailsRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (!isLoaded) void loadHosts()
  }, [isLoaded, loadHosts])

  const host = hosts.find((entry) => entry.providerId === providerId)
  const isProbing = probingIds.has(providerId)

  // Check if details content needs expand button
  useEffect(() => {
    if (!detailsRef.current || isEditingDetails) return
    const { scrollHeight, clientHeight } = detailsRef.current
    setNeedsExpand(scrollHeight > clientHeight + 10) // 10px threshold
  }, [detailsDoc, isEditingDetails])

  // Load the details doc (with skeleton synthesis) when the host is first available.
  useEffect(() => {
    if (!host || detailsLoadedRef.current) return
    detailsLoadedRef.current = true

    window.api.compute
      .detailsGet(providerId)
      .then(({ doc, isSkeleton: skelFlag }) => {
        setDetailsDoc(doc)
        setOriginalDoc(doc)
        setIsSkeleton(skelFlag)
      })
      .catch(() => {
        // Fallback to the cached detailsDoc if IPC fails.
        setDetailsDoc(host.detailsDoc ?? '')
        setOriginalDoc(host.detailsDoc ?? '')
      })
  }, [host, providerId])

  if (!host) {
    return (
      <div className="p-5">
        <p className="py-8 text-center text-sm text-muted-foreground">
          {isLoaded ? t('This host no longer exists.') : t('Loading host…')}
        </p>
      </div>
    )
  }

  const probed = host.probeResult
  const status: 'connected' | 'failed' | 'none' = probed
    ? probed.ok
      ? 'connected'
      : 'failed'
    : 'none'

  const probedAgo = probedLabel(host)

  const handleRemove = async (): Promise<void> => {
    await deleteHost(host.providerId)
    onRemoved()
  }

  const handleProbe = async (): Promise<void> => {
    setProbeError(undefined)
    try {
      await probeHost(host.providerId)
      // After a probe, reset the details-loaded flag so skeleton is re-fetched.
      detailsLoadedRef.current = false
    } catch (err) {
      setProbeError(failure(err, 'Probe failed unexpectedly.'))
    }
  }

  const handleDetailsSave = async (): Promise<void> => {
    if (detailsDoc.length > DETAILS_DOC_MAX_LENGTH) {
      setDetailsError({
        kind: 'key',
        key: 'Details must be {{limit}} characters or fewer.',
        params: { limit: DETAILS_DOC_MAX_LENGTH.toLocaleString() }
      })
      return
    }
    setDetailsSaving(true)
    setDetailsError(undefined)
    try {
      await saveDetails(providerId, detailsDoc, originalDoc)
      setOriginalDoc(detailsDoc)
      setIsSkeleton(false)
      setIsEditingDetails(false)
    } catch (err) {
      setDetailsError(failure(err, 'Failed to save details.'))
    } finally {
      setDetailsSaving(false)
    }
  }

  const handleDetailsCancel = (): void => {
    setDetailsDoc(originalDoc)
    setDetailsError(undefined)
    setIsEditingDetails(false)
  }

  const handleScratchEdit = (): void => {
    setScratchInput(host.scratchRoot ?? '')
    setScratchError(undefined)
    setIsEditingScratch(true)
  }

  const handleScratchSave = async (): Promise<void> => {
    setScratchSaving(true)
    setScratchError(undefined)
    try {
      await setScratch(providerId, scratchInput)
      setIsEditingScratch(false)
    } catch (err) {
      setScratchError(failure(err, 'Failed to set scratch root.'))
    } finally {
      setScratchSaving(false)
    }
  }

  const handleConcurrencyEdit = (): void => {
    setConcurrencyInput(String(host.concurrencyLimit ?? ''))
    setConcurrencyError(undefined)
    setIsEditingConcurrency(true)
  }

  const handleConcurrencySave = async (): Promise<void> => {
    const n = Number.parseInt(concurrencyInput, 10)
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      setConcurrencyError({ kind: 'key', key: 'Must be an integer between 1 and 500.' })
      return
    }
    setConcurrencySaving(true)
    setConcurrencyError(undefined)
    try {
      await setConcurrency(providerId, n)
      setIsEditingConcurrency(false)
    } catch (err) {
      setConcurrencyError(failure(err, 'Failed to set concurrency limit.'))
    } finally {
      setConcurrencySaving(false)
    }
  }

  return (
    <div className="p-5">
      {/* Header row: icon + name + badge + probe button + remove */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-lg',
              status === 'connected'
                ? 'bg-status-success-surface text-status-success-foreground dark:bg-status-success-dark-surface/40 dark:text-status-success-dark-foreground'
                : status === 'failed'
                  ? 'bg-status-failure-surface text-status-failure-foreground dark:bg-status-failure-dark-surface/40 dark:text-status-failure-dark-foreground'
                  : 'bg-muted text-muted-foreground'
            )}
            aria-hidden="true"
          >
            <Zap className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-lg font-semibold text-foreground">{host.displayName}</h3>
              {status === 'connected' ? (
                <Badge className="bg-status-success-surface text-status-success-foreground dark:bg-status-success-dark-surface/40 dark:text-status-success-dark-foreground">
                  {t('Connected')}
                </Badge>
              ) : status === 'failed' ? (
                <Badge className="bg-status-failure-surface text-status-failure-foreground dark:bg-status-failure-dark-surface/40 dark:text-status-failure-dark-foreground">
                  {t('Probe failed')}
                </Badge>
              ) : (
                <Badge variant="outline">{t('Not probed')}</Badge>
              )}
            </div>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">{host.providerId}</p>
            {probedAgo ? (
              <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                {t(probedAgo.key, { count: probedAgo.count })}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleProbe()}
            disabled={isProbing}
            aria-busy={isProbing}
          >
            <RefreshCw className={cn('size-3.5', isProbing && 'animate-spin')} aria-hidden="true" />
            {isProbing ? t('Probing…') : t('Probe')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => void handleRemove()}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            {t('Remove')}
          </Button>
        </div>
      </div>

      {/* Probe failed banner — shown when the last probe returned ok:false */}
      {status === 'failed' && probed ? (
        <div
          role="alert"
          className="mt-5 rounded-xl border border-status-failure-border bg-status-failure-subtle/50 px-3 py-3 dark:border-status-failure-dark-border/50 dark:bg-status-failure-dark-surface/20"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle
              className="size-4 shrink-0 text-status-failure-accent dark:text-status-failure-dark-foreground"
              aria-hidden="true"
            />
            <span className="text-sm font-semibold text-status-failure-foreground dark:text-status-failure-dark-emphasis">
              {t('Probe failed')}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void handleProbe()}
              disabled={isProbing}
              aria-label={t('Retry probe')}
              className="ml-auto text-status-failure-accent hover:bg-status-failure-surface dark:text-status-failure-dark-foreground"
            >
              <RefreshCw
                className={cn('size-3.5', isProbing && 'animate-spin')}
                aria-hidden="true"
              />
            </Button>
          </div>
          {probed.errorTail ? (
            <pre className="mt-2 overflow-x-auto rounded bg-status-failure-surface/50 px-2 py-1.5 font-mono text-xs text-status-failure-strong dark:bg-status-failure-dark-code/30 dark:text-status-failure-dark-emphasis">
              {probed.errorTail}
            </pre>
          ) : null}
        </div>
      ) : null}

      {/* IPC / unexpected probe error banner */}
      {probeError ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {errorText(probeError)}
        </p>
      ) : null}

      {/* Resource summary — shown only when a successful probe has populated resource fields */}
      {status === 'connected' && probed ? (
        <div className="mt-6 flex flex-col gap-2">
          <h4 className="text-sm font-medium text-foreground">{t('Resources')}</h4>
          <div className="flex flex-wrap gap-3">
            {probed.cpus != null ? (
              <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-2.5 py-1.5 text-sm">
                <Cpu className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span>
                  <span className="font-semibold">{probed.cpus}</span>{' '}
                  <span className="text-muted-foreground">{t('CPUs')}</span>
                </span>
              </div>
            ) : null}
            {probed.memMib != null ? (
              <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-2.5 py-1.5 text-sm">
                <MemoryStick
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span>
                  <span className="font-semibold">{Math.round(probed.memMib / 1024)}</span>{' '}
                  <span className="text-muted-foreground">{t('GB RAM')}</span>
                </span>
              </div>
            ) : null}
            {probed.gpus && probed.gpus.length > 0
              ? probed.gpus.map((gpu, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-2.5 py-1.5 text-sm"
                  >
                    <HardDrive
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span>
                      <span className="font-semibold">{gpu.count}&times;</span>{' '}
                      <span className="text-muted-foreground">{gpu.type}</span>
                    </span>
                  </div>
                ))
              : null}
            {probed.detectedScheduler && probed.detectedScheduler !== 'none' ? (
              <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-2.5 py-1.5 text-sm">
                <span className="font-semibold capitalize">{probed.detectedScheduler}</span>
                <span className="text-muted-foreground">{t('scheduler')}</span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Details document block */}
      <div className="mt-8">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h4 className="text-sm font-medium text-foreground">{t('Details')}</h4>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t(
                'Free-form notes about this provider. Open Science reads and adds to them as it learns.'
              )}
            </p>
          </div>
          {!isEditingDetails ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsEditingDetails(true)}
              className="shrink-0"
            >
              {t('Edit')}
            </Button>
          ) : null}
        </div>

        {isEditingDetails ? (
          <div className="mt-3 flex flex-col gap-2">
            <textarea
              className="min-h-[160px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring"
              value={detailsDoc}
              onChange={(e) => {
                setDetailsDoc(e.target.value)
                setDetailsError(undefined)
              }}
              aria-label={t('Details document')}
              aria-describedby={detailsError ? 'details-error' : undefined}
            />
            <div className="flex items-center justify-between gap-2">
              <span
                className={cn(
                  'font-mono text-xs',
                  detailsDoc.length > DETAILS_DOC_MAX_LENGTH
                    ? 'text-destructive'
                    : 'text-muted-foreground'
                )}
              >
                {t('{{used}} / {{limit}} chars', {
                  used: detailsDoc.length.toLocaleString(),
                  limit: DETAILS_DOC_MAX_LENGTH.toLocaleString()
                })}
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleDetailsCancel}
                  disabled={detailsSaving}
                >
                  {tCommon('Cancel')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleDetailsSave()}
                  disabled={detailsSaving || detailsDoc.length > DETAILS_DOC_MAX_LENGTH}
                  aria-busy={detailsSaving}
                >
                  {detailsSaving ? t('Saving…') : t('Save')}
                </Button>
              </div>
            </div>
            {detailsError ? (
              <p id="details-error" role="alert" className="text-xs text-destructive">
                {errorText(detailsError)}
              </p>
            ) : null}
          </div>
        ) : detailsDoc ? (
          <div className="mt-3">
            <div className="relative overflow-hidden rounded-lg border border-border bg-muted/20">
              <pre
                ref={detailsRef}
                className={cn(
                  'overflow-x-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs text-foreground/80 transition-opacity duration-150 motion-reduce:transition-none',
                  !isDetailsExpanded && 'max-h-[200px]',
                  isSkeleton && 'opacity-70'
                )}
              >
                {detailsDoc}
                {isSkeleton ? (
                  <span className="ml-2 text-muted-foreground">
                    {t('(auto-generated from probe)')}
                  </span>
                ) : null}
              </pre>
              {!isDetailsExpanded && needsExpand ? (
                <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-muted/20 to-transparent" />
              ) : null}
            </div>
            {needsExpand ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setIsDetailsExpanded(!isDetailsExpanded)}
                className="mt-2 text-xs text-muted-foreground hover:text-foreground"
              >
                {isDetailsExpanded ? (
                  <>
                    {t('Show less')} <ChevronUp className="ml-1 size-3" />
                  </>
                ) : (
                  <>
                    {t('Show more')} <ChevronDown className="ml-1 size-3" />
                  </>
                )}
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="mt-3 text-xs italic text-muted-foreground">
            {t('No notes yet. Click Edit to add details about this provider.')}
          </p>
        )}
      </div>

      {/* Scratch root block */}
      <div className="mt-7">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h4 className="text-sm font-medium text-foreground">{t('Scratch root')}</h4>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t(
                'Working directory for remote jobs. Pinned paths are never overwritten by re-probe.'
              )}
            </p>
          </div>
          {!isEditingScratch ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleScratchEdit}
              className="shrink-0"
            >
              {t('Edit')}
            </Button>
          ) : null}
        </div>

        {isEditingScratch ? (
          <div className="mt-3 flex flex-col gap-2">
            <input
              type="text"
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring"
              value={scratchInput}
              onChange={(e) => {
                setScratchInput(e.target.value)
                setScratchError(undefined)
              }}
              placeholder={t('/scratch/username')}
              aria-label={t('Scratch root path')}
              aria-describedby={scratchError ? 'scratch-error' : undefined}
            />
            {scratchError ? (
              <p id="scratch-error" role="alert" className="text-xs text-destructive">
                {errorText(scratchError)}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setIsEditingScratch(false)
                  setScratchError(undefined)
                }}
                disabled={scratchSaving}
              >
                {tCommon('Cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void handleScratchSave()}
                disabled={scratchSaving}
                aria-busy={scratchSaving}
              >
                {scratchSaving ? t('Saving…') : t('Save')}
              </Button>
            </div>
          </div>
        ) : host.scratchRoot ? (
          <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3.5 py-2.5">
            <span className="flex-1 font-mono text-xs text-muted-foreground">
              {host.scratchRoot}
            </span>
            {host.scratchPinned ? (
              <Badge variant="secondary" className="flex items-center gap-1 py-0 text-[10px]">
                <Pin className="size-3" aria-hidden="true" />
                {t('PINNED')}
              </Badge>
            ) : null}
          </div>
        ) : (
          <p className="mt-3 text-xs italic text-muted-foreground">
            {t('Not set. Will be updated from $SCRATCH on next probe.')}
          </p>
        )}
      </div>

      {/* Concurrent job limit block */}
      <div className="mt-7">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h4 className="text-sm font-medium text-foreground">{t('Concurrent job limit')}</h4>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t(
                'New jobs wait when this host reaches the limit (1–500). Lowering the limit does not stop running jobs.'
              )}
            </p>
          </div>
          {!isEditingConcurrency ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleConcurrencyEdit}
              className="shrink-0"
            >
              {t('Edit')}
            </Button>
          ) : null}
        </div>

        {isEditingConcurrency ? (
          <div className="mt-3 flex flex-col gap-2">
            <input
              type="number"
              min={1}
              max={500}
              className="w-32 rounded-md border border-input bg-background px-3 py-1.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring"
              value={concurrencyInput}
              onChange={(e) => {
                setConcurrencyInput(e.target.value)
                setConcurrencyError(undefined)
              }}
              placeholder="10"
              aria-label={t('Concurrent job limit')}
              aria-describedby={concurrencyError ? 'concurrency-error' : undefined}
            />
            {concurrencyError ? (
              <p id="concurrency-error" role="alert" className="text-xs text-destructive">
                {errorText(concurrencyError)}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setIsEditingConcurrency(false)
                  setConcurrencyError(undefined)
                }}
                disabled={concurrencySaving}
              >
                {tCommon('Cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void handleConcurrencySave()}
                disabled={concurrencySaving}
                aria-busy={concurrencySaving}
              >
                {concurrencySaving ? t('Saving…') : t('Save')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3 rounded-lg border border-border bg-muted/20 px-3.5 py-2.5">
            <span className="font-mono text-xs text-muted-foreground">
              {host.concurrencyLimit != null
                ? host.concurrencyLimit
                : t('{{value}} (default)', { value: 10 })}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
