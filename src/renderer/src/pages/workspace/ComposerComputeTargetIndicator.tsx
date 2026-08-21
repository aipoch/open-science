import { ArrowUpRight, Server } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useComputeStore } from '@/stores/compute-store'

type ComposerComputeTargetIndicatorProps = {
  targetProviderIds: string[]
  onOpenTarget: () => void
  onOpenSettings: (providerId: string) => void
}

const ComposerComputeTargetIndicator = ({
  targetProviderIds,
  onOpenTarget,
  onOpenSettings
}: ComposerComputeTargetIndicatorProps): React.JSX.Element | null => {
  const { t } = useTranslation()
  const hosts = useComputeStore((state) => state.hosts)

  if (targetProviderIds.length === 0) return null

  const targetNames = targetProviderIds.map(
    (providerId) => hosts.find((host) => host.providerId === providerId)?.displayName ?? providerId
  )
  const targetNamesLabel = targetNames.join(', ')
  const targetCount = targetProviderIds.length

  return (
    <TooltipProvider delayDuration={300}>
      <Popover>
        <Tooltip>
          <TooltipTrigger
            asChild
            onFocus={(event) => {
              if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
            }}
          >
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="relative text-primary hover:bg-bg-200 hover:text-primary"
                aria-label={
                  targetCount === 1
                    ? t('Compute execution target: {{name}}', { name: targetNamesLabel })
                    : t('Compute execution targets: {{names}}', { names: targetNamesLabel })
                }
                data-testid="composer-compute-target-trigger"
              >
                <span
                  className="flex size-7 items-center justify-center rounded-lg bg-primary/10"
                  aria-hidden="true"
                >
                  <Server className="size-4" strokeWidth={2} />
                </span>
                <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-4 text-bg-000">
                  {targetCount}
                </span>
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            {targetCount === 1
              ? t('Compute execution target: {{name}}', { name: targetNamesLabel })
              : t('Compute execution targets: {{names}}', { names: targetNamesLabel })}
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          className="flex w-[min(16rem,calc(100vw-1rem))] flex-col gap-1 rounded-xl border border-border-200 bg-bg-000 p-1.5 text-text-000 shadow-menu"
          data-testid="composer-compute-target-content"
        >
          <div className="px-2 pt-1 pb-0.5 text-[11px] font-normal text-text-300">
            {t('Selected hosts are used to run jobs.')}
          </div>
          <div className="flex flex-col gap-0">
            {targetNames.map((name, index) => (
              <div
                key={targetProviderIds[index]}
                className="flex min-h-6 min-w-0 items-center gap-0.5 rounded-lg px-2 py-0"
                data-testid="composer-compute-target-row"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{name}</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="group size-5 shrink-0 text-text-300 hover:bg-bg-200 hover:text-text-000"
                      aria-label={t('Open settings for {{name}}', { name })}
                      data-testid={`composer-compute-settings-${targetProviderIds[index]}`}
                      onClick={() => onOpenSettings(targetProviderIds[index])}
                    >
                      <ArrowUpRight
                        className="size-3 transition-transform group-hover:-translate-y-px group-hover:translate-x-px motion-reduce:transform-none motion-reduce:transition-none"
                        aria-hidden="true"
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-[11px]">
                    {t('Open settings for {{name}}', { name })}
                  </TooltipContent>
                </Tooltip>
              </div>
            ))}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-0.5 w-full justify-start text-xs text-text-100"
            data-testid="composer-compute-change-targets"
            onClick={onOpenTarget}
          >
            {t('Change execution targets')}
          </Button>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  )
}

export { ComposerComputeTargetIndicator }
