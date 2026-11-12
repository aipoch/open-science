import {
  NotebookNetworkAccessEditor,
  type NetworkEditorLeaveState
} from './NotebookNetworkAccessEditor'
export type { NetworkEditorLeaveState } from './NotebookNetworkAccessEditor'
import { InlineNotice } from '@/components/ui/inline-notice'
import { LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  type NotebookNetworkStatus,
  type NotebookNetworkStatusReason
} from '../../../../shared/notebook-network'
import { DownloadProgressLine } from '@/components/DownloadProgressLine'
import { ErrorNotice } from '@/components/error-notice'
import { Notice } from '@/components/notice'
import { formatBytes } from '../../../../shared/update'
import { Button } from '@/components/ui/button'

// Product/runtime names are technical identifiers, shared unchanged across locales.
const RUNTIME_COMPONENT_NAMES = { node: 'Node.js', powershell: 'PowerShell' } as const

const statusReasonLabel = (
  reason: NotebookNetworkStatusReason,
  t: ReturnType<typeof useTranslation>['t']
): string => {
  switch (reason) {
    case 'linuxBubblewrapMissing':
      return t('Install bubblewrap to use Notebook isolation on Linux.')
    case 'macSeatbeltUnavailable':
      return t('The macOS sandbox service is unavailable.')
    case 'trustBundleInvalid':
      return t('The configured CA bundle could not be read or is not a valid PEM bundle.')
    case 'windowsHostMissing':
      return t('The Windows sandbox component is missing. Reinstall Open-Science.')
    case 'windowsGatewayPortUnavailable':
      return t('Network port unavailable. Try turning protection on again.')
    case 'windowsLoopbackMissing':
    case 'windowsNetworkFenceMissing':
    case 'windowsOwnershipMissing':
    case 'windowsProfileMissing':
      return t('Allow administrator access to turn on protection.')
    case 'runtimeFailure':
      return t('Could not check Notebook network protection.')
  }
}

const NotebookNetworkDomainsForm = ({
  onLeaveStateChange
}: {
  onLeaveStateChange?: (state: NetworkEditorLeaveState | null) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [status, setStatus] = useState<NotebookNetworkStatus>({ kind: 'checking' })
  const [isInstalling, setIsInstalling] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)
  const [cancelError, setCancelError] = useState(false)
  const preparing = isInstalling || status.kind === 'checking'
  const busy = preparing || isRemoving
  const preparation = status.kind === 'checking' ? status.runtimePreparation : undefined
  const failure = status.windowsRuntimeSetup?.failure
  const failureDescription = status.windowsRuntimeSetup?.cancelled
    ? t('Cancelled. Downloads are kept. Try again or turn off protection.')
    : failure
      ? failure.phase === 'downloading'
        ? t('Could not download {{component}}. Check your connection and try again.', {
            component: RUNTIME_COMPONENT_NAMES[failure.component]
          })
        : t('Could not prepare {{component}}. Try again or turn off protection.', {
            component: RUNTIME_COMPONENT_NAMES[failure.component]
          })
      : status.kind === 'error'
        ? statusReasonLabel(status.reason, t)
        : ''

  useEffect(() => {
    if (!preparing) return
    let active = true
    const timer = setInterval(() => {
      void window.api.settings.getNotebookNetworkStatus().then(
        (next) => {
          if (active && (!isInstalling || next.kind === 'checking')) setStatus(next)
        },
        () => undefined
      )
    }, 1000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [preparing, isInstalling])

  useEffect(() => {
    void window.api.settings
      .getNotebookNetworkStatus()
      .then(setStatus, () => setStatus({ kind: 'error', reason: 'runtimeFailure' }))
  }, [])

  const refreshStatus = async (): Promise<void> => {
    setStatus({ kind: 'checking' })
    try {
      setStatus(await window.api.settings.getNotebookNetworkStatus())
    } catch {
      setStatus({ kind: 'error', reason: 'runtimeFailure' })
    }
  }

  const installWindowsSandbox = async (): Promise<void> => {
    if (busy) return
    setIsInstalling(true)
    setIsCancelling(false)
    setCancelError(false)
    setStatus({ kind: 'checking', windowsRuntimeSetup: status.windowsRuntimeSetup })
    try {
      setStatus(await window.api.settings.installNotebookNetwork())
    } catch {
      const latest = await window.api.settings.getNotebookNetworkStatus().catch(() => undefined)
      setStatus({
        kind: 'error',
        reason: 'runtimeFailure',
        windowsRuntimeSetup: latest?.windowsRuntimeSetup
      })
    } finally {
      setIsInstalling(false)
      setIsCancelling(false)
    }
  }

  const removeWindowsSandbox = async (): Promise<void> => {
    if (busy) return
    setIsRemoving(true)
    try {
      setStatus(await window.api.settings.removeNotebookNetwork())
    } catch {
      setStatus({ kind: 'error', reason: 'runtimeFailure' })
    } finally {
      setIsRemoving(false)
    }
  }

  const cancelPreparation = async (): Promise<void> => {
    setIsCancelling(true)
    setCancelError(false)
    try {
      if (!(await window.api.settings.cancelNotebookNetworkSetup())) setIsCancelling(false)
    } catch {
      setIsCancelling(false)
      setCancelError(true)
    }
  }

  return (
    <div className="space-y-6 p-5">
      <section
        aria-label={t('Notebook network protection')}
        hidden={status.kind === 'ready' && window.api.platform !== 'win32'}
      >
        <div className="rounded-xl border border-border bg-bg-10 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1 basis-60">
              <p className="text-sm font-medium text-foreground">
                {t('Notebook network protection')}
              </p>
              {preparing ? (
                <div className="mt-2" aria-live="polite">
                  <Notice
                    inline
                    role="status"
                    icon={LoaderCircle}
                    iconClassName="animate-spin motion-reduce:animate-none"
                    title={
                      isCancelling
                        ? t('Cancelling…')
                        : preparation
                          ? preparation.phase === 'verifying'
                            ? t('Verifying {{component}}…', {
                                component: RUNTIME_COMPONENT_NAMES[preparation.component]
                              })
                            : preparation.phase === 'checking'
                              ? t('Checking {{component}}…', {
                                  component: RUNTIME_COMPONENT_NAMES[preparation.component]
                                })
                              : RUNTIME_COMPONENT_NAMES[preparation.component]
                          : isInstalling
                            ? t('Turning on…')
                            : t('Checking…')
                    }
                  />
                  {preparation?.download ? (
                    <DownloadProgressLine progress={preparation.download} />
                  ) : null}
                </div>
              ) : null}
              <p
                className="mt-1 text-xs leading-relaxed text-muted-foreground"
                hidden={preparing || (window.api.platform === 'win32' && status.kind === 'error')}
              >
                {status.kind === 'checking'
                  ? t('Checking…')
                  : status.kind === 'ready'
                    ? window.api.platform === 'win32'
                      ? t('Status: On')
                      : t('Notebook network protection is active.')
                    : status.kind === 'setupRequired'
                      ? status.platform === 'win32'
                        ? t('Status: Off')
                        : t('Notebook network protection needs setup before notebooks can run.')
                      : status.kind === 'unsupported'
                        ? t('Notebook network protection is not supported on this platform.')
                        : window.api.platform === 'win32'
                          ? t('Network protection error')
                          : statusReasonLabel(status.reason, t)}
              </p>
              {window.api.platform === 'win32' && status.kind === 'ready' ? (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t('Existing conversations use the selected mode on their next turn.')}
                </p>
              ) : null}
              {status.kind === 'setupRequired' && status.platform === 'win32' ? (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {t(
                    'Protect Notebook code and package downloads with network rules. When off, Notebook uses standard execution.'
                  )}
                </p>
              ) : null}
              {window.api.platform === 'win32' && status.kind === 'error' ? (
                <ErrorNotice
                  inline
                  className="mt-2"
                  role="alert"
                  title={
                    status.windowsRuntimeSetup?.cancelled
                      ? t('Cancelled')
                      : t('Network protection error')
                  }
                  description={failureDescription}
                />
              ) : null}
              {preparing && isInstalling && !preparation ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('Allow administrator access to turn on protection.')}
                </p>
              ) : null}
              {cancelError ? (
                <ErrorNotice
                  inline
                  className="mt-2"
                  role="alert"
                  description={t('Could not cancel. Try again.')}
                />
              ) : null}
              {window.api.platform === 'win32' &&
              !preparing &&
              status.kind !== 'ready' &&
              Boolean(status.windowsRuntimeSetup?.downloadBytes) ? (
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {t('Downloads up to {{size}}. Downloaded components are reused.', {
                    size: formatBytes(status.windowsRuntimeSetup!.downloadBytes)
                  })}
                </p>
              ) : null}
              {status.kind === 'setupRequired' && status.reasons.length > 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {[...new Set(status.reasons.map((reason) => statusReasonLabel(reason, t)))].join(
                    ' / '
                  )}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {preparing && window.api.platform === 'win32' ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={!status.windowsRuntimeSetup?.canCancel || isCancelling}
                  onClick={() => void cancelPreparation()}
                >
                  {isCancelling ? t('Cancelling…') : t('Cancel')}
                </Button>
              ) : null}
              {!preparing && status.kind === 'setupRequired' && status.platform === 'win32' ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void installWindowsSandbox()}
                >
                  {isInstalling ? t('Turning on…') : t('Turn on')}
                </Button>
              ) : null}
              {!preparing && window.api.platform === 'win32' && status.kind === 'ready' ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void refreshStatus()}
                  >
                    {t('Check again')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void removeWindowsSandbox()}
                  >
                    {isRemoving ? t('Turning off…') : t('Turn off')}
                  </Button>
                </>
              ) : null}
              {!preparing && window.api.platform === 'win32' && status.kind === 'error' ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={isInstalling}
                  onClick={() =>
                    void (status.reason === 'trustBundleInvalid'
                      ? refreshStatus()
                      : installWindowsSandbox())
                  }
                >
                  {status.reason === 'trustBundleInvalid'
                    ? t('Check again')
                    : isInstalling
                      ? t('Turning on…')
                      : t('Try again')}
                </Button>
              ) : null}
              {!preparing && window.api.platform === 'win32' && status.kind === 'error' ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void removeWindowsSandbox()}
                >
                  {isRemoving ? t('Turning off…') : t('Turn off')}
                </Button>
              ) : null}
            </div>
          </div>
          {window.api.platform === 'win32' &&
          (status.kind === 'ready' ||
            (status.kind === 'setupRequired' && status.platform === 'win32')) ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {t('Turning protection on or off requires administrator permission.')}
            </p>
          ) : null}
        </div>
      </section>

      {status.kind !== 'checking' && status.kind !== 'ready' ? (
        <InlineNotice level="warning">
          {t('Protection is not active. These rules apply only to protected execution.')}
        </InlineNotice>
      ) : null}
      <NotebookNetworkAccessEditor onLeaveStateChange={onLeaveStateChange} />
    </div>
  )
}

export { NotebookNetworkDomainsForm }
