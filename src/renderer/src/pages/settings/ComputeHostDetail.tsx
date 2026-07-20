import { Zap } from 'lucide-react'
import { useEffect } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useComputeStore } from '@/stores/compute-store'

type ComputeHostDetailProps = {
  providerId: string
  // Called after the host is removed (SettingsPage returns to the list).
  onRemoved: () => void
}

// Host detail page shell for Phase 1 (issue 01): header (name + status + connection string) and a
// Remove action only. The Probe, Details editor, Scratch root, and Concurrency blocks land in issues
// 02/03 and mount into this shell.
export function ComputeHostDetail({
  providerId,
  onRemoved
}: ComputeHostDetailProps): React.JSX.Element {
  const hosts = useComputeStore((state) => state.hosts)
  const isLoaded = useComputeStore((state) => state.isLoaded)
  const loadHosts = useComputeStore((state) => state.loadHosts)
  const deleteHost = useComputeStore((state) => state.deleteHost)

  useEffect(() => {
    if (!isLoaded) void loadHosts()
  }, [isLoaded, loadHosts])

  const host = hosts.find((entry) => entry.providerId === providerId)

  if (!host) {
    return (
      <div className="p-5">
        <p className="py-8 text-center text-sm text-muted-foreground">
          {isLoaded ? 'This host no longer exists.' : 'Loading host…'}
        </p>
      </div>
    )
  }

  const probed = host.probeResult
  const status: 'connected' | 'failed' | 'none' = probed
    ? probed.ok
      ? 'connected'
      : 'failed'
    : 'none'

  const handleRemove = async (): Promise<void> => {
    await deleteHost(host.providerId)
    onRemoved()
  }

  return (
    <div className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
            aria-hidden="true"
          >
            <Zap className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-lg font-semibold text-foreground">{host.displayName}</h3>
              {status === 'connected' ? (
                <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
                  Connected
                </Badge>
              ) : status === 'failed' ? (
                <Badge className="bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400">
                  Probe failed
                </Badge>
              ) : (
                <Badge variant="outline">Not probed</Badge>
              )}
            </div>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">{host.providerId}</p>
          </div>
        </div>

        <Button
          type="button"
          variant="ghost"
          onClick={() => void handleRemove()}
          className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          Remove
        </Button>
      </div>

      <p className="mt-6 rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
        Probe, Details, Scratch root, and Concurrent job limit are coming soon.
      </p>
    </div>
  )
}
