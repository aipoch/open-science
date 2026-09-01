import { QRCodeSVG } from '@rc-component/qrcode'
import { Dialog } from 'radix-ui'
import {
  AlertTriangle,
  CheckCircle2,
  CircleOff,
  Copy,
  ExternalLink,
  Globe2,
  Laptop,
  LoaderCircle,
  RadioTower,
  RefreshCw,
  Smartphone,
  Trash2
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation, Trans } from 'react-i18next'

import type {
  RemoteAccessMode,
  RemoteAccessSnapshot,
  RemotePairingDecision
} from '../../../../shared/remote-access'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  dialogDescriptionClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { cn } from '@/lib/utils'
import { SettingsIconAction, SettingsSection } from './SettingsLayout'

const REMOTE_IT_DOWNLOAD_URL = 'https://www.remote.it/download/'
const REMOTE_ACCESS_FRESH_MS = 60_000
type CopyStatus = 'idle' | 'copied' | 'error'
type RemoteControlPanelComponent = {
  (): React.JSX.Element
  preload(): Promise<RemoteAccessSnapshot>
}

let cachedRemoteAccess: { snapshot: RemoteAccessSnapshot; loadedAt: number } | undefined
let cachedRemoteAccessOwner: Window['api']['remoteAccess'] | undefined
let remoteAccessLoadInFlight: Promise<RemoteAccessSnapshot> | undefined
let remoteAccessRequestGeneration = 0
let remoteAccessPanelMounts = 0
let remoteAccessChangeOwner: Window['api']['remoteAccess'] | undefined
let unsubscribeRemoteAccessChanges: (() => void) | undefined
const remoteAccessChangeListeners = new Set<() => void>()

const beginRemoteAccessRequest = (): number => ++remoteAccessRequestGeneration
const beginRemoteAccessLoad = (): number =>
  remoteAccessLoadInFlight ? remoteAccessRequestGeneration : beginRemoteAccessRequest()
const isCurrentRemoteAccessRequest = (generation: number): boolean =>
  generation === remoteAccessRequestGeneration

const ensureRemoteAccessChangeSubscription = (): void => {
  const remoteAccess = window.api.remoteAccess
  if (remoteAccessChangeOwner === remoteAccess && unsubscribeRemoteAccessChanges) return

  unsubscribeRemoteAccessChanges?.()
  remoteAccessChangeOwner = remoteAccess
  unsubscribeRemoteAccessChanges = remoteAccess.onChanged(() => {
    if (remoteAccessChangeOwner !== remoteAccess) return

    // Keep the event subscription alive while the panel is closed. The next mount must not reuse
    // a snapshot that predates a pairing request or lifecycle change.
    cachedRemoteAccess = undefined
    cachedRemoteAccessOwner = undefined
    remoteAccessLoadInFlight = undefined
    beginRemoteAccessRequest()
    remoteAccessChangeListeners.forEach((listener) => listener())
  })
}

const subscribeToRemoteAccessChanges = (listener: () => void): (() => void) => {
  ensureRemoteAccessChangeSubscription()
  remoteAccessChangeListeners.add(listener)
  return () => remoteAccessChangeListeners.delete(listener)
}

const freshRemoteAccessSnapshot = (): RemoteAccessSnapshot | undefined =>
  cachedRemoteAccessOwner === window.api.remoteAccess &&
  cachedRemoteAccess &&
  Date.now() - cachedRemoteAccess.loadedAt < REMOTE_ACCESS_FRESH_MS
    ? cachedRemoteAccess.snapshot
    : undefined

const cacheRemoteAccessSnapshot = (
  snapshot: RemoteAccessSnapshot,
  generation: number
): RemoteAccessSnapshot => {
  if (!isCurrentRemoteAccessRequest(generation)) return snapshot
  cachedRemoteAccessOwner = window.api.remoteAccess
  cachedRemoteAccess = { snapshot, loadedAt: Date.now() }
  return snapshot
}

const lifecycleLabel = (snapshot: RemoteAccessSnapshot, t: TFunction): string => {
  if (snapshot.lifecycle === 'starting') return t('Starting…')
  if (snapshot.lifecycle === 'stopping') return t('Stopping…')
  if (snapshot.mode === 'off') return t('Remote access is off')
  if (snapshot.lifecycle === 'running' && snapshot.mode === 'remoteit') return t('App access is on')
  if (snapshot.lifecycle === 'running' && snapshot.mode === 'remoteit-public') {
    return t('Browser access is on')
  }
  if (snapshot.lifecycle === 'error') return t('Needs attention')
  return t('Remote access is off')
}

const getAccessModes = (
  t: TFunction
): {
  mode: RemoteAccessMode
  title: string
  description: string
  icon: typeof CircleOff
}[] => [
  {
    mode: 'off',
    title: t('Off'),
    description: t(
      'Remote access is paused. Provider setup and trusted browsers are kept for reuse.'
    ),
    icon: CircleOff
  },
  {
    mode: 'remoteit',
    title: t('App access'),
    description: t('Open Open Science from the signed-in mobile app with two-step verification.'),
    icon: RadioTower
  },
  {
    mode: 'remoteit-public',
    title: t('Browser access'),
    description: t('Open a persistent link in any browser with two-step verification.'),
    icon: Globe2
  }
]

const providerStatus = (snapshot: RemoteAccessSnapshot, t: TFunction): string => {
  if (!snapshot.remoteIt.installed) return t('Not installed')
  if (!snapshot.remoteIt.registered) return t('Device setup required')
  if (!snapshot.remoteIt.loggedIn) return t('Sign-in required')
  if (snapshot.enabled && snapshot.lifecycle === 'running') return t('Connected')
  return t('Ready')
}

const loadRemoteAccessSnapshot = async (
  onInitial: (snapshot: RemoteAccessSnapshot) => void = () => undefined,
  isActive: () => boolean = () => true,
  force = false,
  generation = beginRemoteAccessLoad()
): Promise<RemoteAccessSnapshot> => {
  ensureRemoteAccessChangeSubscription()
  const cached = !force ? freshRemoteAccessSnapshot() : undefined
  if (cached) {
    if (isActive()) onInitial(cached)
    return cached
  }
  if (remoteAccessLoadInFlight) return remoteAccessLoadInFlight

  const request = window.api.remoteAccess.getSnapshot().then(async (initial) => {
    if (!isCurrentRemoteAccessRequest(generation)) return initial
    if (!initial.canManage) cacheRemoteAccessSnapshot(initial, generation)
    if (!isActive()) return initial
    onInitial(initial)
    if (!initial.canManage) return initial
    const probed = await window.api.remoteAccess.probe()
    return cacheRemoteAccessSnapshot(probed, generation)
  })
  const trackedRequest = request.finally(() => {
    if (remoteAccessLoadInFlight === trackedRequest) remoteAccessLoadInFlight = undefined
  })
  remoteAccessLoadInFlight = trackedRequest
  return trackedRequest
}

const BrowserAccessSteps = ({ t }: { t: TFunction }): React.JSX.Element => (
  <div className="mt-4 flex items-start gap-3 border-t border-blue-600/15 pt-4">
    <Smartphone className="mt-0.5 size-5 shrink-0 text-blue-600" aria-hidden="true" />
    <ol className="min-w-0 space-y-2 text-sm leading-relaxed text-foreground">
      <li>
        <span className="font-medium">1.</span>{' '}
        {t('Scan the QR code or open the saved link in a browser.')}
      </li>
      <li>
        <span className="font-medium">2.</span>{' '}
        {t(
          'Complete two-step verification by matching the six-digit code, then approve the request from this computer or a trusted browser.'
        )}
      </li>
      <li>
        <span className="font-medium">3.</span>{' '}
        {t(
          'Choose "Trust this browser for 180 days" for direct access on future visits while Browser access is on.'
        )}
      </li>
    </ol>
  </div>
)

export const RemoteControlPanel: RemoteControlPanelComponent = () => {
  const { t } = useTranslation()
  const formatDate = useDateTimeFormat()

  const initialSnapshot = freshRemoteAccessSnapshot()
  const [snapshot, setSnapshot] = useState<RemoteAccessSnapshot | null>(initialSnapshot ?? null)
  const [busy, setBusy] = useState<string | null>(initialSnapshot ? null : 'loading')
  const [actionError, setActionError] = useState<string | undefined>()
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle')

  const operationTriggerRef = useRef<HTMLElement | null>(null)
  const initialLoadRetryRef = useRef(false)
  const mountedRef = useRef(false)
  const copyResetTimerRef = useRef<number | undefined>(undefined)
  const refresh = async (detect = false, completesBusyOperation = true): Promise<void> => {
    const generation = beginRemoteAccessRequest()
    try {
      const next = detect
        ? await window.api.remoteAccess.detect()
        : await window.api.remoteAccess.getSnapshot()
      if (!detect && !isCurrentRemoteAccessRequest(generation)) return
      // A manual Detect result is authoritative over progress broadcasts emitted while it ran.
      const commitGeneration = detect ? beginRemoteAccessRequest() : generation
      cacheRemoteAccessSnapshot(next, commitGeneration)
      setSnapshot(next)
      setActionError(undefined)
    } catch (error) {
      if (isCurrentRemoteAccessRequest(generation)) {
        setActionError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (completesBusyOperation) {
        setBusy(null)
      } else if (isCurrentRemoteAccessRequest(generation)) {
        setBusy((current) => (current === 'loading' ? null : current))
      }
    }
  }

  useEffect(() => {
    let active = true
    remoteAccessPanelMounts += 1
    mountedRef.current = true
    const generation = beginRemoteAccessLoad()
    void loadRemoteAccessSnapshot(
      (initial) => {
        if (active) setSnapshot(initial)
      },
      () => remoteAccessPanelMounts > 0,
      false,
      generation
    )
      .then((next) => {
        if (!active || !isCurrentRemoteAccessRequest(generation)) return
        setSnapshot(next)
      })
      .catch((error: unknown) => {
        if (active && isCurrentRemoteAccessRequest(generation)) {
          setActionError(error instanceof Error ? error.message : String(error))
        }
      })
      .finally(() => {
        if (active && isCurrentRemoteAccessRequest(generation)) setBusy(null)
      })
    const unsubscribe = subscribeToRemoteAccessChanges(() => {
      // Lifecycle broadcasts are progress updates for an in-flight action. They must not clear
      // `busy`; only the Promise that started the mode change or Detect operation may do that.
      if (active) void refresh(false, false)
    })
    return () => {
      active = false
      remoteAccessPanelMounts -= 1
      mountedRef.current = false
      if (copyResetTimerRef.current !== undefined) {
        window.clearTimeout(copyResetTimerRef.current)
      }
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (busy !== null || !operationTriggerRef.current) return
    operationTriggerRef.current.focus()
    operationTriggerRef.current = null
  }, [busy])

  const run = async (
    name: string,
    action: (generation: number) => Promise<RemoteAccessSnapshot>
  ): Promise<void> => {
    const generation = beginRemoteAccessRequest()
    setBusy(name)
    setActionError(undefined)
    try {
      const next = await action(generation)
      // The completed user action is authoritative over lifecycle progress broadcasts.
      const commitGeneration = beginRemoteAccessRequest()
      cacheRemoteAccessSnapshot(next, commitGeneration)
      setSnapshot(next)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }

  const retryInitialLoad = (): void => {
    if (initialLoadRetryRef.current) return
    initialLoadRetryRef.current = true
    void run('loading', (generation) =>
      loadRemoteAccessSnapshot(setSnapshot, () => mountedRef.current, true, generation)
    ).finally(() => {
      initialLoadRetryRef.current = false
    })
  }

  const approve = (requestId: string, decision: RemotePairingDecision): void => {
    void run(`approve:${requestId}`, () => window.api.remoteAccess.approve({ requestId, decision }))
  }

  const copyUrl = async (): Promise<void> => {
    if (!snapshot?.accessUrl) return
    if (copyResetTimerRef.current !== undefined) {
      window.clearTimeout(copyResetTimerRef.current)
    }
    setCopyStatus('idle')

    try {
      await navigator.clipboard.writeText(snapshot.accessUrl)
      if (!mountedRef.current) return
      setCopyStatus('copied')
      copyResetTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) setCopyStatus('idle')
      }, 1_500)
    } catch {
      if (mountedRef.current) setCopyStatus('error')
    }
  }

  if (!snapshot) {
    if (actionError) {
      return (
        <div className="p-5" data-testid="remote-control-load-error">
          <div
            className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{t("Remote access couldn't be loaded.")}</div>
              <div className="mt-1 break-words text-xs">{actionError}</div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3"
                disabled={busy !== null}
                onClick={retryInitialLoad}
              >
                <RefreshCw className="size-3.5" aria-hidden="true" />
                {t('Try again')}
              </Button>
            </div>
          </div>
        </div>
      )
    }
    return (
      <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
        <LoaderCircle className="mr-2 size-4 animate-spin" aria-hidden="true" />
        {t('Loading remote access…')}
      </div>
    )
  }

  const modeError = actionError ?? snapshot.error
  const changingMode = busy?.startsWith('mode:') === true
  const detectingAndRepairing = busy === 'detect'
  const blockingRemoteOperation = changingMode || detectingAndRepairing
  const hasModeError = Boolean(modeError)
  const accessIsApp = snapshot.mode === 'remoteit'
  const accessIsBrowser = snapshot.mode === 'remoteit-public'
  const accessUsesPairing = snapshot.mode === 'remoteit' || snapshot.mode === 'remoteit-public'
  const showTrustedBrowsers =
    snapshot.canManagePairing && (accessUsesPairing || snapshot.trustedBrowsers.length > 0)
  const statusLabel = providerStatus(snapshot, t)
  const statusClassName =
    snapshot.enabled && snapshot.lifecycle === 'running'
      ? 'border-0 bg-primary/10 text-primary'
      : undefined

  const detectButton = snapshot.canManage ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={busy !== null}
      onClick={(event) => {
        operationTriggerRef.current = event.currentTarget
        setBusy('detect')
        void refresh(true)
      }}
      className="shrink-0"
    >
      <RefreshCw
        className={`size-3.5 ${busy === 'detect' ? 'animate-spin' : ''}`}
        aria-hidden="true"
      />
      {t('Detect again')}
    </Button>
  ) : null

  return (
    <div className="space-y-5 p-5" data-testid="remote-control-panel">
      <Dialog.Root open={blockingRemoteOperation}>
        <Dialog.Portal>
          <Dialog.Overlay
            className={cn(dialogOverlayClassName, 'z-[100] bg-black/45')}
            data-testid="remote-access-operation-scrim"
          />
          <Dialog.Content
            className={dialogPanelClassName(
              'z-[100] flex w-[min(384px,calc(100vw-3rem))] max-w-sm items-center gap-3 px-5 py-4'
            )}
            onEscapeKeyDown={(event) => event.preventDefault()}
            onInteractOutside={(event) => event.preventDefault()}
            aria-modal="true"
            aria-busy="true"
            aria-live="assertive"
            data-testid="remote-access-operation-overlay"
          >
            <LoaderCircle className="size-5 shrink-0 animate-spin text-primary" aria-hidden />
            <div>
              <Dialog.Title className={dialogTitleClassName}>
                {detectingAndRepairing
                  ? t('Checking and setting up remote access…')
                  : t('Applying remote access settings…')}
              </Dialog.Title>
              <Dialog.Description className={cn(dialogDescriptionClassName, 'mt-1 text-xs')}>
                {t('Waiting for the system command to finish.')}
              </Dialog.Description>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <SettingsSection
        className="relative"
        contentClassName="space-y-3"
        title={t('Remote browser access')}
        description={
          <>
            <Trans
              i18nKey="Choose who can reach this computer's Open Science workspace. All projects, agents, files, and notebook runtimes continue to run on this computer. Install and sign in to the Remote.It desktop app before enabling access. <lnk>Download Remote.It App</lnk>"
              components={{
                lnk: (
                  <ExternalTextLink
                    href={REMOTE_IT_DOWNLOAD_URL}
                    className="box-decoration-clone rounded-sm bg-primary/10 px-1 py-0.5 font-medium text-primary underline decoration-primary/50 underline-offset-2 transition-colors hover:bg-primary/15 hover:decoration-primary"
                  >
                    {/* placeholder — Trans injects children */}
                    {''}
                  </ExternalTextLink>
                )
              }}
            />
          </>
        }
        actionClassName="w-full sm:w-auto"
        action={
          <Badge
            data-testid="remote-access-status"
            role="status"
            aria-live="polite"
            className="sm:absolute sm:right-0 sm:top-0"
            variant={hasModeError ? 'destructive' : snapshot.enabled ? 'secondary' : 'outline'}
          >
            {changingMode
              ? t('Changing access mode…')
              : detectingAndRepairing
                ? t('Checking access…')
                : lifecycleLabel(snapshot, t)}
          </Badge>
        }
      >
        <div
          className="grid grid-cols-1 gap-2 sm:grid-cols-3"
          role="radiogroup"
          aria-label={t('Remote access mode')}
        >
          {getAccessModes(t).map((option) => {
            const selected = snapshot.mode === option.mode
            const disabled = !snapshot.canManage || busy !== null
            const Icon = option.icon
            const selectMode = (): void => {
              if (disabled) return
              void run(`mode:${option.mode}`, () =>
                window.api.remoteAccess.setMode({ mode: option.mode })
              )
            }
            return (
              <label
                key={option.mode}
                className={`relative min-w-0 rounded-xl border p-3 text-left transition-colors ${
                  disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer hover:bg-muted/45'
                } ${
                  selected ? 'border-primary bg-primary/5 ring-1 ring-primary/20' : 'border-border'
                }`}
              >
                <input
                  type="radio"
                  name="remote-access-mode"
                  aria-label={option.title}
                  checked={selected}
                  disabled={disabled}
                  onChange={(event) => {
                    operationTriggerRef.current = event.currentTarget
                    selectMode()
                  }}
                  className="peer sr-only"
                />
                <div className="flex min-w-0 items-center gap-2">
                  <Icon
                    className={`size-4 shrink-0 ${selected ? 'text-primary' : 'text-muted-foreground'}`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 text-sm font-medium text-foreground">
                    {t(option.title)}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {t(option.description)}
                </p>
                <span
                  className="pointer-events-none absolute inset-0 rounded-xl ring-primary peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2"
                  aria-hidden="true"
                />
              </label>
            )
          })}
        </div>

        {modeError ? (
          <div className="rounded-lg border border-destructive/35 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {t(modeError)}
          </div>
        ) : null}

        {!snapshot.canManage ? (
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            {t(
              snapshot.canManagePairing && accessUsesPairing
                ? 'Remote access settings can only be changed from the Open Science desktop window on the home computer. Two-step verification requests and trusted browsers can be managed below.'
                : 'Remote access settings can only be changed from the Open Science desktop window on the home computer.'
            )}
          </div>
        ) : null}
      </SettingsSection>

      {accessIsApp ? (
        <SettingsSection
          contentClassName="space-y-3"
          title={t('Remote App Access')}
          action={
            <Badge variant="outline" className={statusClassName}>
              {statusLabel}
            </Badge>
          }
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <p className="max-w-2xl text-[13px] leading-5 text-muted-foreground">
              {t(
                'Open this computer from the signed-in mobile app. Open Science creates and maintains the local service automatically after this computer is added once.'
              )}
            </p>
            {detectButton}
          </div>

          <div
            className="rounded-xl border border-blue-600/20 bg-blue-500/5 p-4"
            data-testid="remoteit-access-guide"
          >
            <div className="flex items-start gap-3">
              <Smartphone
                className="mt-0.5 size-5 shrink-0 text-blue-600"
                data-testid="remoteit-guide-phone-icon"
                aria-hidden="true"
              />
              <ol className="min-w-0 space-y-2 text-sm leading-relaxed text-foreground">
                <li>
                  <span className="font-medium">1.</span>{' '}
                  {t('Open the mobile app and sign in to the same account as this computer.')}
                </li>
                <li>
                  <span className="font-medium">2.</span> {t('Select this computer, then select')}{' '}
                  <span className="font-medium">Open Science Remote</span>.
                </li>
                <li>
                  <span className="font-medium">3.</span>{' '}
                  {t(
                    'Tap Connect or Launch, match the six-digit code, then approve the request from this computer or an already trusted browser.'
                  )}
                </li>
                <li>
                  <span className="font-medium">4.</span>{' '}
                  {t(
                    'Choose "Trust this browser for 180 days" to skip approval on future visits to the same remote address.'
                  )}
                </li>
              </ol>
            </div>
          </div>
        </SettingsSection>
      ) : null}

      {accessIsBrowser ? (
        <SettingsSection
          contentClassName="space-y-3"
          title={t('Remote Browser Access')}
          action={
            <Badge variant="outline" className={statusClassName}>
              {statusLabel}
            </Badge>
          }
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <p className="max-w-2xl text-[13px] leading-5 text-muted-foreground">
              {t(
                'Open a persistent HTTPS address from any modern browser. Open Science creates and maintains the public browser service automatically.'
              )}
            </p>
            {detectButton}
          </div>

          <div
            className="rounded-xl border border-blue-600/20 bg-blue-500/5 p-4"
            data-testid="remoteit-public-access-guide"
          >
            {snapshot.enabled && snapshot.accessUrl ? (
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-3">
                    <CheckCircle2
                      className="mt-0.5 size-5 shrink-0 text-blue-600"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-sm font-medium text-foreground">
                          {t('Browser link is ready')}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void copyUrl()}
                          >
                            <Copy className="size-3.5" aria-hidden="true" />
                            {copyStatus === 'copied' ? t('Copied') : t('Copy')}
                          </Button>
                          <Button type="button" variant="outline" size="sm" asChild>
                            <a href={snapshot.accessUrl} target="_blank" rel="noreferrer">
                              <ExternalLink className="size-3.5" aria-hidden="true" />
                              {t('Open')}
                            </a>
                          </Button>
                        </div>
                      </div>
                      <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
                        {snapshot.accessUrl}
                      </div>
                      {copyStatus === 'error' ? (
                        <div
                          role="alert"
                          className="mt-2 text-xs text-destructive"
                          data-testid="remote-link-copy-error"
                        >
                          {t('Could not copy the browser link. Select it and copy it manually.')}
                        </div>
                      ) : null}
                      <span
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
                        className="sr-only"
                        data-testid="remote-link-copy-status"
                      >
                        {copyStatus === 'copied' ? t('Browser link copied.') : ''}
                      </span>
                    </div>
                  </div>
                  <BrowserAccessSteps t={t} />
                </div>
                <div
                  className="justify-self-center rounded-xl border border-border bg-white p-2 shadow-sm sm:justify-self-end"
                  data-testid="remoteit-public-qr"
                >
                  <QRCodeSVG
                    value={snapshot.accessUrl}
                    size={116}
                    level="M"
                    marginSize={2}
                    bgColor="#ffffff"
                    fgColor="#111827"
                    title={t('Scan to open Open Science')}
                  />
                  <div className="mt-1 text-center text-[11px] font-medium text-slate-700">
                    {t('Scan to open')}
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <div className="text-sm text-muted-foreground">
                  {t('The browser link and QR code appear here after setup is complete.')}
                </div>
                <BrowserAccessSteps t={t} />
              </div>
            )}
          </div>
        </SettingsSection>
      ) : null}

      {showTrustedBrowsers ? (
        <SettingsSection
          title={t('Trusted browsers')}
          description={t(
            'Trusted browsers can reconnect until their listed expiration while the same remote address remains available. They remain stored but inactive while remote access is off. Revoking one takes effect on its next request or WebSocket reconnect.'
          )}
        >
          {snapshot.trustedBrowsers.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              {t('No browser is trusted for 180 days.')}
            </div>
          ) : (
            <div className="divide-y divide-border rounded-xl border border-border">
              {snapshot.trustedBrowsers.map((browser) => (
                <div key={browser.id} className="flex items-center gap-3 px-4 py-3">
                  <Laptop className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {browser.browser} · {browser.platform}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t('Last used {{time}}', {
                        time: formatDate(browser.lastSeenAt, 'dateTime')
                      })}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t('Expires {{time}}', {
                        time: formatDate(browser.expiresAt, 'dateTime')
                      })}
                    </div>
                  </div>
                  <SettingsIconAction
                    label={`Revoke ${browser.browser}`}
                    icon={Trash2}
                    danger
                    disabled={busy !== null}
                    onClick={() =>
                      void run(`revoke:${browser.id}`, () =>
                        window.api.remoteAccess.revokeBrowser({ browserId: browser.id })
                      )
                    }
                  />
                </div>
              ))}
            </div>
          )}
        </SettingsSection>
      ) : null}

      {snapshot.canManagePairing && accessUsesPairing ? (
        <SettingsSection
          title={`${t('Pairing requests')}${snapshot.pendingRequests.length ? ` (${snapshot.pendingRequests.length})` : ''}`}
          description={t(
            'Two-step verification uses a six-digit code. Approve a new remote session only when its code matches the request shown here.'
          )}
        >
          {snapshot.pendingRequests.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              {t('No browsers are waiting for approval.')}
            </div>
          ) : (
            <div className="space-y-3">
              {snapshot.pendingRequests.map((request) => (
                <div key={request.id} className="rounded-xl border border-border p-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted">
                      <Laptop className="size-5 text-muted-foreground" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-foreground">
                        {request.browser} · {request.platform}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {t('Requested {{time}}', {
                          time: formatDate(request.requestedAt, 'dateTime')
                        })}
                        {request.address ? ` · ${request.address}` : ''}
                      </div>
                    </div>
                    <div className="rounded-lg bg-muted px-3 py-2 font-mono text-lg font-semibold tracking-[0.18em] text-foreground">
                      {request.code}
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() =>
                        void run(`reject:${request.id}`, () =>
                          window.api.remoteAccess.reject({ requestId: request.id })
                        )
                      }
                    >
                      {t('Reject')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => approve(request.id, 'once')}
                    >
                      {t('Allow for up to 12 hours')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => approve(request.id, 'always')}
                    >
                      {t('Trust this browser for 180 days')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SettingsSection>
      ) : null}

      <p className="mt-5 text-xs leading-relaxed text-muted-foreground">
        {t(
          'Remote.It is a third-party service. Open Science only calls its user-installed desktop CLI and does not include, redistribute, register, or create an account for it.'
        )}
      </p>
    </div>
  )
}

RemoteControlPanel.preload = (): Promise<RemoteAccessSnapshot> => loadRemoteAccessSnapshot()
