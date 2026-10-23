import type { ReactNode } from 'react'
import type { ActionMenuLabelRenderer } from './ActionMenuItems'
import type { ResolvedActionMenuEntry } from './action-menu-model'

export type PointerActionMenuProps<ActionId extends string> = {
  entries: readonly ResolvedActionMenuEntry<ActionId>[]
  pointer: { x: number; y: number }
  testId: string
  side?: 'right' | 'bottom'
  align?: 'start' | 'end'
  focusFirst?: boolean
  header?: ReactNode
  label?: string
  sections?: Record<string, string>
  contentClassName?: string
  compact?: boolean
  dangerClassName?: string
  renderLabel?: ActionMenuLabelRenderer<ActionId>
  onSelect: (actionId: ActionId) => void
  onClose: () => void
  onRestoreFocus: () => void
}
