import type { ReactElement } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export function ResourceActionTooltip({
  label,
  children
}: {
  label?: string
  children: ReactElement
}): React.JSX.Element {
  if (!label) return children
  return (
    <Tooltip>
      <TooltipTrigger
        asChild
        onFocus={(event) => {
          if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
        }}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function ComputeOpenSessionButton({
  onClick,
  className,
  describedBy
}: {
  onClick: () => void
  className?: string
  describedBy?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const label = t('Open session')
  return (
    <ResourceActionTooltip label={label}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className={cn('text-muted-foreground', className)}
        aria-label={label}
        aria-describedby={describedBy}
        onClick={onClick}
      >
        <ArrowUpRight className="size-4" aria-hidden="true" />
      </Button>
    </ResourceActionTooltip>
  )
}
