// Passive transcript presentation shared by Workspace, Provenance and archived replay.
import type { ComponentProps, ReactNode, Ref } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'
import { WorkspaceCollapsiblePanel } from './WorkspaceCollapsiblePanel'

const userMessageBubbleClassName =
  'max-w-[90%] break-words rounded-2xl bg-bg-300 px-3.5 py-2 text-sm text-message-user-text md:max-w-[min(85%,56rem)] md:px-4 md:py-2.5 md:text-[15px]'

const assistantMessageSurfaceClassName =
  'relative w-full max-w-[56rem] text-sm leading-relaxed text-text-000 md:text-[15px]'

export const WorkspaceMessageTimestamp = ({
  label,
  date
}: {
  // Already-resolved copy: the caller owns which of sent/completed/failed applies.
  label: string
  date: Date
}): React.JSX.Element => {
  const formatDate = useDateTimeFormat()

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          dateTime={date.toISOString()}
          tabIndex={0}
          className="rounded-sm focus-visible:keyboard-focus"
        >
          {label} {formatDate(date)}
        </time>
      </TooltipTrigger>
      <TooltipContent>{formatDate(date, 'full')}</TooltipContent>
    </Tooltip>
  )
}

export const WorkspaceUserMessageBubble = ({
  className,
  ...props
}: ComponentProps<'div'>): React.JSX.Element => (
  <div
    data-slot="user-message-bubble"
    className={cn(userMessageBubbleClassName, className)}
    {...props}
  />
)
export const WorkspaceAssistantMessageSurface = ({
  className,
  ...props
}: ComponentProps<'div'>): React.JSX.Element => (
  <div className={cn(assistantMessageSurfaceClassName, className)} {...props} />
)

export const WorkspaceActivityGroupSurface = ({
  title,
  meta,
  isExpanded,
  onToggle,
  animate = true,
  children,
  ref
}: {
  title: ReactNode
  meta: ReactNode
  isExpanded: boolean
  onToggle: () => void
  animate?: boolean
  children: ReactNode
  ref?: Ref<HTMLDivElement>
}): React.JSX.Element => (
  <div
    ref={ref}
    className="w-full overflow-hidden rounded-[14px] bg-bg-200/70 px-1.5 py-1"
    data-testid="tool-group"
  >
    <button
      type="button"
      aria-expanded={isExpanded}
      data-testid="tool-group-header"
      className="flex w-full items-center gap-2 rounded-lg py-[5px] pl-1.5 pr-2.5 text-[13px] transition-colors hover:bg-bg-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      onClick={onToggle}
    >
      <span
        className={cn(
          'inline-flex w-4 shrink-0 items-center justify-center text-text-100 transition-transform duration-200',
          isExpanded ? 'rotate-90' : undefined
        )}
      >
        <ChevronRight className="size-3.5" strokeWidth={2.2} aria-hidden="true" />
      </span>
      <span className="min-w-0 truncate text-left font-medium text-text-000">{title}</span>
      <span className="ml-auto shrink-0 whitespace-nowrap text-[12px] tabular-nums text-text-000">
        {meta}
      </span>
    </button>
    {animate ? (
      <WorkspaceCollapsiblePanel isOpen={isExpanded}>{children}</WorkspaceCollapsiblePanel>
    ) : isExpanded ? (
      children
    ) : null}
  </div>
)
