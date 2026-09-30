import {
  useEffect,
  useRef,
  type ComponentProps,
  type ComponentPropsWithoutRef,
  type RefObject,
  type ReactElement,
  type SyntheticEvent
} from 'react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

// One delay/skip-delay context for every text and attachment hint in the table.
export function LiteratureTable(props: ComponentProps<'table'>): React.JSX.Element {
  return (
    <TooltipProvider skipDelayDuration={300}>
      <table {...props} />
    </TooltipProvider>
  )
}

export function LiteratureTableScrollArea({
  children,
  viewportRef,
  className,
  ...props
}: ComponentPropsWithoutRef<'div'> & {
  viewportRef?: RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const internalViewport = useRef<HTMLDivElement>(null)
  const viewport = viewportRef ?? internalViewport
  useEffect(() => {
    const element = viewport.current!
    const update = (): void => {
      const overflow = String(element.scrollWidth - element.clientWidth - element.scrollLeft > 1)
      if (element.dataset.overflowRight !== overflow) element.dataset.overflowRight = overflow
    }
    update()
    element.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => {
      observer.disconnect()
      element.removeEventListener('scroll', update)
    }
  }, [viewport])
  return (
    <div
      {...props}
      ref={viewport}
      className={cn(
        'group/journal-scroll min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]',
        className
      )}
    >
      {children}
    </div>
  )
}

export function LiteratureTextTooltip({
  text,
  children,
  overflowOnly = false
}: {
  text?: string
  overflowOnly?: boolean
  children: ReactElement
}): React.JSX.Element {
  if (!text) return children
  const guardOverflow = (event: SyntheticEvent<HTMLElement>): void => {
    if (!overflowOnly) return
    // Badges can truncate inside the trigger even when the trigger itself fits.
    const elements = [event.currentTarget, ...event.currentTarget.querySelectorAll('*')]
    const truncated = elements.some(
      (element) =>
        (element.clientWidth > 0 && element.scrollWidth > element.clientWidth) ||
        (element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 1)
    )
    if (!truncated) event.preventDefault()
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild onPointerMove={guardOverflow} onFocus={guardOverflow}>
        {children}
      </TooltipTrigger>
      <TooltipContent className="max-h-[min(24rem,calc(100vh-2rem))] max-w-[min(36rem,calc(100vw-1rem))] overflow-y-auto bg-black text-white leading-relaxed">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}
