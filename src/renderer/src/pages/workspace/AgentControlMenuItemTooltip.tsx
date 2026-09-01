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
  disabled?: boolean
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
  <AgentControlMenuTooltipBoundaryContext.Provider value={boundary}>
    <DropdownMenuContent {...props}>{children}</DropdownMenuContent>
  </AgentControlMenuTooltipBoundaryContext.Provider>
)

// Keeps agent controls compact while preserving their explanatory copy on hover and keyboard
// focus. Disabled Radix menu items use pointer-events: none, so they get an outer hover target that
// does not change the item's disabled selection semantics.
const AgentControlMenuItemTooltip = ({
  children,
  description,
  disabled = false,
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

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        {disabled ? (
          <TooltipTrigger asChild ref={triggerRef} onPointerEnter={updateSide} onFocus={updateSide}>
            <div className="rounded-lg">{children}</div>
          </TooltipTrigger>
        ) : (
          <TooltipTrigger asChild ref={triggerRef} onPointerEnter={updateSide} onFocus={updateSide}>
            {children}
          </TooltipTrigger>
        )}
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
    </TooltipProvider>
  )
}

export { AgentControlMenuContent, AgentControlMenuItemTooltip }
