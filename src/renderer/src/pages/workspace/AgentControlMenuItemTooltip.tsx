import {
  createContext,
  useContext,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement
} from 'react'

import { resolveAgentControlTooltipSide, type TooltipSide } from './agent-control-tooltip-side'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { DropdownMenuContent } from '@/components/ui/dropdown-menu'

type AgentControlMenuItemTooltipProps = {
  children: ReactElement
  description: string
  submenu?: boolean
}

const AgentControlMenuTooltipBoundaryContext = createContext<HTMLElement | null>(null)

const AgentControlMenuContent = ({
  boundary,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuContent> & {
  boundary: HTMLElement | null
}): React.JSX.Element => (
  <TooltipProvider delayDuration={300}>
    <AgentControlMenuTooltipBoundaryContext.Provider value={boundary}>
      <DropdownMenuContent {...props}>{children}</DropdownMenuContent>
    </AgentControlMenuTooltipBoundaryContext.Provider>
  </TooltipProvider>
)

// Keeps agent controls compact while preserving their explanatory copy on hover and keyboard
// focus. Callers keep standing-disabled rows focusable with aria-disabled and neutralized selection.
const AgentControlMenuItemTooltip = ({
  children,
  description,
  submenu = false
}: AgentControlMenuItemTooltipProps): React.JSX.Element => {
  const collisionBoundary = useContext(AgentControlMenuTooltipBoundaryContext)
  const preferredSide = submenu ? 'left' : 'right'
  // Radix types TooltipTrigger as a button even with asChild; every concrete trigger used here
  // still exposes the HTMLElement geometry required below.
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [resolvedSide, setResolvedSide] = useState<TooltipSide>(submenu ? 'top' : preferredSide)

  const updateSide = (): void => {
    if (!collisionBoundary || !triggerRef.current) {
      setResolvedSide(submenu ? 'top' : preferredSide)
      return
    }
    setResolvedSide(
      resolveAgentControlTooltipSide(
        preferredSide,
        triggerRef.current.getBoundingClientRect(),
        collisionBoundary.getBoundingClientRect(),
        !submenu
      )
    )
  }

  const handleFocus = (event: React.FocusEvent<HTMLButtonElement>): void => {
    updateSide()
    if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild ref={triggerRef} onPointerEnter={updateSide} onFocus={handleFocus}>
        {children}
      </TooltipTrigger>
      <TooltipContent
        side={resolvedSide}
        sideOffset={8}
        collisionBoundary={collisionBoundary ?? undefined}
        collisionPadding={8}
        sticky="always"
        className="max-w-72 text-[11px] leading-4"
      >
        {description}
      </TooltipContent>
    </Tooltip>
  )
}

export { AgentControlMenuContent, AgentControlMenuItemTooltip }
