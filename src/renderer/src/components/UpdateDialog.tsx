import { Download, ExternalLink, X } from 'lucide-react'
import { Dialog } from 'radix-ui'

import { ExternalTextLink } from '@/components/ExternalTextLink'
import { useUpdateStore } from '@/stores/update-store'
import { APP } from '../../../shared/app-config'

// Update confirmation dialog: shows the target version and release notes so the user can decide
// before a large download. Opened from the external capsule and the settings About section. When the
// manifest carries no notes, it links to the matching GitHub release so the user can still read them.
const UpdateDialog = (): React.JSX.Element | null => {
  const status = useUpdateStore((state) => state.status)
  const isOpen = useUpdateStore((state) => state.isDialogOpen)
  const closeDialog = useUpdateStore((state) => state.closeDialog)
  const download = useUpdateStore((state) => state.download)
  const openInstaller = useUpdateStore((state) => state.openInstaller)

  if (!isOpen || !status.latest) return null

  const releaseUrl = `${APP.links.githubReleases}/tag/v${status.latest}`
  const isDownloading = status.state === 'downloading'
  const isReady = status.state === 'ready'

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) closeDialog()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[60] w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-5 text-foreground shadow-dialog">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-base font-semibold">Update available</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                v{status.current} → v{status.latest}
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Close"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-bg-300 hover:text-foreground"
            >
              <X className="size-4" aria-hidden="true" />
            </Dialog.Close>
          </div>

          {status.notes ? (
            <div className="mt-3">
              <p className="mb-1 text-xs font-medium text-muted-foreground">What&apos;s new</p>
              <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-xs text-foreground">
                {status.notes}
              </pre>
              <ExternalTextLink href={releaseUrl} className="mt-2 text-xs">
                View full release notes on GitHub
              </ExternalTextLink>
            </div>
          ) : (
            <div className="mt-3 rounded-lg border border-border bg-muted/50 px-3 py-3 text-xs text-muted-foreground">
              Release notes aren&apos;t available in-app for this version.{' '}
              <ExternalTextLink href={releaseUrl} className="text-xs">
                View release notes on GitHub
              </ExternalTextLink>
            </div>
          )}

          {isDownloading ? (
            <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-bg-300">
              <div
                className="h-full rounded-full bg-primary transition-all duration-150 ease-out"
                style={{ width: `${status.progress ?? 0}%` }}
              />
            </div>
          ) : null}

          {status.state === 'error' ? (
            <p className="mt-3 text-xs text-destructive" role="alert">
              {status.error ?? 'Update failed'}
            </p>
          ) : null}

          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => closeDialog()}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-bg-300"
            >
              {isReady ? 'Close' : 'Cancel'}
            </button>
            {isReady ? (
              <button
                type="button"
                onClick={() => void openInstaller()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <ExternalLink className="size-4" aria-hidden="true" />
                Open installer
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void download()}
                disabled={isDownloading}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                <Download className="size-4" aria-hidden="true" />
                {isDownloading ? `Downloading ${status.progress ?? 0}%` : 'Download update'}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export { UpdateDialog }
