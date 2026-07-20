import { Folder, Info, Plus, Server, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { ComputeHost } from '../../../../shared/compute'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useComputeStore } from '@/stores/compute-store'

// The compute panel sub-view, driven by the settings navigation history. The add form and host detail
// are separate components owned by SettingsPage; this panel renders the list + header banner only.
export type ComputeView =
  { kind: 'list' } | { kind: 'add' } | { kind: 'detail'; providerId: string }

type ComputePanelProps = {
  onNavigate: (view: ComputeView) => void
}

// Renders a "probed X ago" relative label from an ISO timestamp. Placeholder chrome for Phase 1 — the
// probe itself lands in a later issue, so an un-probed host shows nothing here.
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

// One host row. Status badge / icon tint are driven by the (later-issue) probe snapshot; with no probe
// yet the row renders in a neutral state.
const HostCard = ({
  host,
  onOpen,
  onDelete
}: {
  host: ComputeHost
  onOpen: () => void
  onDelete: () => void
}): React.JSX.Element => {
  const probed = host.probeResult
  const status: 'connected' | 'failed' | 'none' = probed
    ? probed.ok
      ? 'connected'
      : 'failed'
    : 'none'
  const probed_ago = probedLabel(host)

  return (
    <div
      data-slot="compute-host-card"
      className="flex items-center gap-3 rounded-xl border border-border px-3 py-3 transition-colors hover:border-ring/60"
    >
      <div
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-lg',
          status === 'connected'
            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
            : status === 'failed'
              ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400'
              : 'bg-muted text-muted-foreground'
        )}
        aria-hidden="true"
      >
        <Server className="size-4" />
      </div>

      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-sm font-semibold text-foreground">{host.displayName}</span>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {host.providerId}
          </span>
        </span>
        {probed_ago ? (
          <span className="mt-0.5 block font-mono text-xs text-muted-foreground">{probed_ago}</span>
        ) : (
          <span className="mt-0.5 block text-xs text-muted-foreground">Not probed yet</span>
        )}
      </button>

      <TooltipProvider delayDuration={200}>
        {/* File browsing is coming soon (folder icon is greyed out / disabled in Phase 1). */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled
                aria-label="Browse files (coming soon)"
                className="shrink-0 text-muted-foreground/50"
              >
                <Folder className="size-4" aria-hidden="true" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>File browsing coming soon</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onDelete}
              aria-label={`Remove ${host.displayName}`}
              className="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove host</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {status === 'connected' ? (
        <Badge className="shrink-0 bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
          Connected
        </Badge>
      ) : status === 'failed' ? (
        <Badge className="shrink-0 bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400">
          Probe failed
        </Badge>
      ) : (
        <Badge variant="outline" className="shrink-0">
          Not probed
        </Badge>
      )}
    </div>
  )
}

export function ComputePanel({ onNavigate }: ComputePanelProps): React.JSX.Element {
  const hosts = useComputeStore((state) => state.hosts)
  const isLoaded = useComputeStore((state) => state.isLoaded)
  const loadError = useComputeStore((state) => state.loadError)
  const loadHosts = useComputeStore((state) => state.loadHosts)
  const deleteHost = useComputeStore((state) => state.deleteHost)

  // A short-lived confirmation message shown after a delete (the prototype's "confirmation toast").
  const [toast, setToast] = useState<string | undefined>(undefined)

  useEffect(() => {
    void loadHosts()
  }, [loadHosts])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(undefined), 4000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const handleDelete = async (host: ComputeHost): Promise<void> => {
    await deleteHost(host.providerId)
    setToast(`Removed ${host.displayName}.`)
  }

  return (
    <div className="p-5">
      <div className="mb-5 flex items-start gap-2 rounded-xl bg-muted/50 px-3 py-2.5 text-sm text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>Connect where heavy compute runs — your own servers over SSH.</span>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-foreground">SSH hosts</h3>
          <p className="mt-0.5 max-w-2xl text-[13px] leading-5 text-muted-foreground">
            Servers, clusters or job submission nodes from your SSH host lists
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="shrink-0"
          onClick={() => onNavigate({ kind: 'add' })}
        >
          <Plus className="size-4" aria-hidden="true" />
          Add SSH host
        </Button>
      </div>

      {toast ? (
        <p
          role="status"
          aria-live="polite"
          className="mt-4 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-foreground"
        >
          {toast}
        </p>
      ) : null}

      <div className="mt-4 flex flex-col gap-2.5">
        {loadError ? (
          <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            Couldn&apos;t load hosts: {loadError}
          </p>
        ) : !isLoaded ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading hosts…</p>
        ) : hosts.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No SSH hosts yet. Add one to let Open Science run compute on your servers.
          </p>
        ) : (
          hosts.map((host) => (
            <HostCard
              key={host.providerId}
              host={host}
              onOpen={() => onNavigate({ kind: 'detail', providerId: host.providerId })}
              onDelete={() => void handleDelete(host)}
            />
          ))
        )}
      </div>
    </div>
  )
}
