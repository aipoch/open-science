import { ComputeAddButton } from './ComputeTargetGroup'
import { SettingsSection } from './SettingsLayout'
import { KubernetesTargets } from './KubernetesTargets'
import { HostedTargets } from './HostedTargets'
import { RayTargets } from './RayTargets'
import { ModalTargets } from './ModalTargets'
import type { ComputeView } from '../../lib/settings-navigation'
import { ErrorNotice } from '@/components/error-notice'
import { Folder, Server, Terminal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ComputeHost } from '@aipoch/compute'

import { DiagnosticDetails } from '@/components/diagnostic-details'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { consumeComputeHostsPreload, useComputeStore } from '@/stores/compute-store'
import { probedLabel } from './compute-probed-label'
import { ComputeHostRemovalDialog } from './ComputeHostRemovalDialog'
import { FileBrowserModal } from './FileBrowserModal'

// The compute panel sub-view, driven by the settings navigation history. The add form and host detail
// are separate components owned by SettingsPage; this panel renders the target lists.
export type { ComputeView } from '../../lib/settings-navigation'

type ComputePanelProps = {
  onNavigate: (view: ComputeView) => void
}

// One host row. Status badge / icon tint are driven by the (later-issue) probe snapshot; with no probe
// yet the row renders in a neutral state.
const HostCard = ({
  host,
  onOpen,
  onRemoved,
  onBrowse
}: {
  host: ComputeHost
  onOpen: () => void
  onRemoved: () => void
  onBrowse: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const probed = host.probeResult
  const status: 'last_probe_ok' | 'failed' | 'none' = probed
    ? probed.ok
      ? 'last_probe_ok'
      : 'failed'
    : 'none'
  const probedAgo = probedLabel(host)

  return (
    <div data-slot="compute-host-card" className="relative flex items-center gap-3 py-2.5">
      <div
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-lg',
          status === 'last_probe_ok'
            ? 'bg-status-success-surface text-status-success-foreground dark:bg-status-success-dark-surface/40 dark:text-status-success-dark-foreground'
            : status === 'failed'
              ? 'bg-status-failure-surface text-status-failure-foreground dark:bg-status-failure-dark-surface/40 dark:text-status-failure-dark-foreground'
              : 'bg-muted text-muted-foreground'
        )}
        aria-hidden="true"
      >
        <Server className="size-4" />
      </div>

      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 text-left after:absolute after:-inset-px after:rounded-[inherit]"
      >
        <span className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium text-foreground">{host.displayName}</span>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {host.providerId}
          </span>
        </span>
        {probedAgo ? (
          <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
            {t(probedAgo.key, { count: probedAgo.count })}
          </span>
        ) : (
          <span className="mt-0.5 block text-xs text-muted-foreground">{t('Not probed yet')}</span>
        )}
      </button>

      <div className="relative z-10 flex items-center gap-3">
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={onBrowse}
                  aria-label={t('Browse files on {{name}}', { name: host.displayName })}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <Folder className="size-4" aria-hidden="true" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{t('Browse files')}</TooltipContent>
          </Tooltip>
          <ComputeHostRemovalDialog host={host} onRemoved={onRemoved} />
        </TooltipProvider>
      </div>

      {status === 'last_probe_ok' ? (
        <Badge className="shrink-0 bg-status-success-surface text-status-success-foreground dark:bg-status-success-dark-surface/40 dark:text-status-success-dark-foreground">
          {t('Last probe succeeded')}
        </Badge>
      ) : status === 'failed' ? (
        <Badge className="shrink-0 bg-status-failure-surface text-status-failure-foreground dark:bg-status-failure-dark-surface/40 dark:text-status-failure-dark-foreground">
          {t('Probe failed')}
        </Badge>
      ) : (
        <Badge variant="outline" className="shrink-0">
          {t('Not probed')}
        </Badge>
      )}
    </div>
  )
}

export function ComputePanel({ onNavigate }: ComputePanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const hosts = useComputeStore((state) => state.hosts)
  const isLoaded = useComputeStore((state) => state.isLoaded)
  const loadError = useComputeStore((state) => state.loadError)
  const loadHosts = useComputeStore((state) => state.loadHosts)
  const initialLoadStartedRef = useRef(false)

  // A short-lived confirmation message shown after a delete (the prototype's "confirmation toast").
  // Stores the removed host's name rather than a rendered sentence, so a language switch inside the
  // 4-second window re-renders it in the new language instead of freezing the old one.
  const [removedName, setRemovedName] = useState<string | undefined>(undefined)

  // File browser modal state
  const [browserProviderId, setBrowserProviderId] = useState<string | undefined>(undefined)

  useEffect(() => {
    // React StrictMode replays mount effects in development. Keep that replay from consuming the
    // one-shot preload and then issuing a second read; a genuine remount receives a fresh ref.
    if (initialLoadStartedRef.current) return
    initialLoadStartedRef.current = true
    if (!consumeComputeHostsPreload()) void loadHosts()
  }, [loadHosts])

  useEffect(() => {
    if (!removedName) return
    const timer = window.setTimeout(() => setRemovedName(undefined), 4000)
    return () => window.clearTimeout(timer)
  }, [removedName])

  return (
    <div className="space-y-5 p-5">
      <SettingsSection
        title={t('SSH hosts')}
        icon={<Terminal className="size-5 text-muted-foreground" />}
        action={
          <ComputeAddButton
            label={t('Add SSH host')}
            anchor="compute.add-host"
            onClick={() => onNavigate({ kind: 'add' })}
          />
        }
      >
        {removedName ? (
          <p
            role="status"
            aria-live="polite"
            className="mt-4 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-foreground"
          >
            {t('Removed {{name}}.', { name: removedName })}
          </p>
        ) : null}

        <div className="flex flex-col divide-y divide-border">
          {loadError ? (
            <ErrorNotice role="alert" description={t("Couldn't load hosts.")}>
              <DiagnosticDetails detail={loadError} />
            </ErrorNotice>
          ) : !isLoaded ? (
            <p className="py-1 text-sm text-muted-foreground">{t('Loading hosts…')}</p>
          ) : hosts.length === 0 ? (
            <p className="py-1 text-sm text-muted-foreground">{t('Not configured')}</p>
          ) : (
            hosts.map((host) => (
              <HostCard
                key={host.providerId}
                host={host}
                onOpen={() => onNavigate({ kind: 'detail', providerId: host.providerId })}
                onRemoved={() => setRemovedName(host.displayName)}
                onBrowse={() => setBrowserProviderId(host.providerId)}
              />
            ))
          )}
        </div>
      </SettingsSection>
      <HostedTargets onNavigate={onNavigate} />
      <ModalTargets onNavigate={onNavigate} />
      <KubernetesTargets onNavigate={onNavigate} />
      <RayTargets onNavigate={onNavigate} />

      {/* File browser modal — opened when a host folder button is clicked */}
      <FileBrowserModal
        open={browserProviderId !== undefined}
        onClose={() => setBrowserProviderId(undefined)}
        initialProviderId={browserProviderId}
      />
    </div>
  )
}
