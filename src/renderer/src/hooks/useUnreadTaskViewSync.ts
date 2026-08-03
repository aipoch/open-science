import { useEffect } from 'react'

import type { UnreadTaskViewState } from '../../../shared/notifications'
import { STREAMDOWN_FULLSCREEN_SELECTOR } from '@/components/streamdown/dom-selectors'
import { useNavigationStore } from '@/stores/navigation-store'
import { useSessionStore } from '@/stores/session-store'

type UnreadTaskViewSyncOptions = {
  isSessionContentVisible: boolean
}

const BLOCKING_OVERLAY_SELECTOR = `[role="dialog"], [role="alertdialog"], ${STREAMDOWN_FULLSCREEN_SELECTOR}`

// Visibility means the conversation can actually be read, not merely that its route is mounted.
// Dialogs and fullscreen viewers therefore suppress acknowledgement until they close.
const isBlockingOverlayOpen = (): boolean =>
  [...document.querySelectorAll<HTMLElement>(BLOCKING_OVERLAY_SELECTOR)].some(
    (element) =>
      element.getAttribute('data-state') !== 'closed' &&
      element.closest('[aria-hidden="true"], [hidden]') === null
  )

// MutationObserver records may point at an overlay, its descendants, or a removed ancestor.
const nodeTouchesBlockingOverlay = (node: Node): boolean =>
  node instanceof Element &&
  (node.matches(BLOCKING_OVERLAY_SELECTOR) ||
    node.querySelector(BLOCKING_OVERLAY_SELECTOR) !== null ||
    node.closest(BLOCKING_OVERLAY_SELECTOR) !== null)

// Filters the app-wide observer down to mutations capable of changing effective visibility.
const mutationTouchesBlockingOverlay = (mutation: MutationRecord): boolean => {
  if (mutation.type === 'attributes') {
    if (
      mutation.attributeName === 'role' &&
      (mutation.oldValue === 'dialog' || mutation.oldValue === 'alertdialog')
    ) {
      return true
    }
    return nodeTouchesBlockingOverlay(mutation.target)
  }

  return [...mutation.addedNodes, ...mutation.removedNodes].some(nodeTouchesBlockingOverlay)
}

// Projects a session only when navigation, project ownership, hydration, and DOM occlusion all agree
// that the non-pending conversation is the content the user can currently inspect.
const projectVisibleSessionId = (isSessionContentVisible: boolean): string | undefined => {
  const sessionState = useSessionStore.getState()
  const navigationState = useNavigationStore.getState()
  const selectedSessionId = sessionState.selectedSessionId
  const selectedSession = sessionState.sessions.find(
    (session) => session.id === selectedSessionId && !session.isPending
  )
  return isSessionContentVisible &&
    !isBlockingOverlayOpen() &&
    navigationState.view === 'workspace' &&
    navigationState.activeProjectId !== undefined &&
    selectedSession !== undefined &&
    selectedSession.projectId === navigationState.activeProjectId
    ? selectedSession.id
    : undefined
}

// Projects only what the renderer can authoritatively observe: whether one conversation is visible.
const projectViewState = (isSessionContentVisible: boolean): UnreadTaskViewState => {
  const visibleSessionId = projectVisibleSessionId(isSessionContentVisible)

  return visibleSessionId ? { visibleSessionId } : {}
}

// The normalized visibility projection has a stable JSON key for suppressing duplicate IPC.
const projectionKey = (state: UnreadTaskViewState): string => JSON.stringify(state)

// Main owns unread state. Renderer publishes only current visibility and answers fresh probes.
export const useUnreadTaskViewSync = ({
  isSessionContentVisible
}: UnreadTaskViewSyncOptions): void => {
  useEffect(() => {
    const syncViewState = window.api.notifications.syncViewState

    if (!syncViewState) return

    let lastProjection: string | undefined

    const publish = (challengeId?: number): void => {
      if (challengeId !== undefined) {
        // A probe is a latency-sensitive visibility acknowledgement, not a second full projection.
        const visibleSessionId = projectVisibleSessionId(isSessionContentVisible)
        syncViewState({
          challengeId,
          ...(visibleSessionId ? { visibleSessionId } : {})
        })
        return
      }

      const state = projectViewState(isSessionContentVisible)
      const key = projectionKey(state)

      if (key === lastProjection) return
      lastProjection = key

      syncViewState(state)
    }

    const sync = (): void => publish()

    sync()
    // Streaming updates replace session objects on every chunk; only selection changes visibility.
    const unsubscribeSessions = useSessionStore.subscribe((state, previousState) => {
      if (state.selectedSessionId === previousState.selectedSessionId) return
      sync()
    })
    const unsubscribeNavigation = useNavigationStore.subscribe(sync)
    const removeProbeListener = window.api.notifications.onViewProbe?.((challengeId) => {
      if (Number.isSafeInteger(challengeId) && challengeId > 0) publish(challengeId)
    })
    // Overlay state is not centralized in one store (native dialogs, Radix dialogs, fullscreen
    // viewers), so observe only the DOM attributes/subtrees that can change acknowledgement.
    const dialogObserver = new MutationObserver((mutations) => {
      if (mutations.some(mutationTouchesBlockingOverlay)) sync()
    })

    dialogObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['aria-hidden', 'data-state', 'hidden', 'role']
    })

    return () => {
      unsubscribeSessions()
      unsubscribeNavigation()
      removeProbeListener?.()
      dialogObserver.disconnect()
    }
  }, [isSessionContentVisible])
}
