import { WifiOff } from 'lucide-react'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useNetworkStore } from '@/stores/network-store'
import { useSettingsStore } from '@/stores/settings-store'

type NetworkStatusIndicatorProps = {
  // 'pill' for the home header (icon + label), 'icon' for the workspace sidebar footer
  // where space is tight.
  variant: 'pill' | 'icon'
}

// Offline warning entry point. Renders nothing while online; when offline, clicking opens
// the settings Network panel for troubleshooting.
const NetworkStatusIndicator = ({
  variant
}: NetworkStatusIndicatorProps): React.JSX.Element | null => {
  const isOnline = useNetworkStore((state) => state.isOnline)
  const openSettingsToPanel = useSettingsStore((state) => state.openSettingsToPanel)

  if (isOnline) return null

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => openSettingsToPanel('network')}
            aria-label="No internet connection"
            className={
              variant === 'pill'
                ? 'inline-flex h-8 items-center gap-1 rounded-full border border-danger-000/20 bg-danger-000/10 px-2.5 text-xs font-medium text-danger-000 transition-colors duration-150 ease-out hover:border-danger-000/30 hover:bg-danger-000/15'
                : 'inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-danger-000 transition-colors duration-150 ease-out hover:bg-danger-900'
            }
          >
            <WifiOff
              className={variant === 'pill' ? 'size-3.5' : 'size-4'}
              strokeWidth={2}
              aria-hidden="true"
            />
            {variant === 'pill' ? <span>Offline</span> : null}
          </button>
        </TooltipTrigger>
        <TooltipContent>No internet connection</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export { NetworkStatusIndicator }
