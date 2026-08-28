import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'

const PANEL_EXPAND_TRANSITION = { duration: 0.2, ease: [0.22, 1, 0.36, 1] } as const
const PANEL_REDUCED_TRANSITION = { duration: 0.12, ease: 'linear' } as const

type WorkspaceCollapsiblePanelProps = {
  isOpen: boolean
  children: ReactNode
}

// Exiting panels stay mounted for the exit tween while the trigger's aria-expanded has already
// flipped, so hide them from AT, remove them from the tab order, and drop pointer input
// (same useIsPresent guard as PermissionUndoSnackbar's UndoItemPresence).
const CollapsiblePanelPresence = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const isPresent = useIsPresent()
  const shouldReduceMotion = useReducedMotion()

  return (
    <motion.div
      aria-hidden={isPresent ? undefined : true}
      inert={isPresent ? undefined : true}
      initial={shouldReduceMotion ? false : { height: 0, opacity: 0 }}
      animate={{
        height: 'auto',
        opacity: 1,
        transition: shouldReduceMotion ? PANEL_REDUCED_TRANSITION : PANEL_EXPAND_TRANSITION
      }}
      exit={
        shouldReduceMotion
          ? { opacity: 0, transition: PANEL_REDUCED_TRANSITION }
          : { height: 0, opacity: 0, transition: PANEL_EXPAND_TRANSITION }
      }
      className="overflow-hidden"
      style={{ pointerEvents: isPresent ? 'auto' : 'none' }}
    >
      {children}
    </motion.div>
  )
}

// Shared expand/collapse animation for tool activity surfaces: height + opacity tween with a
// reduced-motion opacity-only fallback. Callers keep id/testid/className on their inner element
// so margins and padding never jump mid-animation.
const WorkspaceCollapsiblePanel = ({
  isOpen,
  children
}: WorkspaceCollapsiblePanelProps): React.JSX.Element => (
  <AnimatePresence initial={false}>
    {isOpen ? <CollapsiblePanelPresence key="panel">{children}</CollapsiblePanelPresence> : null}
  </AnimatePresence>
)

export { WorkspaceCollapsiblePanel }
