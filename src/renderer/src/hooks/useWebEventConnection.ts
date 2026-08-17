import { useEffect, useState } from 'react'

import {
  WEB_EVENT_CONNECTION_STATE_EVENT,
  WEB_EVENT_CONSUMERS_READY_EVENT,
  WEB_EVENT_SURFACE_ATTRIBUTE,
  type WebEventConnectionPhase,
  type WebEventConnectionState
} from '../../../shared/web-event-connection'

const useWebEventConnection = (consumersReady: boolean): WebEventConnectionPhase => {
  const isWebEventSurface =
    document.documentElement.getAttribute(WEB_EVENT_SURFACE_ATTRIBUTE) === 'true'
  const [phase, setPhase] = useState<WebEventConnectionPhase>(() =>
    isWebEventSurface ? 'connecting' : 'live'
  )

  useEffect(() => {
    if (!isWebEventSurface) return
    const handleState = (event: Event): void => {
      setPhase((event as CustomEvent<WebEventConnectionState>).detail.phase)
    }
    window.addEventListener(WEB_EVENT_CONNECTION_STATE_EVENT, handleState)
    return () => window.removeEventListener(WEB_EVENT_CONNECTION_STATE_EVENT, handleState)
  }, [isWebEventSurface])

  useEffect(() => {
    if (!isWebEventSurface || !consumersReady) return
    const timeout = window.setTimeout(() => {
      window.dispatchEvent(new Event(WEB_EVENT_CONSUMERS_READY_EVENT))
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [consumersReady, isWebEventSurface])

  return phase
}

export { useWebEventConnection }
