import { EthernetPort, RefreshCw, Wifi, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

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

const fieldLabelClassName = 'text-xs font-medium text-muted-foreground'
const actionButtonClassName =
  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50'

// Package-mirror list vs. configure form. The configure form is a settings-nav sub-view (not local
// state) so the shared header shows a "Network / Package mirror" breadcrumb with back/forward.
type NetworkView = { kind: 'list' | 'configure' }
type NetworkPanelProps = { view: NetworkView; onNavigate: (view: NetworkView) => void }

// Shared identity of the single check row this panel renders (and its pending placeholder).
const NETWORK_CHECK_BASE = {
  id: 'install-network',
  label: 'Internet connection'
} as const satisfies Pick<EnvironmentCheckItem, 'id' | 'label'>

// Display labels for the main-process connection types; 'unknown' has no label and drops out.
const CONNECTION_TYPE_LABELS: Partial<Record<NetworkConnectionType, string>> = {
  wifi: 'Wi-Fi',
  ethernet: 'Ethernet'
}

// Settings -> Network. The Network status section presents the network store's connectivity
// (navigator.onLine link signal plus the store's shared end-to-end reachability probe) and the
// local interface details reported by the main process; the Package mirror section lets a user
// behind a firewall or on a slow route to the public conda-forge / pip hosts point package
// fetches at a mirror instead. The "Claude Science domains" egress allowlist from the mockup is
// phase-3 (spec §14, §9) and is intentionally not built here.
const NetworkPanel = ({ view, onNavigate }: NetworkPanelProps): React.JSX.Element => {
  const packageMirror = useSettingsStore((state) => state.packageMirror)
  const setPackageMirror = useSettingsStore((state) => state.setPackageMirror)
  const isOnline = useNetworkStore((state) => state.isOnline)
  // End-to-end reachability is owned by the network store (probed on startup, recovery, a
  // background cadence, and Retry), so this panel and the header/sidebar indicators never
  // disagree. 'unknown' renders as Checking….
  const connectivity = useNetworkStore((state) => state.connectivity)
  const probeConnectivity = useNetworkStore((state) => state.probeConnectivity)

  const isConfiguring = view.kind === 'configure'
  const [draft, setDraft] = useState<PackageMirror>({})
  const [isSaving, setIsSaving] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null)

  // Local interface details come from the main process; window.api.network is Electron-only,
  // so stay with placeholders when the preload bridge is unavailable.
  const refreshNetworkInfo = useCallback((): void => {
    const getInfo = window.api?.network?.getInfo
    if (!getInfo) return

    void getInfo().then((info) => setNetworkInfo(info))
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
    if (view.kind === 'configure') {
      if (!seededRef.current) {
        setDraft(packageMirror ?? {})
        setMessage(undefined)
        seededRef.current = true
      }
    } else {
      seededRef.current = false
    }
  }, [view.kind, packageMirror])

  const handleConfigure = (): void => onNavigate({ kind: 'configure' })

  const handleCancel = (): void => {
    setMessage(undefined)
    onNavigate({ kind: 'list' })
  }

  const handleSave = async (): Promise<void> => {
    setIsSaving(true)
    setMessage(undefined)

    try {
      await setPackageMirror(draft)
      onNavigate({ kind: 'list' })
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save the package mirror.')
    } finally {
      setIsSaving(false)
    }
  }

  // Connection type + IP fold into the check row's detail line, e.g. "Wi-Fi · 192.168.1.42".
  const typeLabel = networkInfo ? CONNECTION_TYPE_LABELS[networkInfo.connectionType] : undefined
  const interfaceDetail =
    [typeLabel ?? null, networkInfo?.ipAddress ?? null]
      .filter((part) => part !== null)
      .join(' · ') || undefined

  // The Network status row is an EnvironmentCheckItem so it renders with the exact same row
  // component as the onboarding environment step's network check. A live link with unreachable
  // internet is amber (warning) rather than red — the machine is connected, the path out is not.
  const networkCheck: EnvironmentCheckItem = !isOnline
    ? {
        ...NETWORK_CHECK_BASE,
        status: 'failed',
        summary: 'This machine is offline.'
      }
    : connectivity === 'unreachable'
      ? {
          ...NETWORK_CHECK_BASE,
          status: 'warning',
          summary: 'The network link is up, but the internet is unreachable.',
          detail: interfaceDetail
        }
      : {
          ...NETWORK_CHECK_BASE,
          status: 'passed',
          summary: 'The internet is reachable.',
          detail: interfaceDetail
        }

  // 'unknown' only ever means a probe is in flight (offline settles on 'unreachable'), so it
  // always renders as Checking… — including an offline Retry.
  const isChecking = connectivity === 'unknown'

  // Tile icon follows the actual link: WifiOff while offline, then by connection type.
  const networkIcon = !isOnline
    ? WifiOff
    : networkInfo?.connectionType === 'ethernet'
      ? EthernetPort
      : Wifi

  return (
    <div className="space-y-6 p-5">
      {!isConfiguring ? (
        <section aria-label="Network status">
          <h3 className="mb-1 text-sm font-semibold text-foreground">Network status</h3>
          <p className="mb-3 text-xs text-muted-foreground">
            Whether this machine can currently reach the internet.
          </p>

          <div className="rounded-xl border border-border px-4">
            <ul aria-live="polite">
              {isChecking ? (
                <PendingCheckRow {...NETWORK_CHECK_BASE} pendingText="Checking…" />
              ) : (
                <EnvironmentCheckRow check={networkCheck} icon={networkIcon} />
              )}
            </ul>

            {!isOnline || connectivity === 'unreachable' ? (
              <div className="mb-4 rounded-lg bg-bg-10 px-4 py-4 ring-1 ring-border-200">
                <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed text-muted-foreground">
                  {!isOnline ? <li>Check your cable or Wi-Fi connection.</li> : null}
                  <li>Check proxy, VPN, or firewall settings.</li>
                  <li>Check the package mirror configuration below.</li>
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
                  {isChecking ? 'Checking…' : 'Check again'}
                </Button>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      <section aria-label="Package mirror">
        <h3 className="mb-1 text-sm font-semibold text-foreground">Package mirror</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          Where the notebook environment fetches conda and Python packages from when installing or
          updating.
        </p>

        <div className="rounded-xl border border-border p-4">
          {!isConfiguring ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-foreground">{mirrorStatusText(packageMirror)}</span>
              <button type="button" onClick={handleConfigure} className={actionButtonClassName}>
                {isMirrorConfigured(packageMirror) ? 'Edit' : 'Configure'}
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="space-y-1.5">
                <label className={fieldLabelClassName} htmlFor="mirror-conda-channel">
                  Conda channel mirror
                </label>
                <Input
                  id="mirror-conda-channel"
                  aria-label="Conda channel mirror"
                  value={draft.condaChannel ?? ''}
                  placeholder="https://mirrors.example.com/conda-forge/"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, condaChannel: event.target.value }))
                  }
                />
              </div>

              <div className="space-y-1.5">
                <label className={fieldLabelClassName} htmlFor="mirror-pypi-index">
                  Python package index (pip)
                </label>
                <Input
                  id="mirror-pypi-index"
                  aria-label="Python package index (pip)"
                  value={draft.pypiIndex ?? ''}
                  placeholder="https://mirrors.example.com/pypi/simple"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, pypiIndex: event.target.value }))
                  }
                />
              </div>

              <div className="space-y-1.5">
                <label className={fieldLabelClassName} htmlFor="mirror-ca-bundle">
                  CA bundle path <span className="text-muted-foreground">(optional)</span>
                </label>
                <Input
                  id="mirror-ca-bundle"
                  aria-label="CA bundle path"
                  value={draft.caBundle ?? ''}
                  placeholder="/path/to/corp-ca-bundle.pem"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, caBundle: event.target.value }))
                  }
                />
                <p className="text-[11px] text-muted-foreground">
                  PEM bundle for a corporate TLS proxy; trusted by conda, pip, and R downloads.
                </p>
              </div>

              {message ? (
                <p className="text-xs text-destructive" role="alert">
                  {message}
                </p>
              ) : null}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={isSaving}
                  className="rounded-lg border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={isSaving}
                  className="rounded-lg border border-primary bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {isSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          )}
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          <ExternalTextLink href={MIRROR_HELP_URL}>View available mirrors</ExternalTextLink>
        </p>
      </section>
    </div>
  )
}

export { NetworkPanel }
