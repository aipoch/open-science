import {
  forwardRef,
  useLayoutEffect,
  useMemo,
  useRef,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  type Ref
} from 'react'
import { Slot } from 'radix-ui'

import type { ActionMenuLabelRenderer } from './ActionMenuItems'
import {
  ActionMenuTargetContext,
  useActionMenuProviderContext,
  type ActionMenuRegistration,
  type ActionMenuSnapshot,
  type ActionMenuTargetController
} from './action-menu-context'
import type { ActionMenuSpec } from './action-menu-model'

type ActionMenuTargetProps<ActionId extends string, Invocation> = ActionMenuSpec<
  ActionId,
  Invocation
> &
  Omit<HTMLAttributes<HTMLElement>, 'children'> & {
    targetId: string
    invocation: Invocation
    resolveInvocation?: (
      event: React.MouseEvent<HTMLElement>,
      invocation: Invocation
    ) => Invocation | null
    compact?: boolean
    dangerClassName?: string
    renderLabel?: ActionMenuLabelRenderer<ActionId>
    onRestoreFocus?: (restoreDefault: () => void) => void
    asChild: true
    children: ReactElement
  }

type CurrentTarget<ActionId extends string, Invocation> = {
  spec: ActionMenuSpec<ActionId, Invocation>
  invocation: Invocation
  resolveInvocation?: ActionMenuTargetProps<ActionId, Invocation>['resolveInvocation']
  compact: boolean
  dangerClassName?: string
  renderLabel?: ActionMenuLabelRenderer<ActionId>
  restoreFocus?: (restoreDefault: () => void) => void
}

const ActionMenuTargetInner = <ActionId extends string, Invocation>(
  {
    targetId,
    identityKey,
    catalog,
    recipe,
    bindings,
    invocation,
    resolveInvocation,
    compact = true,
    dangerClassName,
    renderLabel,
    onRestoreFocus,
    asChild,
    children,
    onContextMenu,
    ...slotProps
  }: ActionMenuTargetProps<ActionId, Invocation>,
  forwardedRef: Ref<HTMLElement>
): React.JSX.Element => {
  if (!asChild) throw new Error('ActionMenuTarget requires asChild.')

  const provider = useActionMenuProviderContext()
  const current = useMemo<CurrentTarget<ActionId, Invocation>>(
    () => ({
      spec: { identityKey, catalog, recipe, bindings },
      invocation,
      resolveInvocation,
      compact,
      dangerClassName,
      renderLabel,
      restoreFocus: onRestoreFocus
    }),
    [
      bindings,
      catalog,
      compact,
      dangerClassName,
      identityKey,
      invocation,
      onRestoreFocus,
      recipe,
      renderLabel,
      resolveInvocation
    ]
  )
  const currentRef = useRef(current)
  useLayoutEffect(() => {
    currentRef.current = current
  }, [current])
  const registrationKey = useMemo(
    () => Symbol(`${targetId}:${identityKey}`),
    [identityKey, targetId]
  )

  const registration = useMemo<ActionMenuRegistration>(
    () => ({
      targetId,
      identityKey,
      registrationKey,
      defaultInvocation: () => currentRef.current!.invocation,
      resolveInvocation: (event) => {
        const current = currentRef.current!
        return current.resolveInvocation
          ? current.resolveInvocation(event, current.invocation)
          : current.invocation
      },
      snapshot: (capturedInvocation): ActionMenuSnapshot => {
        const current = currentRef.current!
        return {
          targetId,
          identityKey,
          registrationKey,
          spec: current.spec as unknown as ActionMenuSpec<string, unknown>,
          invocation: capturedInvocation,
          compact: current.compact,
          dangerClassName: current.dangerClassName,
          renderLabel: current.renderLabel as ActionMenuLabelRenderer<string> | undefined,
          restoreFocus: current.restoreFocus
        }
      }
    }),
    [identityKey, registrationKey, targetId]
  )

  const { registerTarget } = provider
  useLayoutEffect(() => registerTarget(registration), [registerTarget, registration])

  const snapshot = useMemo<ActionMenuSnapshot>(
    () => ({
      targetId,
      identityKey,
      registrationKey,
      spec: { identityKey, catalog, recipe, bindings } as unknown as ActionMenuSpec<
        string,
        unknown
      >,
      invocation,
      compact,
      dangerClassName,
      renderLabel: renderLabel as ActionMenuLabelRenderer<string> | undefined,
      restoreFocus: onRestoreFocus
    }),
    [
      bindings,
      catalog,
      compact,
      dangerClassName,
      identityKey,
      invocation,
      onRestoreFocus,
      recipe,
      registrationKey,
      renderLabel,
      targetId
    ]
  )
  const controller = useMemo<ActionMenuTargetController<ActionId>>(
    () => ({
      entries: provider.resolveEntries(snapshot) as ReturnType<
        typeof provider.resolveEntries
      > as ActionMenuTargetController<ActionId>['entries'],
      execute: (actionId) =>
        provider.execute(registration.snapshot(currentRef.current!.invocation), actionId),
      renderLabel
    }),
    [provider, registration, renderLabel, snapshot]
  )

  return (
    <ActionMenuTargetContext.Provider value={controller as unknown as ActionMenuTargetController}>
      <Slot.Root
        {...slotProps}
        ref={forwardedRef}
        onContextMenu={(event) => {
          onContextMenu?.(event)
          if (event.defaultPrevented) return
          if (provider.openFromEvent(registration, event)) event.preventDefault()
        }}
      >
        {children as ReactNode}
      </Slot.Root>
    </ActionMenuTargetContext.Provider>
  )
}

type ActionMenuTargetComponent = <ActionId extends string, Invocation>(
  props: ActionMenuTargetProps<ActionId, Invocation> & { ref?: Ref<HTMLElement> }
) => ReactElement

export const ActionMenuTarget = forwardRef(ActionMenuTargetInner) as ActionMenuTargetComponent
export type { ActionMenuTargetProps }
