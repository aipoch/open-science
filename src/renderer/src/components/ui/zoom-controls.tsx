import { Shrink, ZoomIn, ZoomOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from './button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'

export function ZoomControls({
  onZoomIn,
  onZoomOut,
  onReset,
  canZoomIn = true,
  canZoomOut = true,
  resetLabel,
  tooltipClassName
}: {
  onZoomIn(): void
  onZoomOut(): void
  onReset(): void
  canZoomIn?: boolean
  canZoomOut?: boolean
  resetLabel?: string
  tooltipClassName?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const actions = [
    { label: t('Zoom in'), Icon: ZoomIn, onClick: onZoomIn, disabled: !canZoomIn },
    { label: t('Zoom out'), Icon: ZoomOut, onClick: onZoomOut, disabled: !canZoomOut },
    { label: resetLabel ?? t('Reset zoom'), Icon: Shrink, onClick: onReset, disabled: false }
  ]
  return (
    <TooltipProvider>
      {actions.map(({ label, Icon, onClick, disabled }) => (
        <Tooltip key={label}>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-text-100 hover:text-text-000 [@media(pointer:coarse)]:size-11"
              aria-label={label}
              onClick={onClick}
              disabled={disabled}
            >
              <Icon aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent className={tooltipClassName}>{label}</TooltipContent>
        </Tooltip>
      ))}
    </TooltipProvider>
  )
}
