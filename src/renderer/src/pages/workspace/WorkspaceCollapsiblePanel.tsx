import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

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
  const contentRef = useRef<HTMLDivElement>(null)
  // Measuring the content box lets the panel tween its height whenever INNER disclosures
  // (tool input/output <details>, late-loading figures) resize it after the enter animation
  // finished — not just on mount/unmount. Skipped under reduced motion (instant 'auto').
  const [contentHeight, setContentHeight] = useState<number | null>(null)

  useEffect(() => {
    const content = contentRef.current
    if (!content || shouldReduceMotion) return undefined
    const observer = new ResizeObserver((entries) => {
      const boxSize = entries[0]?.borderBoxSize?.[0]
      setContentHeight(boxSize ? boxSize.blockSize : content.offsetHeight)
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [shouldReduceMotion])

  const transition = shouldReduceMotion ? PANEL_REDUCED_TRANSITION : PANEL_EXPAND_TRANSITION

  return (
    <motion.div
      aria-hidden={isPresent ? undefined : true}
      inert={isPresent ? undefined : true}
      initial={shouldReduceMotion ? false : { height: 0, opacity: 0 }}
      animate={{
        height: shouldReduceMotion ? 'auto' : (contentHeight ?? 'auto'),
        opacity: 1,
        transition
      }}
      exit={shouldReduceMotion ? { opacity: 0, transition } : { height: 0, opacity: 0, transition }}
      className="overflow-hidden"
      style={{ pointerEvents: isPresent ? 'auto' : 'none' }}
    >
      {/* flow-root keeps the caller's margins inside the measured box so the px tween matches
          the 'auto' height exactly (motion.div's overflow-hidden already establishes a BFC). */}
      <div ref={contentRef} className="flow-root">
        {children}
      </div>
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
