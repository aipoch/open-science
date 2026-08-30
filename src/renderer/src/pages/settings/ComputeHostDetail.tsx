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

import {
  DETAILS_DOC_MAX_LENGTH,
  type ComputeAuthenticationErrorCode,
  type ComputePasswordCapability
} from '../../../../shared/compute'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatDisplayNumber } from '@/lib/locale-format'
import { useComputeStore } from '@/stores/compute-store'
import { useSettingsStore } from '@/stores/settings-store'
import { ComputePasswordResetSection } from './ComputePasswordResetSection'
import { probedLabel } from './compute-probed-label'
import {
  computeRuntimeRecoveryAction,
  computeRuntimeRecoveryCopy
} from './compute-runtime-recovery'
import { SettingsSection } from './SettingsLayout'
import { ComputeHostAuthenticationDetail } from './ComputeHostAuthenticationDetail'

type ComputeHostDetailProps = {
  providerId: string
  authenticationFocus?: ComputeAuthenticationErrorCode
  authenticationRequestId?: number
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
  | 'Failed to restore scratch auto-detection.'
  | 'Must be an integer between 1 and 500.'
  | 'Failed to set concurrency limit.'

// Wraps a caught error: a real Error keeps its message, anything else falls back to the catalog.
const failure = (err: unknown, key: DetailErrorKey): DetailError =>
  err instanceof Error ? { kind: 'message', message: err.message } : { kind: 'key', key }

// Host detail page for issues 02 + 03: probe button, probe failure banner, resource summary,
// details editor, scratch root editor, and concurrent job limit editor.
export function ComputeHostDetail({
  providerId,
  authenticationFocus,
  authenticationRequestId
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
  const probeHost = useComputeStore((state) => state.probeHost)
  const probingIds = useComputeStore((state) => state.probingIds)
  const saveDetails = useComputeStore((state) => state.saveDetails)
  const setScratch = useComputeStore((state) => state.setScratch)
  const clearScratch = useComputeStore((state) => state.clearScratch)
  const setConcurrency = useComputeStore((state) => state.setConcurrency)
  const openSettingsToComputeAuthentication = useSettingsStore(
    (state) => state.openSettingsToComputeAuthentication
  )
  const host = hosts.find((entry) => entry.providerId === providerId)
  const isProbing = probingIds.has(providerId)
  const changeAuthentication = useComputeStore((state) => state.changeAuthentication)

  const [probeError, setProbeError] = useState<DetailError | undefined>(undefined)
  const authenticationAlertRef = useRef<HTMLDivElement>(null)
  const authenticationTestRef = useRef<HTMLButtonElement>(null)
  const [resolvedAuthenticationRequest, setResolvedAuthenticationRequest] = useState<
    string | number | undefined
  >()
  const authenticationRequest = authenticationRequestId ?? authenticationFocus
  const showAuthenticationRecovery =
    authenticationFocus !== undefined && resolvedAuthenticationRequest !== authenticationRequest
  const authenticationRetriesPaused =
    host?.probeResult?.authenticationCode === 'authentication_failed' &&
    host.probeResult.authenticationRevision === (host.authentication?.revision ?? 0)

  const [passwordCapability, setPasswordCapability] = useState<
    ComputePasswordCapability | undefined
  >(undefined)
  const [authenticationEditor, setAuthenticationEditor] = useState<
    'configuration' | 'password' | undefined
  >()
  const secureStorageBlocksRecovery =
    authenticationFocus === 'secure_storage_unavailable' || passwordCapability?.available === false
  const recoveryRequestsPasswordEntry =
    authenticationFocus === 'credential_required' ||
    authenticationFocus === 'credential_unavailable' ||
    authenticationFocus === 'authentication_failed' ||
    authenticationFocus === 'credential_conflict' ||
    authenticationFocus === 'reset_failed'
  const authenticationRecoveryEditor = secureStorageBlocksRecovery
    ? undefined
    : host?.authentication?.mode === 'password' && recoveryRequestsPasswordEntry
      ? 'password'
      : 'configuration'
  const recoveryCanPrepare =
    showAuthenticationRecovery &&
    host !== undefined &&
    (host.authentication?.mode !== 'password' || passwordCapability !== undefined)
  const recoveryPreparationKey = recoveryCanPrepare
    ? `${host.providerId}:${String(authenticationRequest)}:${String(passwordCapability?.available)}`
    : undefined
  const [preparedAuthenticationRecovery, setPreparedAuthenticationRecovery] = useState<
    string | undefined
  >()

  // Prepare each deep-link request before commit so the focus effect sees the actionable editor in
  // the same committed tree. A repeated error code receives a new request id and reopens it.
  if (
    recoveryPreparationKey !== undefined &&
    preparedAuthenticationRecovery !== recoveryPreparationKey
  ) {
    setPreparedAuthenticationRecovery(recoveryPreparationKey)
    setAuthenticationEditor(authenticationRecoveryEditor)
  }

  useEffect(() => {
    if (!showAuthenticationRecovery || !host) return
    if (host.authentication?.mode === 'password' && passwordCapability === undefined) return
    if (authenticationEditor !== authenticationRecoveryEditor) return

    const target = secureStorageBlocksRecovery
      ? authenticationTestRef.current
      : document.getElementById(
          authenticationRecoveryEditor === 'password'
            ? 'compute-reset-password'
            : 'compute-detail-username'
        )
    const destination = target ?? authenticationAlertRef.current
    destination?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    destination?.focus({ preventScroll: true })
  }, [
    authenticationEditor,
    authenticationRecoveryEditor,
    authenticationRequest,
    host,
    passwordCapability,
    secureStorageBlocksRecovery,
    showAuthenticationRecovery
  ])

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
  const [scratchClearing, setScratchClearing] = useState(false)
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

  useEffect(() => {
    if (host?.authentication?.mode !== 'password') return
    void window.api.compute
      .passwordCapability()
      .then(setPasswordCapability)
      .catch(() =>
        setPasswordCapability({ available: false, reason: 'secure_storage_unavailable' })
      )
  }, [host?.authentication?.mode])

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
  const credentialReady =
    host.authentication?.mode !== 'password' ||
    host.authentication.credentialStatus === 'configured'
  const status: 'last_probe_ok' | 'failed' | 'none' = !credentialReady
    ? 'none'
    : probed
      ? probed.ok
        ? 'last_probe_ok'
        : 'failed'
      : 'none'

  const probedAgo = probedLabel(host)

  const handleProbe = async (): Promise<void> => {
    setProbeError(undefined)
    try {
      const result = await probeHost(host.providerId)
      if (result.ok && authenticationRequest !== undefined) {
        setResolvedAuthenticationRequest(authenticationRequest)
      }
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
        params: { limit: formatDisplayNumber(DETAILS_DOC_MAX_LENGTH) }
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

  const handleScratchClear = async (): Promise<void> => {
    setScratchClearing(true)
    setScratchError(undefined)
    try {
      await clearScratch(providerId)
    } catch (err) {
      setScratchError(failure(err, 'Failed to restore scratch auto-detection.'))
    } finally {
      setScratchClearing(false)
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
      {/* Header row: icon + name + badge + probe button */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-lg',
              status === 'last_probe_ok'
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
              {status === 'last_probe_ok' ? (
                <Badge className="bg-status-success-surface text-status-success-foreground dark:bg-status-success-dark-surface/40 dark:text-status-success-dark-foreground">
                  {t('Last probe succeeded')}
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
          <p className="mt-2 text-xs text-status-failure-strong dark:text-status-failure-dark-emphasis">
            {probed.authenticationCode
              ? computeRuntimeRecoveryCopy(probed.authenticationCode, t)
              : t(
                  'The Compute Host connection failed. Check the Host and network, then try again.'
                )}
          </p>
          {probed.authenticationCode ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() =>
                openSettingsToComputeAuthentication(providerId, probed.authenticationCode!)
              }
            >
              {computeRuntimeRecoveryAction(probed.authenticationCode, t)}
            </Button>
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
      {status === 'last_probe_ok' && probed ? (
        <SettingsSection
          className="mt-6 rounded-xl border border-border bg-card p-4"
          title={t('Resources')}
        >
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
        </SettingsSection>
      ) : null}

      <SettingsSection
        className="mt-6"
        title={t('Configuration')}
        titleId="compute-configuration-heading"
        aria-labelledby="compute-configuration-heading"
        description={
          <>
            {host.authentication?.mode === 'password'
              ? t('Username and password')
              : t('SSH configuration')}
            {' · '}
            {/* Only password hosts carry a stored credential; ssh_config always reads "missing"
                from the repository placeholder, which would read as a fault rather than a fact. */}
            {host.authentication?.mode === 'password' ? (
              <>
                {host.authentication.credentialStatus === 'unavailable'
                  ? t('Credential unavailable')
                  : host.authentication.credentialStatus === 'missing'
                    ? t('Credential missing')
                    : t('Credential configured')}
                {' · '}
              </>
            ) : null}
            {authenticationRetriesPaused
              ? t('Background retries paused')
              : t('Background retries active')}
          </>
        }
        action={
          authenticationEditor !== 'configuration' ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => setAuthenticationEditor('configuration')}
            >
              {t('Edit')}
            </Button>
          ) : null
        }
      >
        {showAuthenticationRecovery ? (
          <div
            ref={authenticationAlertRef}
            data-compute-authentication-alert
            role="alert"
            tabIndex={-1}
            className="mt-3 rounded-lg border border-status-failure-border bg-status-failure-subtle/50 px-3 py-2 text-sm text-status-failure-strong outline-none"
          >
            <p>{computeRuntimeRecoveryCopy(authenticationFocus, t)}</p>
            {authenticationFocus === 'secure_storage_unavailable' ||
            passwordCapability?.available === false ? (
              <Button
                ref={authenticationTestRef}
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                disabled={isProbing}
                onClick={() => void handleProbe()}
              >
                {t('Test connection')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {host.authentication?.mode === 'password' &&
        host.authentication.credentialStatus === 'missing' ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {t(
              'The saved credential is missing. Password authentication is blocked and does not fall back to SSH configuration.'
            )}
          </p>
        ) : null}
        {host.authentication?.mode === 'password' &&
        host.authentication.credentialStatus === 'unavailable' ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {t(
              'The encrypted credential cannot be used on this device. Password authentication is blocked and does not fall back to SSH configuration.'
            )}
          </p>
        ) : null}
        {host.authentication?.mode === 'password' &&
        passwordCapability?.available === false &&
        passwordCapability.reason === 'unsupported_platform' ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {t(
              'Password authentication is disabled because this platform cannot provide secure credential storage and constrained password delivery.'
            )}
          </p>
        ) : null}
        {host.authentication?.mode === 'password' &&
        passwordCapability?.available === false &&
        passwordCapability.reason !== 'unsupported_platform' ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {t(
              'Secure credential storage is locked or unavailable. Unlock the system credential store and retry.'
            )}
          </p>
        ) : null}
        {host.authentication?.mode !== 'password' ||
        host.authentication.credentialStatus !== 'unavailable' ||
        passwordCapability !== undefined ? (
          <div className="mt-4">
            <ComputeHostAuthenticationDetail
              host={host}
              isEditing={authenticationEditor === 'configuration'}
              onEditingChange={(isEditing) =>
                setAuthenticationEditor((current) =>
                  isEditing ? 'configuration' : current === 'configuration' ? undefined : current
                )
              }
              onUpdatePassword={() => setAuthenticationEditor('password')}
              changeAuthentication={changeAuthentication}
            />
            <ComputePasswordResetSection
              key={`${host.providerId}:${host.authentication?.mode ?? 'ssh_config'}`}
              host={host}
              isEditing={authenticationEditor === 'password'}
              onEditingChange={(isEditing) =>
                setAuthenticationEditor((current) =>
                  isEditing ? 'password' : current === 'password' ? undefined : current
                )
              }
            />
          </div>
        ) : null}
      </SettingsSection>

      {/* Details document block */}
      <SettingsSection
        className="mt-5"
        separated
        title={t('Details')}
        description={t(
          'Free-form notes about this provider. Open Science reads and adds to them as it learns.'
        )}
        action={
          !isEditingDetails ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsEditingDetails(true)}
              className="shrink-0"
            >
              {t('Edit')}
            </Button>
          ) : null
        }
      >
        {isEditingDetails ? (
          <div className="flex flex-col gap-2">
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
                  used: formatDisplayNumber(detailsDoc.length),
                  limit: formatDisplayNumber(DETAILS_DOC_MAX_LENGTH)
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
          <div>
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
          <p className="text-xs italic text-muted-foreground">
            {t('No notes yet. Click Edit to add details about this provider.')}
          </p>
        )}
      </SettingsSection>

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
            <div className="flex shrink-0 items-center gap-2">
              {host.scratchPinned ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleScratchClear()}
                  disabled={scratchClearing}
                  aria-busy={scratchClearing}
                >
                  {t('Restore auto-detection')}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleScratchEdit}
                disabled={scratchClearing}
              >
                {t('Edit')}
              </Button>
            </div>
          ) : null}
        </div>

        {isEditingScratch ? (
          <div className="mt-3 flex flex-col gap-2">
            <input
              type="text"
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 font-mono text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              value={scratchInput}
              onChange={(e) => {
                setScratchInput(e.target.value)
                setScratchError(undefined)
              }}
              placeholder={t('/scratch/username')}
              aria-label={t('Scratch root path')}
              aria-describedby={scratchError ? 'scratch-error' : undefined}
            />
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
                disabled={scratchSaving || scratchInput.trim().length === 0}
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
        {scratchError ? (
          <p id="scratch-error" role="alert" className="mt-2 text-xs text-destructive">
            {errorText(scratchError)}
          </p>
        ) : null}
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
              className="w-32 rounded-md border border-input bg-background px-3 py-1.5 font-mono text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
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
