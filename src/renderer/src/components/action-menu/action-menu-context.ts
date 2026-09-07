import { createContext, useContext } from 'react'

import type { ActionMenuLabelRenderer } from './ActionMenuItems'
import type { ActionMenuSpec, ResolvedActionMenuEntry } from './action-menu-model'

export type ActionMenuPointer = Readonly<{ x: number; y: number }>

export type ActionMenuSnapshot = Readonly<{
  targetId: string
  identityKey: string
  registrationKey: symbol
  spec: ActionMenuSpec<string, unknown>
  invocation: unknown
  compact: boolean
  dangerClassName?: string
  renderLabel?: ActionMenuLabelRenderer<string>
  restoreFocus?: (restoreDefault: () => void) => void
}>

export type ActionMenuRegistration = Readonly<{
  targetId: string
  identityKey: string
  registrationKey: symbol
  snapshot: (invocation: unknown) => ActionMenuSnapshot
  defaultInvocation: () => unknown
  resolveInvocation: (event: React.MouseEvent<HTMLElement>) => unknown | null
}>

export type OpenActionMenuOptions<Invocation = unknown> = {
  targetId: string
  pointer: ActionMenuPointer
  focusTarget?: Element | null
  invocation?: Invocation
}

export type ActionMenuProviderContextValue = {
  registerTarget: (registration: ActionMenuRegistration) => () => void
  openFromEvent: (
    registration: ActionMenuRegistration,
    event: React.MouseEvent<HTMLElement>
  ) => boolean
  openMenu: <Invocation>(options: OpenActionMenuOptions<Invocation>) => boolean
  closeMenu: () => void
  resolveEntries: (snapshot: ActionMenuSnapshot) => readonly ResolvedActionMenuEntry<string>[]
  execute: (snapshot: ActionMenuSnapshot, actionId: string) => Promise<void>
}

export type ActionMenuTargetController<ActionId extends string = string> = {
  entries: readonly ResolvedActionMenuEntry<ActionId>[]
  execute: (actionId: ActionId) => Promise<void>
  renderLabel?: ActionMenuLabelRenderer<ActionId>
}

export const ActionMenuProviderContext = createContext<ActionMenuProviderContextValue | null>(null)
export const ActionMenuTargetContext = createContext<ActionMenuTargetController | null>(null)

export const useActionMenuProviderContext = (): ActionMenuProviderContextValue => {
  const value = useContext(ActionMenuProviderContext)
  if (!value) throw new Error('Action Menu must be used inside ActionMenuProvider.')
  return value
}

export const useActionMenu = (): Pick<ActionMenuProviderContextValue, 'openMenu' | 'closeMenu'> => {
  const { openMenu, closeMenu } = useActionMenuProviderContext()
  return { openMenu, closeMenu }
}

export const useActionMenuTarget = <
  ActionId extends string
>(): ActionMenuTargetController<ActionId> => {
  const value = useContext(ActionMenuTargetContext)
  if (!value) throw new Error('Action Menu target controls must be used inside ActionMenuTarget.')
  return value as unknown as ActionMenuTargetController<ActionId>
}
