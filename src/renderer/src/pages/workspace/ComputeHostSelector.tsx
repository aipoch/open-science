import { SlidersHorizontal, Settings } from 'lucide-react'

import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useComputeStore } from '@/stores/compute-store'
import { useSettingsStore } from '@/stores/settings-store'

type ComputeHostSelectorProps = {
  // The set of provider ids currently enabled for this session.
  enabledHosts: string[]
  // Called when the user toggles a host on or off (single-select: enabling one disables others).
  onToggle: (providerId: string, enabled: boolean) => void
}

const triggerClassName =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-300 hover:bg-bg-200 hover:text-text-100 disabled:cursor-not-allowed disabled:opacity-50 transition-colors duration-200 ease-out'

// Shows the current active host alias truncated, or a placeholder when none is enabled.
const activeLabel = (
  enabledHosts: string[],
  hosts: { providerId: string; displayName: string }[]
): string => {
  if (enabledHosts.length === 0) return ''
  const host = hosts.find((h) => enabledHosts.includes(h.providerId))
  return host?.displayName ?? enabledHosts[0].replace('ssh:', '')
}

// Composer toolbar `≡` button — opens the Compute host selector panel.
// Follows the ComposerModelPicker pattern: reads from the compute store (global), no prop drilling.
const ComputeHostSelector = ({
  enabledHosts,
  onToggle
}: ComputeHostSelectorProps): React.JSX.Element | null => {
  const hosts = useComputeStore((state) => state.hosts)
  const isLoaded = useComputeStore((state) => state.isLoaded)
  const loadHosts = useComputeStore((state) => state.loadHosts)
  const openSettingsToCompute = useSettingsStore((state) => state.openSettingsToCompute)

  const sshHosts = hosts.filter((h) => h.sshAlias)
  const activeHostLabel = activeLabel(enabledHosts, hosts)

  const handleOpenChange = (open: boolean): void => {
    if (open && !isLoaded) {
      void loadHosts()
    }
  }

  const handleToggle = (providerId: string, currentlyEnabled: boolean): void => {
    if (currentlyEnabled) {
      // Toggling off: disable this host
      onToggle(providerId, false)
    } else {
      // Toggling on: single-select — disable any currently enabled host first, then enable this one
      onToggle(providerId, true)
    }
  }

  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={triggerClassName}
          aria-label={activeHostLabel ? `Compute: ${activeHostLabel}` : 'Select compute host'}
          title={
            activeHostLabel ? `Active compute host: ${activeHostLabel}` : 'Compute host selector'
          }
        >
          <SlidersHorizontal className="size-4" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[15rem]">
        {sshHosts.length > 0 ? (
          <>
            <DropdownMenuLabel className="text-[10.5px] uppercase tracking-wide text-text-300 font-normal">
              SSH
            </DropdownMenuLabel>
            <DropdownMenuGroup>
              {sshHosts.map((host) => {
                const isEnabled = enabledHosts.includes(host.providerId)
                return (
                  <DropdownMenuItem
                    key={host.providerId}
                    onSelect={(event) => {
                      event.preventDefault()
                      handleToggle(host.providerId, isEnabled)
                    }}
                    className="flex items-center justify-between gap-3 cursor-pointer"
                  >
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate text-sm',
                        isEnabled ? 'font-medium text-text-100' : 'text-text-200'
                      )}
                    >
                      {host.displayName}
                    </span>
                    <Switch
                      checked={isEnabled}
                      onCheckedChange={(checked) => handleToggle(host.providerId, checked)}
                      aria-label={`${isEnabled ? 'Disable' : 'Enable'} ${host.displayName}`}
                      onPointerDown={(e) => e.stopPropagation()}
                    />
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuGroup>
          </>
        ) : (
          <DropdownMenuItem disabled className="text-text-300 text-sm">
            {isLoaded ? 'No SSH hosts registered' : 'Loading…'}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => openSettingsToCompute()}
          className="gap-2 text-sm text-text-200"
        >
          <Settings className="size-4 shrink-0" aria-hidden="true" />
          Manage compute...
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export { ComputeHostSelector }
