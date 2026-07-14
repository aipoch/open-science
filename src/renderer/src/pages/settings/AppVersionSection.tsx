import { Download, RefreshCw } from 'lucide-react'

import logoUrl from '@/assets/logo.png'
import { useUpdateStore } from '@/stores/update-store'
import { APP } from '../../../../shared/app-config'

// App identity + update control in Settings→General. Reads the shared update store so it stays in
// sync with the external capsule; the update button opens the shared dialog (version + notes +
// download), so the download/confirm UX lives in one place.
const AppVersionSection = (): React.JSX.Element => {
  const appInfo = useUpdateStore((state) => state.appInfo)
  const status = useUpdateStore((state) => state.status)
  const check = useUpdateStore((state) => state.check)
  const openDialog = useUpdateStore((state) => state.openDialog)

  const version = appInfo?.version ?? status.current
  const isChecking = status.state === 'checking'
  const isDownloading = status.state === 'downloading'
  const hasUpdate = status.state === 'available' || isDownloading || status.state === 'ready'

  const statusLine = ((): string => {
    switch (status.state) {
      case 'checking':
        return 'Checking for updates…'
      case 'available':
        return `New version ${status.latest} is available`
      case 'downloading':
        return `Downloading… ${status.progress ?? 0}%`
      case 'ready':
        return 'Update downloaded — open the installer to finish'
      case 'up-to-date':
        return 'You are on the latest version'
      case 'error':
        return status.error ?? 'Update check failed'
      default:
        return ''
    }
  })()

  return (
    <section aria-label="App version">
      <h3 className="mb-1 text-sm font-semibold text-foreground">About</h3>
      <div className="rounded-xl border border-border p-4">
        {/* Identity on the left, update controls on the same row to the right. */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <img src={logoUrl} alt="" className="size-12 rounded-lg" />
            <div className="min-w-0">
              <p className="flex items-baseline gap-2">
                <span className="text-sm font-semibold text-foreground">{APP.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">v{version}</span>
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{APP.copyright}</p>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => void check()}
              disabled={isChecking}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-bg-300 disabled:opacity-50"
            >
              <RefreshCw
                className={isChecking ? 'size-4 animate-spin' : 'size-4'}
                aria-hidden="true"
              />
              {isChecking ? 'Checking…' : 'Check now'}
            </button>

            {hasUpdate ? (
              <button
                type="button"
                onClick={() => openDialog()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-primary bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Download className="size-4" aria-hidden="true" />
                {isDownloading
                  ? `Downloading ${status.progress ?? 0}%`
                  : status.state === 'ready'
                    ? 'Update ready'
                    : `Update to ${status.latest}`}
              </button>
            ) : null}
          </div>
        </div>

        {statusLine ? (
          <p
            className={
              status.state === 'error'
                ? 'mt-3 text-xs text-destructive'
                : 'mt-3 text-xs text-muted-foreground'
            }
            role={status.state === 'error' ? 'alert' : undefined}
          >
            {statusLine}
          </p>
        ) : null}
      </div>
    </section>
  )
}

export { AppVersionSection }
