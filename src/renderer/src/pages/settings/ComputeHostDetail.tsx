import { AlertTriangle, Cpu, HardDrive, MemoryStick, RefreshCw, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { ComputeHost } from '../../../../shared/compute'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useComputeStore } from '@/stores/compute-store'

type ComputeHostDetailProps = {
  providerId: string
  // Called after the host is removed (SettingsPage returns to the list).
  onRemoved: () => void
}

// Renders a "probed X ago" relative label from an ISO timestamp.
const probedLabel = (host: ComputeHost): string | null => {
  const probedAt = host.probeResult?.probedAt
  if (!probedAt) return null
  const then = Date.parse(probedAt)
  if (Number.isNaN(then)) return null
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return 'probed just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `probed ${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `probed ${hours} h ago`
  return `probed ${Math.round(hours / 24)} d ago`
}

// Host detail page for issue 02: adds Probe button, probe failure banner, and resource summary.
// The Details editor, Scratch root, and Concurrency blocks come in issue 03.
export function ComputeHostDetail({
  providerId,
  onRemoved
}: ComputeHostDetailProps): React.JSX.Element {
  const hosts = useComputeStore((state) => state.hosts)
  const isLoaded = useComputeStore((state) => state.isLoaded)
  const loadHosts = useComputeStore((state) => state.loadHosts)
  const deleteHost = useComputeStore((state) => state.deleteHost)
  const probeHost = useComputeStore((state) => state.probeHost)
  const probingIds = useComputeStore((state) => state.probingIds)

  const [probeError, setProbeError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!isLoaded) void loadHosts()
  }, [isLoaded, loadHosts])

  const host = hosts.find((entry) => entry.providerId === providerId)
  const isProbing = probingIds.has(providerId)

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

  const probedAgo = probedLabel(host)

  const handleRemove = async (): Promise<void> => {
    await deleteHost(host.providerId)
    onRemoved()
  }

  const handleProbe = async (): Promise<void> => {
    setProbeError(undefined)
    try {
      await probeHost(host.providerId)
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : 'Probe failed unexpectedly.')
    }
  }

  return (
    <div className="p-5">
      {/* Header row: icon + name + badge + probe button + remove */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-lg',
              status === 'connected'
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
                : status === 'failed'
                  ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400'
                  : 'bg-muted text-muted-foreground'
            )}
            aria-hidden="true"
          >
            <Zap className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
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
            {probedAgo ? (
              <p className="mt-0.5 font-mono text-xs text-muted-foreground">{probedAgo}</p>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleProbe()}
            disabled={isProbing}
            aria-busy={isProbing}
          >
            <RefreshCw className={cn('size-3.5', isProbing && 'animate-spin')} aria-hidden="true" />
            {isProbing ? 'Probing…' : 'Probe'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => void handleRemove()}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            Remove
          </Button>
        </div>
      </div>

      {/* Probe failed banner — shown when the last probe returned ok:false */}
      {status === 'failed' && probed ? (
        <div
          role="alert"
          className="mt-5 rounded-xl border border-rose-200 bg-rose-50/50 px-3 py-3 dark:border-rose-800/50 dark:bg-rose-950/20"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle
              className="size-4 shrink-0 text-rose-600 dark:text-rose-400"
              aria-hidden="true"
            />
            <span className="text-sm font-semibold text-rose-700 dark:text-rose-300">
              Probe failed
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => void handleProbe()}
              disabled={isProbing}
              aria-label="Retry probe"
              className="ml-auto text-rose-600 hover:bg-rose-100 dark:text-rose-400"
            >
              <RefreshCw
                className={cn('size-3.5', isProbing && 'animate-spin')}
                aria-hidden="true"
              />
            </Button>
          </div>
          {probed.errorTail ? (
            <pre className="mt-2 overflow-x-auto rounded bg-rose-100/50 px-2 py-1.5 font-mono text-xs text-rose-800 dark:bg-rose-900/30 dark:text-rose-300">
              {probed.errorTail}
            </pre>
          ) : null}
          <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">
            Run <code className="font-mono">ssh {host.sshAlias}</code> manually to accept the host
            key, then retry.
          </p>
        </div>
      ) : null}

      {/* IPC / unexpected probe error banner */}
      {probeError ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {probeError}
        </p>
      ) : null}

      {/* Resource summary — shown only when a successful probe has populated resource fields */}
      {status === 'connected' && probed ? (
        <div className="mt-5 flex flex-col gap-2">
          <h4 className="text-sm font-medium text-foreground">Resources</h4>
          <div className="flex flex-wrap gap-3">
            {probed.cpus != null ? (
              <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-2.5 py-1.5 text-sm">
                <Cpu className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span>
                  <span className="font-semibold">{probed.cpus}</span>{' '}
                  <span className="text-muted-foreground">CPUs</span>
                </span>
              </div>
            ) : null}
            {probed.memMib != null ? (
              <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-2.5 py-1.5 text-sm">
                <MemoryStick
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span>
                  <span className="font-semibold">{Math.round(probed.memMib / 1024)}</span>{' '}
                  <span className="text-muted-foreground">GB RAM</span>
                </span>
              </div>
            ) : null}
            {probed.gpus && probed.gpus.length > 0
              ? probed.gpus.map((gpu, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-2.5 py-1.5 text-sm"
                  >
                    <HardDrive
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span>
                      <span className="font-semibold">{gpu.count}&times;</span>{' '}
                      <span className="text-muted-foreground">{gpu.type}</span>
                    </span>
                  </div>
                ))
              : null}
            {probed.detectedScheduler && probed.detectedScheduler !== 'none' ? (
              <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-2.5 py-1.5 text-sm">
                <span className="font-semibold capitalize">{probed.detectedScheduler}</span>
                <span className="text-muted-foreground">scheduler</span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Placeholder for Details editor, Scratch root, Concurrency (issues 03+) */}
      <p className="mt-6 rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
        Details, Scratch root, and Concurrent job limit are coming soon.
      </p>
    </div>
  )
}
