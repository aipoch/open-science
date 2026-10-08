import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export function PdfTranslationActionHint({
  reason,
  children,
  className
}: {
  reason?: string
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            role={reason ? 'group' : undefined}
            tabIndex={reason ? 0 : undefined}
            aria-label={reason}
            aria-disabled={reason ? true : undefined}
            className={cn(
              'inline-flex min-w-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring [&_:disabled]:pointer-events-none',
              reason && 'cursor-not-allowed',
              className
            )}
          >
            {children}
          </div>
        </TooltipTrigger>
        {reason ? (
          <TooltipContent
            className="z-[140] max-w-64"
            onEscapeKeyDown={(event) => event.stopPropagation()}
          >
            {reason}
          </TooltipContent>
        ) : null}
      </Tooltip>
    </TooltipProvider>
  )
}
