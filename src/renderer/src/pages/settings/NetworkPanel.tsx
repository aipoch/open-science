import { CircleAlert, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { PackageMirror } from '../../../../shared/mirror'
import type { NetworkInfo } from '../../../../shared/network'
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

// Settings -> Network. The Network status section shows connectivity (navigator.onLine) plus the
// local interface details reported by the main process; the Package mirror section lets a user
// behind a firewall or on a slow route to the public conda-forge / pip hosts point package fetches
// at a mirror instead. The "Claude Science domains" egress allowlist from the mockup is phase-3
// (spec §14, §9) and is intentionally not built here.
const NetworkPanel = ({ view, onNavigate }: NetworkPanelProps): React.JSX.Element => {
  const packageMirror = useSettingsStore((state) => state.packageMirror)
  const setPackageMirror = useSettingsStore((state) => state.setPackageMirror)
  const isOnline = useNetworkStore((state) => state.isOnline)

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

  // Load once when the list view mounts while online, and re-pull whenever connectivity comes
  // back; offline rows show placeholders, so a connectivity drop has nothing to refresh.
  useEffect(() => {
    if (view.kind === 'list' && isOnline) refreshNetworkInfo()
  }, [view.kind, isOnline, refreshNetworkInfo])

  const recheckOnline = useNetworkStore((state) => state.recheckOnline)

  const handleRetry = (): void => {
    recheckOnline()
    refreshNetworkInfo()
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

  const connectionLabel =
    networkInfo?.connectionType === 'wifi'
      ? 'Wi-Fi'
      : networkInfo?.connectionType === 'ethernet'
        ? 'Ethernet'
        : '—'

  return (
    <div className="space-y-6 p-5">
      {!isConfiguring ? (
        <section aria-label="Network status">
          <h3 className="mb-1 text-sm font-semibold text-foreground">Network status</h3>
          <p className="mb-3 text-xs text-muted-foreground">
            Whether this machine is currently connected to the internet.
          </p>

          <div className="rounded-xl border border-border p-4">
            <dl className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className={fieldLabelClassName}>Status</dt>
                <dd className="flex items-center gap-1.5 text-foreground">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'size-2 rounded-full',
                      isOnline ? 'bg-success-000' : 'bg-destructive'
                    )}
                  />
                  {isOnline ? 'Connected' : 'Offline'}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className={fieldLabelClassName}>Connection</dt>
                <dd className="text-foreground">{isOnline ? connectionLabel : '—'}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className={fieldLabelClassName}>IP address</dt>
                <dd className="text-foreground">
                  {isOnline ? (networkInfo?.ipAddress ?? '—') : '—'}
                </dd>
              </div>
            </dl>

            {!isOnline ? (
              <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3">
                <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
                  <CircleAlert className="size-4" strokeWidth={2} aria-hidden="true" />
                  No internet connection
                </p>
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
                  <li>Check your cable or Wi-Fi connection.</li>
                  <li>Check proxy or VPN settings.</li>
                  <li>Check the package mirror configuration below.</li>
                </ol>
                <button
                  type="button"
                  onClick={handleRetry}
                  className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                >
                  <RefreshCw className="size-3.5" strokeWidth={2} aria-hidden="true" />
                  Retry
                </button>
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
