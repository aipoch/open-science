import { useSyncExternalStore } from 'react'
import { createPreviewResourceKey, type PreviewResourceIdentity } from './preview-resource-key'

import {
  WEB_EVENT_CONNECTION_STATE_EVENT,
  WEB_EVENT_SURFACE_ATTRIBUTE,
  type WebEventConnectionState
} from '../../../../../shared/web-event-connection'

let generation = 0
let recovering = false
const listeners = new Set<() => void>()
const isWeb = (): boolean =>
  typeof document !== 'undefined' &&
  document.documentElement.getAttribute(WEB_EVENT_SURFACE_ATTRIBUTE) === 'true'

// One owner for the renderer lifetime, including periods with no mounted preview consumers.
// A replayable event cursor does not imply that Main retained the caller's resource lease.
if (typeof window !== 'undefined') {
  window.addEventListener(WEB_EVENT_CONNECTION_STATE_EVENT, (event) => {
    if (!isWeb()) return
    const { phase } = (event as CustomEvent<WebEventConnectionState>).detail
    if (phase === 'reconnecting') recovering = true
    if (phase !== 'live' || !recovering) return
    recovering = false
    generation += 1
    for (const listener of listeners) listener()
  })
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const getSnapshot = (): number => (isWeb() ? generation : 0)

const usePreviewResourceGeneration = (): number => useSyncExternalStore(subscribe, getSnapshot)

const usePreviewResourceKey = (identity: PreviewResourceIdentity): string => {
  const generation = usePreviewResourceGeneration()
  return `${createPreviewResourceKey(identity)}:${generation}`
}

export { usePreviewResourceGeneration, usePreviewResourceKey }
