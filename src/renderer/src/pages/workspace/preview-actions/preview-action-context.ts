import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'

import { isPreviewContextMenuRequest } from '../../../../../shared/preview-context-menu'

import {
  resolvePreviewMenuEntries,
  type PreviewActionBindings,
  type PreviewCapabilityId,
  type PreviewMenuRecipeEntry,
  type ResolvedPreviewMenuEntry
} from './preview-action-model'

export type PreviewActionHost = {
  entries: readonly ResolvedPreviewMenuEntry[]
  contextMenu: { pointer: { x: number; y: number } } | null
  execute: (capability: PreviewCapabilityId) => void
  registerFrame: (registration: PreviewContextMenuFrameRegistration) => () => void
  openContextMenu: (pointer: { x: number; y: number }, focusTarget?: Element | null) => void
  closeContextMenu: () => void
  restoreContextMenuFocus: () => void
}

type PreviewContextMenuFrameRegistration = Readonly<{
  id: string
  frameUrl: string
  getFrame: () => HTMLIFrameElement | null
}>

type PreviewActionHostInput = {
  identityKey: string
  recipe: readonly PreviewMenuRecipeEntry[]
  bindings: PreviewActionBindings
}

type PreviewContextMenuState = Readonly<{
  identity: Readonly<{ key: string }>
  pointer: { x: number; y: number }
}>

const matchesRegisteredFrame = (registeredUrl: string, requestedUrl: string): boolean => {
  try {
    const registered = new URL(registeredUrl)
    const requested = new URL(requestedUrl)
    // A managed HTML hostname is the resource capability; same-document navigation may change
    // the remaining URL. Office URLs carry a session capability and therefore stay exact.
    if (registered.protocol === 'open-science-preview:') {
      return (
        requested.protocol === registered.protocol && requested.hostname === registered.hostname
      )
    }
    return requestedUrl === registeredUrl
  } catch {
    return false
  }
}

export const PreviewActionContext = createContext<PreviewActionHost | null>(null)

export const usePreviewActionHost = ({
  identityKey,
  recipe,
  bindings
}: PreviewActionHostInput): PreviewActionHost => {
  const [executingCapabilities, setExecutingCapabilities] = useState(
    () => new Set<PreviewCapabilityId>()
  )
  const [contextMenuState, setContextMenuState] = useState<PreviewContextMenuState | null>(null)
  // A new token invalidates the prior menu immediately and prevents A → B → A from reviving it.
  const contextMenuIdentity = useMemo(() => ({ key: identityKey }), [identityKey])
  const frameRegistrationsRef = useRef(new Map<string, PreviewContextMenuFrameRegistration>())
  const contextMenuFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    contextMenuFocusRef.current = null
  }, [identityKey])

  const registerFrame = useCallback(
    (registration: PreviewContextMenuFrameRegistration): (() => void) => {
      frameRegistrationsRef.current.set(registration.id, registration)
      return () => {
        if (frameRegistrationsRef.current.get(registration.id) === registration) {
          frameRegistrationsRef.current.delete(registration.id)
        }
      }
    },
    []
  )

  const resolvedState = useMemo(() => {
    const combinedBindings: PreviewActionBindings = { ...bindings }
    for (const capability of executingCapabilities) {
      const binding = combinedBindings[capability]
      if (binding) combinedBindings[capability] = { ...binding, disabled: true }
    }
    return {
      entries: resolvePreviewMenuEntries(recipe, combinedBindings),
      bindings: combinedBindings
    }
  }, [bindings, executingCapabilities, recipe])

  const execute = useCallback(
    (capability: PreviewCapabilityId): void => {
      const entry = resolvedState.entries.find(
        (candidate) => candidate.kind === 'action' && candidate.capability === capability
      )
      const binding = resolvedState.bindings[capability]
      if (!entry || entry.kind !== 'action' || entry.disabled || !binding) return

      setExecutingCapabilities((current) => new Set(current).add(capability))
      let execution: Promise<void>
      try {
        execution = Promise.resolve(binding.execute()).then(() => undefined)
      } catch (error) {
        execution = Promise.reject(error)
      }
      void execution
        .catch((error: unknown) => {
          console.error(
            `Failed to execute preview capability ${capability} for ${identityKey}`,
            error
          )
        })
        .finally(() => {
          setExecutingCapabilities((current) => {
            const next = new Set(current)
            next.delete(capability)
            return next
          })
        })
    },
    [identityKey, resolvedState.bindings, resolvedState.entries]
  )

  const openContextMenu = useCallback(
    (pointer: { x: number; y: number }, focusTarget?: Element | null): void => {
      if (!resolvedState.entries.some((entry) => entry.kind === 'action')) return
      contextMenuFocusRef.current =
        focusTarget instanceof HTMLElement
          ? focusTarget
          : document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null
      setContextMenuState({ identity: contextMenuIdentity, pointer })
    },
    [contextMenuIdentity, resolvedState.entries]
  )
  const closeContextMenu = useCallback((): void => setContextMenuState(null), [])
  const restoreContextMenuFocus = useCallback((): void => {
    contextMenuFocusRef.current?.focus()
    contextMenuFocusRef.current = null
  }, [])

  useEffect(() => {
    const subscribe = window.api.previewContextMenu?.onRequested
    if (!subscribe) return

    return subscribe((request) => {
      if (!isPreviewContextMenuRequest(request)) return

      const registrations = [...frameRegistrationsRef.current.values()]
      for (let index = registrations.length - 1; index >= 0; index -= 1) {
        const registration = registrations[index]
        if (!matchesRegisteredFrame(registration.frameUrl, request.frameUrl)) continue
        const frame = registration.getFrame()
        if (!frame?.isConnected) continue
        // Electron already reports child-frame clicks in host viewport coordinates. Registration
        // identifies the matching iframe and focus target; applying its bounds would double-offset.
        openContextMenu({ x: request.x, y: request.y }, frame)
        return
      }
    })
  }, [openContextMenu])

  const contextMenu = contextMenuState?.identity === contextMenuIdentity ? contextMenuState : null

  return useMemo(
    () => ({
      entries: resolvedState.entries,
      contextMenu,
      execute,
      registerFrame,
      openContextMenu,
      closeContextMenu,
      restoreContextMenuFocus
    }),
    [
      closeContextMenu,
      contextMenu,
      execute,
      openContextMenu,
      registerFrame,
      resolvedState.entries,
      restoreContextMenuFocus
    ]
  )
}

export const usePreviewActions = (): PreviewActionHost => {
  const host = useContext(PreviewActionContext)
  if (!host) throw new Error('Preview actions must be used inside PreviewActionContext.Provider.')
  return host
}

export const useRegisterPreviewContextMenuFrame = ({
  id,
  frameUrl,
  frameRef,
  enabled = true
}: {
  id: string
  frameUrl: string
  frameRef: RefObject<HTMLIFrameElement | null>
  enabled?: boolean
}): void => {
  const host = useContext(PreviewActionContext)
  useEffect(() => {
    if (!host || !enabled || !frameUrl) return
    return host.registerFrame({ id, frameUrl, getFrame: () => frameRef.current })
  }, [enabled, frameRef, frameUrl, host, id])
}
