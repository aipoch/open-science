import { EthernetPort, Network, RefreshCw, Wifi, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { PackageMirror } from '../../../../shared/mirror'
import type { NetworkConnectionType, NetworkInfo } from '../../../../shared/network'
import type { EnvironmentCheckItem } from '../../../../shared/settings'
import { EnvironmentCheckRow, PendingCheckRow } from '@/components/environment-check-row'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useNetworkStore } from '@/stores/network-store'
import { useSettingsStore } from '@/stores/settings-store'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { isMirrorConfigured, mirrorStatusText, MIRROR_HELP_URL } from './mirror-view'
import { NetworkProxyForm } from './NetworkProxyForm'
import { NotebookNetworkDomainsForm } from './NotebookNetworkDomainsForm'

const fieldLabelClassName = 'text-xs font-medium text-muted-foreground'
const actionButtonClassName =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50'

// Package-mirror list vs. configure form. The configure form is a settings-nav sub-view (not local
// state) so the shared header shows a "Network / Package mirror" breadcrumb with back/forward.
type NetworkView = { kind: 'list' | 'mirror' | 'proxy' | 'domains' }
type NetworkPanelProps = {
  view: NetworkView
  onNavigate: (view: NetworkView) => void
  notebookNetworkAvailable?: boolean
}

// Identity of the single check row this panel renders (and its pending placeholder). Only the id
// lives here: the label travels to the row as *data* rather than as JSX, so holding it as a bare
// English constant would put it on screen untranslated. It is built with t() below instead.
const NETWORK_CHECK_ID = 'install-network' as const satisfies EnvironmentCheckItem['id']

// Display labels for the main-process connection types; 'unknown' has no label and drops out. These
// are English source text, translated where they are read — a runtime connection type can't be
// interpolated into a natural-language key.
const CONNECTION_TYPE_LABELS: Partial<Record<NetworkConnectionType, string>> = {
  wifi: 'Wi-Fi',
  ethernet: 'Ethernet'
}

// Settings -> Network. The Network status section presents the network store's connectivity
// (navigator.onLine link signal plus the store's shared end-to-end reachability probe) and the
// local interface details reported by the main process; the Package mirror section lets a user
// behind a firewall or on a slow route to the public conda-forge / pip hosts point package
// fetches at a mirror instead. Notebook domains configures the application-owned egress policy used
// by local Notebook and command-line processes.
const NetworkPanel = ({
  view,
  onNavigate,
  notebookNetworkAvailable = true
}: NetworkPanelProps): React.JSX.Element => {
  const { t } = useTranslation()
  const packageMirror = useSettingsStore((state) => state.packageMirror)
  const networkProxy = useSettingsStore((state) => state.networkProxy)
  const notebookNetwork = useSettingsStore((state) => state.notebookNetwork)
  const setPackageMirror = useSettingsStore((state) => state.setPackageMirror)
  const isOnline = useNetworkStore((state) => state.isOnline)
  // End-to-end reachability is owned by the network store (probed on startup, recovery,
  // returning to the window while a previous probe is still failing, and Retry), so this
  // panel and the header/sidebar indicators never disagree. 'unknown' renders as Checking…;
  // 'probe-failed' remains retryable.
  const connectivity = useNetworkStore((state) => state.connectivity)
  const probeConnectivity = useNetworkStore((state) => state.probeConnectivity)

  const isConfiguring = view.kind === 'mirror'
  const [draft, setDraft] = useState<PackageMirror>({})
  const [isSaving, setIsSaving] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null)
  const [networkInfoError, setNetworkInfoError] = useState(false)
  const networkInfoRequestRef = useRef(0)

  // Local interface details come from the main process; window.api.network is Electron-only,
  // so stay with placeholders when the preload bridge is unavailable. A rejected IPC call is
  // an explicit load failure, not "no interface". Overlapping refreshes (list remount, Retry)
  // keep only the latest response so a stale rejection cannot wipe a newer success.
  const refreshNetworkInfo = useCallback((): void => {
    const getInfo = window.api?.network?.getInfo
    if (!getInfo) return
    const request = ++networkInfoRequestRef.current

    void getInfo().then(
      (info) => {
        if (request !== networkInfoRequestRef.current) return
        setNetworkInfo(info)
        setNetworkInfoError(false)
      },
      () => {
        if (request !== networkInfoRequestRef.current) return
        setNetworkInfo(null)
        setNetworkInfoError(true)
      }
    )
  }, [])

  // Pull local interface details when the list view mounts while online, and re-pull whenever
  // connectivity comes back; offline rows show placeholders, so a drop has nothing to refresh.
  useEffect(() => {
    if (view.kind === 'list' && isOnline) refreshNetworkInfo()
  }, [view.kind, isOnline, refreshNetworkInfo])

  const recheckOnline = useNetworkStore((state) => state.recheckOnline)

  const handleRetry = (): void => {
    recheckOnline()
    refreshNetworkInfo()
    // Announced even while offline: the store short-circuits a link-down probe to
    // 'unreachable', but still holds the Checking… state for its minimum delay first.
    void probeConnectivity({ announce: true })
  }

  // Seed the draft from the saved mirror once each time the configure view is entered (including via
  // history / a remount), without clobbering in-progress edits on a background store refresh.
  const seededRef = useRef(false)
  useEffect(() => {
    if (view.kind === 'mirror') {
      if (!seededRef.current) {
        setDraft(packageMirror ?? {})
        setMessage(undefined)
        seededRef.current = true
      }
    } else {
      seededRef.current = false
    }
  }, [view.kind, packageMirror])

  const handleConfigure = (): void => onNavigate({ kind: 'mirror' })

  const handleCancel = (): void => {
    setMessage(undefined)
    onNavigate({ kind: 'list' })
  }

  const handleSave = async (): Promise<void> => {
    if (
      packageMirror?.caBundle !== draft.caBundle &&
      window.confirm(t('Changing the CA bundle will stop active Notebook kernels. Continue?')) ===
        false
    )
      return
    setIsSaving(true)
    setMessage(undefined)

    try {
      await setPackageMirror(draft)
      onNavigate({ kind: 'list' })
    } catch {
      setMessage('Could not save the package mirror.')
    } finally {
      setIsSaving(false)
    }
  }

  // Connection type + IP fold into the check row's detail line, e.g. "Wi-Fi · 192.168.1.42".
  const typeSource = networkInfo ? CONNECTION_TYPE_LABELS[networkInfo.connectionType] : undefined
  const typeLabel = typeSource ? t(typeSource) : undefined
  const interfaceDetail = networkInfoError
    ? t('Could not load local network details.')
    : [typeLabel ?? null, networkInfo?.ipAddress ?? null]
        .filter((part) => part !== null)
        .join(' · ') || undefined

  const networkLabel = t('Internet connection')

  // The Network status row is an EnvironmentCheckItem so it renders with the exact same row
  // component as the onboarding environment step's network check. A live link with unreachable
  // package registries is amber (warning) rather than red — the machine is connected, the
  // path to npmjs / npmmirror is not.
  const networkCheck: EnvironmentCheckItem = !isOnline
    ? {
        id: NETWORK_CHECK_ID,
        label: networkLabel,
        status: 'failed',
        summary: t('This machine is offline.')
      }
    : connectivity === 'unreachable'
      ? {
          id: NETWORK_CHECK_ID,
          label: networkLabel,
          status: 'warning',
          summary: t('The network link is up, but package registries are unreachable.'),
          detail: interfaceDetail
        }
      : connectivity === 'probe-failed'
        ? {
            id: NETWORK_CHECK_ID,
            label: networkLabel,
            status: 'warning',
            summary: t('Could not check whether package registries are reachable.'),
            detail: interfaceDetail
          }
        : {
            id: NETWORK_CHECK_ID,
            label: networkLabel,
            status: 'passed',
            summary: t('Package registries are reachable.'),
            detail: interfaceDetail
          }

  // 'unknown' only ever means a probe is in flight (offline settles on 'unreachable'), so it
  // always renders as Checking… — including an offline Retry.
  const isChecking = connectivity === 'unknown'

  // Tile icon follows the actual link; unknown/unclassified interfaces stay visually neutral.
  const networkIcon = !isOnline
    ? WifiOff
    : networkInfo?.connectionType === 'ethernet'
      ? EthernetPort
      : networkInfo?.connectionType === 'wifi'
        ? Wifi
        : Network

  if (view.kind === 'proxy') return <NetworkProxyForm onDone={() => onNavigate({ kind: 'list' })} />
  if (view.kind === 'domains' && notebookNetworkAvailable) return <NotebookNetworkDomainsForm />

  return (
    <div className="space-y-6 p-5">
      {!isConfiguring ? (
        <section aria-label={t('Network status')}>
          <h3 className="mb-1 text-sm font-semibold text-foreground">{t('Network status')}</h3>
          <p className="mb-3 text-xs text-muted-foreground">
            {t('Whether this machine can currently reach the package registries.')}
          </p>

          <div className="rounded-xl border border-border px-4">
            <ul aria-live="polite">
              {isChecking ? (
                <PendingCheckRow
                  id={NETWORK_CHECK_ID}
                  label={networkLabel}
                  pendingText={t('Checking…')}
                />
              ) : (
                <EnvironmentCheckRow check={networkCheck} icon={networkIcon} />
              )}
            </ul>

            {!isOnline || connectivity === 'unreachable' || connectivity === 'probe-failed' ? (
              <div className="mb-4 rounded-lg bg-bg-10 px-4 py-4 ring-1 ring-border-200">
                <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">
                  {!isOnline ? <li>{t('Check your cable or Wi-Fi connection.')}</li> : null}
                  <li>{t('Check proxy, VPN, or firewall settings.')}</li>
                  <li>{t('Check the package mirror configuration below.')}</li>
                </ol>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={handleRetry}
                  disabled={isChecking}
                >
                  <RefreshCw className={cn(isChecking && 'animate-spin')} aria-hidden="true" />
                  {isChecking ? t('Checking…') : t('Check again')}
                </Button>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {!isConfiguring && notebookNetworkAvailable ? (
        <section aria-label={t('Notebook network access')}>
          <h3 className="mb-1 text-sm font-semibold text-foreground">
            {t('Notebook network access')}
          </h3>
          <p className="mb-3 text-xs text-muted-foreground">
            {t('Control which internet domains Notebook Python, R, REPL, and Bash can reach.')}
          </p>
          <div className="rounded-xl border border-border p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-foreground">{t('Open Science domains')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('{{count}} custom domains allowed', {
                    count: notebookNetwork.allowedDomains.length,
                    defaultValue_one: '{{count}} custom domain allowed'
                  })}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate({ kind: 'domains' })}
                className={actionButtonClassName}
              >
                {t('Configure domains')}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {!isConfiguring ? (
        <section aria-label={t('Proxy')}>
          <h3 className="mb-1 text-sm font-semibold text-foreground">{t('Proxy')}</h3>
          <p className="mb-3 text-xs text-muted-foreground">
            {t(
              'How Open Science, ACP agents, notebook runtimes, and installers reach the internet.'
            )}
          </p>
          <div className="rounded-xl border border-border p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-foreground">
                  {t(
                    networkProxy.mode === 'system'
                      ? 'System'
                      : networkProxy.mode === 'manual'
                        ? 'Manual'
                        : 'Direct'
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {networkProxy.mode === 'manual'
                    ? networkProxy.server
                    : networkProxy.mode === 'system'
                      ? t('Follows this device')
                      : t('Connects without a proxy')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onNavigate({ kind: 'proxy' })}
                className={actionButtonClassName}
              >
                {t('Configure proxy')}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <section aria-label={t('Package mirror')}>
        <h3 className="mb-1 text-sm font-semibold text-foreground">{t('Package mirror')}</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          {t(
            'Where the notebook environment fetches conda and Python packages from when installing or updating.'
          )}
        </p>

        <div className="rounded-xl border border-border p-4">
          {!isConfiguring ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-foreground">{mirrorStatusText(packageMirror, t)}</span>
              <button type="button" onClick={handleConfigure} className={actionButtonClassName}>
                {isMirrorConfigured(packageMirror) ? t('Edit') : t('Configure')}
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="space-y-1.5">
                <label className={fieldLabelClassName} htmlFor="mirror-conda-channel">
                  {t('Conda channel mirror')}
                </label>
                <Input
                  id="mirror-conda-channel"
                  aria-label={t('Conda channel mirror')}
                  value={draft.condaChannel ?? ''}
                  placeholder={t('https://mirrors.example.com/conda-forge/')}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, condaChannel: event.target.value }))
                  }
                />
              </div>

              <div className="space-y-1.5">
                <label className={fieldLabelClassName} htmlFor="mirror-pypi-index">
                  {t('Python package index (pip)')}
                </label>
                <Input
                  id="mirror-pypi-index"
                  aria-label={t('Python package index (pip)')}
                  value={draft.pypiIndex ?? ''}
                  placeholder={t('https://mirrors.example.com/pypi/simple')}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, pypiIndex: event.target.value }))
                  }
                />
              </div>

              <div className="space-y-1.5">
                <label className={fieldLabelClassName} htmlFor="mirror-ca-bundle">
                  {t('CA bundle path')}{' '}
                  <span className="text-muted-foreground">{t('(optional)')}</span>
                </label>
                <Input
                  id="mirror-ca-bundle"
                  aria-label={t('CA bundle path')}
                  value={draft.caBundle ?? ''}
                  placeholder={t('/path/to/corp-ca-bundle.pem')}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, caBundle: event.target.value }))
                  }
                />
                <p className="text-[11px] text-muted-foreground">
                  {t(
                    'Leave blank to use public certificate authorities. Otherwise, choose a complete PEM bundle with public and corporate roots; Notebook sessions and package downloads will trust it.'
                  )}
                </p>
              </div>

              {message ? (
                <p className="text-xs text-destructive" role="alert">
                  {t('Could not save the package mirror.')}
                </p>
              ) : null}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={isSaving}
                  className="rounded-lg border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted disabled:opacity-50"
                >
                  {t('Cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={isSaving}
                  className="rounded-lg border border-primary bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {isSaving ? t('Saving…') : t('Save')}
                </button>
              </div>
            </div>
          )}
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          <ExternalTextLink href={MIRROR_HELP_URL}>{t('View available mirrors')}</ExternalTextLink>
        </p>
      </section>
    </div>
  )
}

export { NetworkPanel }
