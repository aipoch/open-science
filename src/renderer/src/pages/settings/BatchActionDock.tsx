/* Hallmark · pre-emit critique: P4 H4 E4 S5 R5 V3
 * component: batch action dock · genre: modern-minimal · theme: Open-Science
 * States inherit shared controls and owner-provided loading/error/success feedback.
 */
import type { ComponentProps, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** Shared presentation only: each page retains its batch workflow and focus owner. */
export function BatchActionDock({
  children,
  className,
  ...props
}: ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      {...props}
      className={cn('relative mx-5 mb-5 flex max-h-[50%] min-h-0 shrink-0 flex-col', className)}
    >
      <div
        aria-hidden="true"
        data-slot="batch-dock-fade"
        className="pointer-events-none absolute -top-8 -right-5 -left-5 h-8 bg-gradient-to-t from-background to-background/0"
      />
      <div className="relative min-h-0 overflow-y-auto rounded-lg border border-border bg-background p-3 shadow-sm [&_button.bg-primary:hover]:bg-primary/90 [&_button:focus-visible]:transition-none [@media(pointer:coarse)]:[&_button]:min-h-11">
        {children}
      </div>
    </div>
  )
}

export function BatchSelectionActions({
  selectedCount,
  disabled,
  onClear,
  children
}: {
  selectedCount: number
  disabled: boolean
  onClear: () => void
  children: ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-3 sm:gap-x-6">
      <div className="mr-auto flex shrink-0 items-center gap-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                className="[@media(pointer:coarse)]:min-w-11"
                variant="ghost"
                disabled={disabled}
                onClick={onClear}
                aria-label={t('Clear selection')}
              >
                <X aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('Clear selection')}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <span role="status" className="text-sm font-medium whitespace-nowrap tabular-nums">
          {t('{{selectedCount}} selected', { selectedCount })}
        </span>
      </div>
      {children}
    </div>
  )
}
