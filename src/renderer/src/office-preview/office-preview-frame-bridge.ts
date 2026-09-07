import type {
  OfficePreviewRuntimeStart,
  OfficePreviewRuntimeState
} from '../../../shared/office-preview'
import {
  isOfficePreviewHostMessage,
  OFFICE_PREVIEW_FRAME_MESSAGE_CHANNEL,
  OFFICE_PREVIEW_FRAME_MESSAGE_VERSION
} from '../../../shared/office-preview'

type OfficePreviewFrameParent = {
  postMessage: (message: unknown, targetOrigin: string) => void
}

type OfficePreviewFrameWindow = {
  parent: OfficePreviewFrameParent
  addEventListener: {
    (type: 'message', listener: (event: MessageEvent) => void): void
    (type: 'contextmenu', listener: (event: MouseEvent) => void, capture: boolean): void
  }
  removeEventListener: {
    (type: 'message', listener: (event: MessageEvent) => void): void
    (type: 'contextmenu', listener: (event: MouseEvent) => void, capture: boolean): void
  }
}

type CreateOfficePreviewFrameBridgeOptions = {
  runtimeWindow: OfficePreviewFrameWindow
  sessionId: string
}

type OfficePreviewFrameBridge = {
  onStart: (listener: (start: OfficePreviewRuntimeStart) => void) => () => void
  reportState: (state: OfficePreviewRuntimeState) => void
  dispose: () => void
}

const createOfficePreviewFrameBridge = (
  options: CreateOfficePreviewFrameBridgeOptions
): OfficePreviewFrameBridge => {
  const listeners = new Set<(start: OfficePreviewRuntimeStart) => void>()
  let disposed = false

  // The direct parent window is the only accepted sender; session validation rejects stale frames.
  const handleMessage = (event: MessageEvent): void => {
    if (
      disposed ||
      event.source !== options.runtimeWindow.parent ||
      !isOfficePreviewHostMessage(event.data) ||
      event.data.start.sessionId !== options.sessionId
    ) {
      return
    }
    listeners.forEach((listener) => listener(event.data.start))
  }
  options.runtimeWindow.addEventListener('message', handleMessage)

  const handleContextMenu = (event: MouseEvent): void => {
    if (
      disposed ||
      !(event.target instanceof Element) ||
      event.target.closest(
        'input, textarea, select, button, iframe, [contenteditable]:not([contenteditable="false"]), [data-preview-context-menu-passthrough]'
      )
    ) {
      return
    }
    event.preventDefault()
    options.runtimeWindow.parent.postMessage(
      {
        channel: OFFICE_PREVIEW_FRAME_MESSAGE_CHANNEL,
        version: OFFICE_PREVIEW_FRAME_MESSAGE_VERSION,
        type: 'context-menu',
        contextMenu: { sessionId: options.sessionId, x: event.clientX, y: event.clientY }
      },
      '*'
    )
  }
  options.runtimeWindow.addEventListener('contextmenu', handleContextMenu, true)

  return {
    onStart: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    reportState: (state) => {
      if (disposed || state.sessionId !== options.sessionId) return
      options.runtimeWindow.parent.postMessage(
        {
          channel: OFFICE_PREVIEW_FRAME_MESSAGE_CHANNEL,
          version: OFFICE_PREVIEW_FRAME_MESSAGE_VERSION,
          type: 'state',
          state
        },
        '*'
      )
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      listeners.clear()
      options.runtimeWindow.removeEventListener('message', handleMessage)
      options.runtimeWindow.removeEventListener('contextmenu', handleContextMenu, true)
    }
  }
}

export { createOfficePreviewFrameBridge }
export type {
  CreateOfficePreviewFrameBridgeOptions,
  OfficePreviewFrameBridge,
  OfficePreviewFrameWindow
}
