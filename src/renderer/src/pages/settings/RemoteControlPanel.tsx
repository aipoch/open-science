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

import type {
  RemoteAccessMode,
  RemoteAccessSnapshot,
  RemotePairingDecision
} from '../../../../shared/remote-access'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  dialogDescriptionClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { cn } from '@/lib/utils'
import { SettingsSection } from './SettingsLayout'

const REMOTE_IT_DOWNLOAD_URL = 'https://www.remote.it/download/'

const lifecycleLabel = (snapshot: RemoteAccessSnapshot): string => {
  if (snapshot.lifecycle === 'starting') return 'Starting…'
  if (snapshot.lifecycle === 'stopping') return 'Stopping…'
  if (snapshot.mode === 'off') return 'Remote access is off'
  if (snapshot.lifecycle === 'running' && snapshot.mode === 'remoteit') return 'App access is on'
  if (snapshot.lifecycle === 'running' && snapshot.mode === 'remoteit-public') {
    return 'Browser access is on'
  }
  if (snapshot.lifecycle === 'error') return 'Needs attention'
  return 'Remote access is off'
}

const ACCESS_MODES: {
  mode: RemoteAccessMode
  title: string
  description: string
  icon: typeof CircleOff
}[] = [
  {
    mode: 'off',
    title: 'Off',
    description: 'Only this computer can open the workspace.',
    icon: CircleOff
  },
  {
    mode: 'remoteit',
    title: 'App access',
    description: 'Open Open Science from the signed-in mobile app with two-step verification.',
    icon: RadioTower
  },
  {
    mode: 'remoteit-public',
    title: 'Browser access',
    description: 'Open a persistent link in any browser with two-step verification.',
    icon: Globe2
  }
]

const timeLabel = (timestamp: number): string =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(timestamp)

const providerStatus = (snapshot: RemoteAccessSnapshot): string => {
  if (!snapshot.remoteIt.installed) return 'Not installed'
  if (!snapshot.remoteIt.registered) return 'Device setup required'
  if (!snapshot.remoteIt.loggedIn) return 'Sign-in required'
  if (snapshot.enabled && snapshot.lifecycle === 'running') return 'Connected'
  return 'Ready'
}

const loadRemoteAccessSnapshot = async (
  onInitial: (snapshot: RemoteAccessSnapshot) => void = () => undefined,
  isActive: () => boolean = () => true
): Promise<RemoteAccessSnapshot> => {
  const initial = await window.api.remoteAccess.getSnapshot()
  if (!isActive()) return initial
  onInitial(initial)
  return initial.canManage ? window.api.remoteAccess.detect() : initial
}

const BrowserAccessSteps = (): React.JSX.Element => (
  <div className="mt-4 flex items-start gap-3 border-t border-blue-600/15 pt-4">
    <Smartphone className="mt-0.5 size-5 shrink-0 text-blue-600" aria-hidden="true" />
    <ol className="min-w-0 space-y-2 text-sm leading-relaxed text-foreground">
      <li>
        <span className="font-medium">1.</span> Scan the QR code or open the saved link in a
        browser.
      </li>
      <li>
        <span className="font-medium">2.</span> Complete two-step verification by matching the
        six-digit code, then approve the request from this computer or a trusted browser.
      </li>
      <li>
        <span className="font-medium">3.</span> Choose “Always trust this browser” for direct access
        on future visits while Browser access is on.
      </li>
    </ol>
  </div>
)

export const RemoteControlPanel = (): React.JSX.Element => {
  const [snapshot, setSnapshot] = useState<RemoteAccessSnapshot | null>(null)
  const [busy, setBusy] = useState<string | null>('loading')
  const [actionError, setActionError] = useState<string | undefined>()
  const [copied, setCopied] = useState(false)

  const operationTriggerRef = useRef<HTMLElement | null>(null)
  const initialLoadRetryRef = useRef(false)
  const mountedRef = useRef(false)
  const refresh = async (detect = false, completesBusyOperation = true): Promise<void> => {
    try {
      const next = detect
        ? await window.api.remoteAccess.detect()
        : await window.api.remoteAccess.getSnapshot()
      setSnapshot(next)
      setActionError(undefined)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      if (completesBusyOperation) setBusy(null)
    }
  }

  useEffect(() => {
    let active = true
    mountedRef.current = true
    void loadRemoteAccessSnapshot(
      (initial) => {
        if (active) setSnapshot(initial)
      },
      () => active
    )
      .then((next) => {
        if (!active) return
        setSnapshot(next)
      })
      .catch((error: unknown) => {
        if (active) setActionError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (active) setBusy(null)
      })
    const unsubscribe = window.api.remoteAccess.onChanged(() => {
      // Lifecycle broadcasts are progress updates for an in-flight action. They must not clear
      // `busy`; only the Promise that started the mode change or Detect operation may do that.
      if (active) void refresh(false, false)
    })
    return () => {
      active = false
      mountedRef.current = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (busy !== null || !operationTriggerRef.current) return
    operationTriggerRef.current.focus()
    operationTriggerRef.current = null
  }, [busy])

  const run = async (name: string, action: () => Promise<RemoteAccessSnapshot>): Promise<void> => {
    setBusy(name)
    setActionError(undefined)
    try {
      const next = await action()
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
    void run('loading', () =>
      loadRemoteAccessSnapshot(setSnapshot, () => mountedRef.current)
    ).finally(() => {
      initialLoadRetryRef.current = false
    })
  }

  const approve = (requestId: string, decision: RemotePairingDecision): void => {
    void run(`approve:${requestId}`, () => window.api.remoteAccess.approve({ requestId, decision }))
  }

  const copyUrl = async (): Promise<void> => {
    if (!snapshot?.accessUrl) return
    await navigator.clipboard.writeText(snapshot.accessUrl)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_500)
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
              <div className="font-medium">Remote access couldn&apos;t be loaded.</div>
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
                Try again
              </Button>
            </div>
          </div>
        </div>
      )
    }
    return (
      <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
        <LoaderCircle className="mr-2 size-4 animate-spin" aria-hidden="true" />
        Loading remote access…
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
  const statusLabel = providerStatus(snapshot)
  const statusClassName =
    statusLabel === 'Connected' ? 'border-0 bg-primary/10 text-primary' : undefined

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
      Detect again
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
                  ? 'Checking and setting up remote access…'
                  : 'Applying remote access settings…'}
              </Dialog.Title>
              <Dialog.Description className={cn(dialogDescriptionClassName, 'mt-1 text-xs')}>
                Waiting for the system command to finish.
              </Dialog.Description>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <SettingsSection
        className="relative"
        contentClassName="space-y-3"
        title="Remote browser access"
        description={
          <>
            Choose who can reach this computer&apos;s Open Science workspace. All projects, agents,
            files, and notebook runtimes continue to run on this computer. Install and sign in to
            the Remote.It desktop app before enabling access.{' '}
            <ExternalTextLink
              href={REMOTE_IT_DOWNLOAD_URL}
              className="box-decoration-clone rounded-sm bg-primary/10 px-1 py-0.5 font-medium text-primary underline decoration-primary/50 underline-offset-2 transition-colors hover:bg-primary/15 hover:decoration-primary"
            >
              Download Remote.It App
            </ExternalTextLink>
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
              ? 'Changing access mode…'
              : detectingAndRepairing
                ? 'Checking access…'
                : lifecycleLabel(snapshot)}
          </Badge>
        }
      >
        <div
          className="grid grid-cols-1 gap-2 sm:grid-cols-3"
          role="radiogroup"
          aria-label="Remote access mode"
        >
          {ACCESS_MODES.map((option) => {
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
                    {option.title}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {option.description}
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
            {modeError}
          </div>
        ) : null}

        {!snapshot.canManage ? (
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            {snapshot.canManagePairing && accessUsesPairing
              ? 'Remote access settings can only be changed from the Open Science desktop window on the home computer. Two-step verification requests and trusted browsers can be managed below.'
              : 'Remote access settings can only be changed from the Open Science desktop window on the home computer.'}
          </div>
        ) : null}
      </SettingsSection>

      {accessIsApp ? (
        <SettingsSection
          contentClassName="space-y-3"
          title="Remote App Access"
          action={
            <Badge variant="outline" className={statusClassName}>
              {statusLabel}
            </Badge>
          }
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <p className="max-w-2xl text-[13px] leading-5 text-muted-foreground">
              Open this computer from the signed-in mobile app. Open Science creates and maintains
              the local service automatically after this computer is added once.
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
                  <span className="font-medium">1.</span> Open the mobile app and sign in to the
                  same account as this computer.
                </li>
                <li>
                  <span className="font-medium">2.</span> Select this computer, then select{' '}
                  <span className="font-medium">Open Science Remote</span>.
                </li>
                <li>
                  <span className="font-medium">3.</span> Tap Connect or Launch, match the six-digit
                  code, then approve the request from this computer or an already trusted browser.
                </li>
                <li>
                  <span className="font-medium">4.</span> Choose “Always trust this browser” to skip
                  approval on future visits to the same remote address.
                </li>
              </ol>
            </div>
          </div>
        </SettingsSection>
      ) : null}

      {accessIsBrowser ? (
        <SettingsSection
          contentClassName="space-y-3"
          title="Remote Browser Access"
          action={
            <Badge variant="outline" className={statusClassName}>
              {statusLabel}
            </Badge>
          }
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <p className="max-w-2xl text-[13px] leading-5 text-muted-foreground">
              Open a persistent HTTPS address from any modern browser. Open Science creates and
              maintains the public browser service automatically.
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
                          Browser link is ready
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void copyUrl()}
                          >
                            <Copy className="size-3.5" aria-hidden="true" />
                            {copied ? 'Copied' : 'Copy'}
                          </Button>
                          <Button type="button" variant="outline" size="sm" asChild>
                            <a href={snapshot.accessUrl} target="_blank" rel="noreferrer">
                              <ExternalLink className="size-3.5" aria-hidden="true" />
                              Open
                            </a>
                          </Button>
                        </div>
                      </div>
                      <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
                        {snapshot.accessUrl}
                      </div>
                    </div>
                  </div>
                  <BrowserAccessSteps />
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
                    title="Scan to open Open Science"
                  />
                  <div className="mt-1 text-center text-[11px] font-medium text-slate-700">
                    Scan to open
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <div className="text-sm text-muted-foreground">
                  The browser link and QR code appear here after setup is complete.
                </div>
                <BrowserAccessSteps />
              </div>
            )}
          </div>
        </SettingsSection>
      ) : null}

      {snapshot.canManagePairing && accessUsesPairing ? (
        <SettingsSection
          title="Trusted browsers"
          description="Always-trusted browsers can reconnect while the same remote address remains available. Revoking one takes effect on its next request or WebSocket reconnect."
        >
          {snapshot.trustedBrowsers.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              No browser has permanent access.
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
                      Last used {timeLabel(browser.lastSeenAt)}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(`revoke:${browser.id}`, () =>
                        window.api.remoteAccess.revokeBrowser({ browserId: browser.id })
                      )
                    }
                    aria-label={`Revoke ${browser.browser}`}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </SettingsSection>
      ) : null}

      {snapshot.canManagePairing && accessUsesPairing ? (
        <SettingsSection
          title={`Pairing requests${snapshot.pendingRequests.length ? ` (${snapshot.pendingRequests.length})` : ''}`}
          description="Two-step verification uses a six-digit code. Approve a new remote session only when its code matches the request shown here."
        >
          {snapshot.pendingRequests.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              No browsers are waiting for approval.
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
                        Requested {timeLabel(request.requestedAt)}
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
                      Reject
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => approve(request.id, 'once')}
                    >
                      Allow once
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => approve(request.id, 'always')}
                    >
                      Always trust this browser
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SettingsSection>
      ) : null}

      <p className="mt-5 text-xs leading-relaxed text-muted-foreground">
        Remote.It is a third-party service. Open Science only calls its user-installed desktop CLI
        and does not include, redistribute, register, or create an account for it.
      </p>
    </div>
  )
}
