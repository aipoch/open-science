import type { ComponentProps, ReactElement } from 'react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

// One delay/skip-delay context for every text and attachment hint in the table.
export function LiteratureTable(props: ComponentProps<'table'>): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={300} skipDelayDuration={0}>
      <table {...props} />
    </TooltipProvider>
  )
}

export function LiteratureTextTooltip({
  text,
  children
}: {
  text?: string
  children: ReactElement
}): React.JSX.Element {
  if (!text) return children
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="max-h-[min(24rem,calc(100vh-2rem))] max-w-[min(36rem,calc(100vw-1rem))] overflow-y-auto bg-black text-white leading-relaxed">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}
