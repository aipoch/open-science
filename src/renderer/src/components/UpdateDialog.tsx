import { Download, ExternalLink, RefreshCw, X } from 'lucide-react'
import { Dialog } from 'radix-ui'

import { DownloadProgressLine } from '@/components/DownloadProgressLine'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { AgentMarkdown } from '@/components/streamdown/AgentMarkdown'
import { Button } from '@/components/ui/button'
import {
  dialogCloseButtonClassName,
  dialogOverlayClassName,
  dialogPanelClassName
} from '@/components/ui/dialog-chrome'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { cn } from '@/lib/utils'
import { useUpdateStore } from '@/stores/update-store'
import { APP } from '../../../shared/app-config'
import { formatBytes } from '../../../shared/update'

// Update confirmation dialog: shows the target version and release notes so the user can decide
// before a large download. Opened from the external capsule and the settings About section. When the
// manifest carries no notes, it links to the matching GitHub release so the user can still read them.
const UpdateDialog = (): React.JSX.Element | null => {
  const status = useUpdateStore((state) => state.status)
  const isOpen = useUpdateStore((state) => state.isDialogOpen)
  const closeDialog = useUpdateStore((state) => state.closeDialog)
  const download = useUpdateStore((state) => state.download)
  const apply = useUpdateStore((state) => state.apply)

  const open = Boolean(isOpen && status.latest)
  const dialogStatus = useRetainedDialogValue(open ? status : undefined)
  const releaseUrl = `${APP.links.githubReleases}/tag/v${dialogStatus?.latest ?? ''}`
  const isDownloading = dialogStatus?.state === 'downloading'
  const isReady = dialogStatus?.state === 'ready'

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(open) => {
        if (!open) closeDialog()
      }}
    >
      {dialogStatus ? (
        <Dialog.Portal>
          <Dialog.Overlay className={cn(dialogOverlayClassName, 'z-[60]')} />
          <Dialog.Content
            onInteractOutside={(event) => event.preventDefault()}
            className={dialogPanelClassName('z-[60] w-[min(560px,calc(100vw-2rem))]')}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <Dialog.Title className="text-base font-semibold">Update available</Dialog.Title>
                <Dialog.Description className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                  v{dialogStatus.current} → v{dialogStatus.latest}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close"
                  className={dialogCloseButtonClassName}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </Dialog.Close>
            </div>

            {dialogStatus.notes ? (
              <div className="mt-3">
                <p className="mb-1 text-xs font-medium text-muted-foreground">What&apos;s new</p>
                <div className="max-h-96 overflow-auto rounded-lg bg-muted px-3 py-2">
                  <AgentMarkdown content={dialogStatus.notes} />
                </div>
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
              <div className="mt-4">
                <DownloadProgressLine
                  progress={
                    dialogStatus.downloadProgress ?? {
                      phase: 'downloading',
                      transferred: dialogStatus.downloadedBytes ?? 0,
                      total: dialogStatus.totalBytes,
                      percent: dialogStatus.progress ?? 0,
                      bytesPerSecond: 0,
                      attempt: 0
                    }
                  }
                />
              </div>
            ) : null}

            {dialogStatus.state === 'error' ? (
              <div className="mt-3" role="alert">
                <p className="text-xs text-destructive">{dialogStatus.error ?? 'Update failed'}</p>
                {/* Fallback when the in-app update fails (e.g. a blocked/failed in-place install): let the
                  user grab the installer by hand, mirroring the macOS manual-reinstall path. */}
                <ExternalTextLink href={APP.update.downloadPage} className="mt-1 text-xs">
                  Download manually
                </ExternalTextLink>
              </div>
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
                  onClick={() => void apply()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  {dialogStatus.applyKind === 'restart' ? (
                    <>
                      <RefreshCw className="size-4" aria-hidden="true" />
                      Restart to update
                    </>
                  ) : (
                    <>
                      <ExternalLink className="size-4" aria-hidden="true" />
                      Open installer
                    </>
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void download()}
                  disabled={isDownloading}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  <Download className="size-4" aria-hidden="true" />
                  {isDownloading
                    ? `Downloading ${dialogStatus.progress ?? 0}%`
                    : dialogStatus.totalBytes
                      ? `Download update (${formatBytes(dialogStatus.totalBytes)})`
                      : 'Download update'}
                </button>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      ) : null}
    </Dialog.Root>
  )
}

export { UpdateDialog }
