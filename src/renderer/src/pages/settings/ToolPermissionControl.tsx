import { Ban, CircleCheck, Hand } from 'lucide-react'
import { RadioGroup } from 'radix-ui'
import { useTranslation } from 'react-i18next'

import type { ToolPermission } from '../../../../shared/settings'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

type ToolPermissionControlProps = {
  value: ToolPermission
  onChange: (next: ToolPermission) => void
  label: string // accessible group label, e.g. "Permission for list_marts"
}

// A 3-segment permission pill: "Always allow / Require approval / Block". The middle policy asks
// only when the Broker cannot resolve an existing Global, Project, or Session approval.
export function ToolPermissionControl({
  value,
  onChange,
  label
}: ToolPermissionControlProps): React.JSX.Element {
  const { t } = useTranslation()

  const segment = (active: boolean, allow: boolean): string => {
    const base =
      'grid h-6 w-7 place-items-center rounded-md transition-colors motion-reduce:transition-none'
    if (active) {
      return `${base} bg-card shadow-sm ${allow ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground'}`
    }
    return `${base} text-muted-foreground hover:text-foreground`
  }

  return (
    <TooltipProvider delayDuration={200}>
      <RadioGroup.Root
        aria-label={label}
        value={value}
        onValueChange={(next) => onChange(next as ToolPermission)}
        orientation="horizontal"
        className="inline-flex shrink-0 gap-0.5 rounded-lg bg-muted p-0.5"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <RadioGroup.Item
              value="allow"
              aria-label={t('Always allow')}
              className={segment(value === 'allow', true)}
            >
              <CircleCheck className="size-3.5" aria-hidden />
            </RadioGroup.Item>
          </TooltipTrigger>
          <TooltipContent>{t('Always allow')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <RadioGroup.Item
              value="ask"
              aria-label={t('Require approval')}
              className={segment(value === 'ask', false)}
            >
              <Hand className="size-3.5" aria-hidden />
            </RadioGroup.Item>
          </TooltipTrigger>
          <TooltipContent>{t('Require approval')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <RadioGroup.Item
              value="block"
              aria-label={t('Block')}
              className={segment(value === 'block', false)}
            >
              <Ban className="size-3.5" aria-hidden />
            </RadioGroup.Item>
          </TooltipTrigger>
          <TooltipContent>{t('Block')}</TooltipContent>
        </Tooltip>
      </RadioGroup.Root>
    </TooltipProvider>
  )
}
