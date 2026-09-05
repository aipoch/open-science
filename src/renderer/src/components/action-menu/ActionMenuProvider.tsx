import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { PointerActionMenu } from './PointerActionMenu'
import {
  ActionMenuProviderContext,
  type ActionMenuProviderContextValue,
  type ActionMenuRegistration,
  type ActionMenuSnapshot,
  type OpenActionMenuOptions
} from './action-menu-context'
import { resolveActionMenuEntries, type ResolvedActionMenuEntry } from './action-menu-model'

type OpenActionMenuState = Readonly<{
  pointer: { x: number; y: number }
  snapshot: ActionMenuSnapshot
}>

type ActionErrorContext = Readonly<{
  targetId: string
  identityKey: string
  actionId: string
}>

const executionKey = (identityKey: string, actionId: string): string =>
  JSON.stringify([identityKey, actionId])

export const ActionMenuProvider = ({
  children,
  testId = 'action-menu',
  contentClassName,
  onOpenChange,
  onActionError
}: {
  children: ReactNode
  testId?: string
  contentClassName?: string
  onOpenChange?: (targetId: string, open: boolean) => void
  onActionError?: (error: unknown, context: ActionErrorContext) => void
}): React.JSX.Element => {
  const registrationsRef = useRef(new Map<string, ActionMenuRegistration>())
  const pendingKeysRef = useRef(new Set<string>())
  const focusTargetRef = useRef<HTMLElement | null>(null)
  const openStateRef = useRef<OpenActionMenuState | null>(null)
  const onOpenChangeRef = useRef(onOpenChange)
  const onActionErrorRef = useRef(onActionError)
  const [openState, setOpenState] = useState<OpenActionMenuState | null>(null)
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set())
  useLayoutEffect(() => {
    onOpenChangeRef.current = onOpenChange
    onActionErrorRef.current = onActionError
  }, [onActionError, onOpenChange])

  const closeMenu = useCallback((): void => {
    const current = openStateRef.current
    if (!current) return
    openStateRef.current = null
    setOpenState(null)
    onOpenChangeRef.current?.(current.snapshot.targetId, false)
  }, [])

  const registerTarget = useCallback(
    (registration: ActionMenuRegistration): (() => void) => {
      registrationsRef.current.set(registration.targetId, registration)
      return () => {
        if (registrationsRef.current.get(registration.targetId) !== registration) return
        registrationsRef.current.delete(registration.targetId)
        if (openStateRef.current?.snapshot.registrationKey === registration.registrationKey) {
          closeMenu()
        }
      }
    },
    [closeMenu]
  )

  const resolveEntries = useCallback(
    (snapshot: ActionMenuSnapshot): readonly ResolvedActionMenuEntry<string>[] =>
      resolveActionMenuEntries(snapshot.spec, snapshot.invocation).map((entry) =>
        entry.kind === 'action' && pendingKeys.has(executionKey(snapshot.identityKey, entry.action))
          ? { ...entry, disabled: true }
          : entry
      ),
    [pendingKeys]
  )

  const openSnapshot = useCallback(
    (
      registration: ActionMenuRegistration,
      invocation: unknown,
      pointer: { x: number; y: number },
      focusTarget?: Element | null
    ): boolean => {
      if (registrationsRef.current.get(registration.targetId) !== registration) return false
      const snapshot = registration.snapshot(invocation)
      if (
        !resolveActionMenuEntries(snapshot.spec, snapshot.invocation).some(
          (entry) => entry.kind === 'action'
        )
      ) {
        return false
      }

      focusTargetRef.current =
        focusTarget instanceof HTMLElement
          ? focusTarget
          : document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null
      const nextState = { pointer, snapshot }
      const previousTargetId = openStateRef.current?.snapshot.targetId
      if (previousTargetId && previousTargetId !== snapshot.targetId) {
        onOpenChangeRef.current?.(previousTargetId, false)
      }
      openStateRef.current = nextState
      setOpenState(nextState)
      onOpenChangeRef.current?.(snapshot.targetId, true)
      return true
    },
    []
  )

  const openFromEvent = useCallback(
    (registration: ActionMenuRegistration, event: React.MouseEvent<HTMLElement>): boolean => {
      const invocation = registration.resolveInvocation(event)
      if (invocation === null) return false
      return openSnapshot(
        registration,
        invocation,
        { x: event.clientX, y: event.clientY },
        document.activeElement
      )
    },
    [openSnapshot]
  )

  const openMenu = useCallback(
    <Invocation,>(options: OpenActionMenuOptions<Invocation>): boolean => {
      const registration = registrationsRef.current.get(options.targetId)
      if (!registration) return false
      const invocation = Object.prototype.hasOwnProperty.call(options, 'invocation')
        ? options.invocation
        : registration.defaultInvocation()
      return openSnapshot(registration, invocation, options.pointer, options.focusTarget)
    },
    [openSnapshot]
  )

  const execute = useCallback(
    async (snapshot: ActionMenuSnapshot, actionId: string): Promise<void> => {
      const entry = resolveActionMenuEntries(snapshot.spec, snapshot.invocation).find(
        (candidate) => candidate.kind === 'action' && candidate.action === actionId
      )
      if (!entry || entry.kind !== 'action' || entry.disabled) return
      const binding = snapshot.spec.bindings[actionId]
      if (!binding) return

      const key = executionKey(snapshot.identityKey, actionId)
      if (pendingKeysRef.current.has(key)) return
      pendingKeysRef.current.add(key)
      setPendingKeys((current) => new Set(current).add(key))
      try {
        await binding.execute(snapshot.invocation)
      } catch (error) {
        const context = {
          targetId: snapshot.targetId,
          identityKey: snapshot.identityKey,
          actionId
        }
        if (onActionErrorRef.current) onActionErrorRef.current(error, context)
        else
          console.error(`Failed to execute action ${actionId} for ${snapshot.identityKey}`, error)
      } finally {
        pendingKeysRef.current.delete(key)
        setPendingKeys((current) => {
          if (!current.has(key)) return current
          const next = new Set(current)
          next.delete(key)
          return next
        })
      }
    },
    []
  )

  const restoreFocus = useCallback((snapshot: ActionMenuSnapshot): void => {
    const focusTarget = focusTargetRef.current
    focusTargetRef.current = null
    if (!focusTarget) return
    const restoreDefault = (): void => {
      if (focusTarget.isConnected) focusTarget.focus()
    }
    if (snapshot.restoreFocus) snapshot.restoreFocus(restoreDefault)
    else restoreDefault()
  }, [])

  const contextValue = useMemo<ActionMenuProviderContextValue>(
    () => ({ registerTarget, openFromEvent, openMenu, closeMenu, resolveEntries, execute }),
    [closeMenu, execute, openFromEvent, openMenu, registerTarget, resolveEntries]
  )

  return (
    <ActionMenuProviderContext.Provider value={contextValue}>
      {children}
      {openState ? (
        <PointerActionMenu
          entries={resolveEntries(openState.snapshot)}
          pointer={openState.pointer}
          testId={testId}
          contentClassName={contentClassName}
          compact={openState.snapshot.compact}
          dangerClassName={openState.snapshot.dangerClassName}
          renderLabel={openState.snapshot.renderLabel}
          onSelect={(actionId) => {
            closeMenu()
            void execute(openState.snapshot, actionId)
          }}
          onClose={closeMenu}
          onRestoreFocus={() => restoreFocus(openState.snapshot)}
        />
      ) : null}
    </ActionMenuProviderContext.Provider>
  )
}
