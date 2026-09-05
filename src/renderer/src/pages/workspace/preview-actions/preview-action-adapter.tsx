import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'

import { useActionMenu } from '@/components/action-menu'
import { isPreviewContextMenuRequest } from '../../../../../shared/preview-context-menu'

import {
  PreviewActionMenuAdapterContext,
  type PreviewContextMenuFrameRegistration
} from './preview-action-adapter-context'

const matchesRegisteredFrame = (registeredUrl: string, requestedUrl: string): boolean => {
  try {
    const registered = new URL(registeredUrl)
    const requested = new URL(requestedUrl)
    // Managed HTML URLs identify a resource by hostname; Office URLs identify an exact session.
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

export const PreviewActionMenuAdapterProvider = ({
  targetId,
  children
}: {
  targetId: string
  children: ReactNode
}): React.JSX.Element => {
  const { openMenu } = useActionMenu()
  const frameRegistrationsRef = useRef(new Map<string, PreviewContextMenuFrameRegistration>())

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

  const openContextMenu = useCallback(
    (pointer: { x: number; y: number }, focusTarget?: Element | null): void => {
      openMenu({ targetId, pointer, focusTarget })
    },
    [openMenu, targetId]
  )

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
        // Electron already reports child-frame clicks in host viewport coordinates.
        openContextMenu({ x: request.x, y: request.y }, frame)
        return
      }
    })
  }, [openContextMenu])

  const value = useMemo(
    () => ({ openContextMenu, registerFrame }),
    [openContextMenu, registerFrame]
  )
  return (
    <PreviewActionMenuAdapterContext.Provider value={value}>
      {children}
    </PreviewActionMenuAdapterContext.Provider>
  )
}
