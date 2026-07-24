import type { OfficePreviewRuntimeState } from '../../shared/office-preview'
import type {
  CreateOfficePreviewViewOptions,
  OfficePreviewChildView
} from './office-preview-supervisor'

type PlatformWebContents = {
  id: number
  send: (channel: string, message: unknown) => void
  close: (options?: { waitForBeforeUnload?: boolean }) => void
  isDestroyed: () => boolean
  setWindowOpenHandler: (handler: () => { action: 'deny' }) => void
  on: (event: string, listener: (...args: unknown[]) => void) => void
  off: (event: string, listener: (...args: unknown[]) => void) => void
}

type PlatformView = {
  webContents: PlatformWebContents
  setBounds: (bounds: { x: number; y: number; width: number; height: number }) => void
  setVisible: (visible: boolean) => void
  captureSnapshot?: () => Promise<string | undefined>
  setBackgroundColor?: (color: string) => void
  setPreviewResourceId?: (resourceId: string) => void
  dispose?: () => void
}

type PlatformParentWindow = {
  addChildView: (view: PlatformView) => void
  removeChildView: (view: PlatformView) => void
}

type OfficePreviewViewFactoryDependencies = {
  resolveParentWindow: (ownerId: number) => PlatformParentWindow | undefined
  createPlatformView: (sessionId: string, parentOwnerId: number) => PlatformView
  listenRuntimeState: (
    listener: (senderId: number, state: OfficePreviewRuntimeState) => void
  ) => () => void
  loadRuntime: (contents: PlatformWebContents) => Promise<void>
  getMemoryUsageBytes?: (contents: PlatformWebContents) => number | Promise<number>
}

const createOfficePreviewViewFactory = (
  dependencies: OfficePreviewViewFactoryDependencies
): ((options: CreateOfficePreviewViewOptions) => OfficePreviewChildView) => {
  return (options) => {
    const parentWindow = dependencies.resolveParentWindow(options.parentOwnerId)
    if (!parentWindow) throw new Error('Office preview parent window is unavailable')

    const view = dependencies.createPlatformView(options.sessionId, options.parentOwnerId)
    // The child is drawable during loading, so its transparent surface lets the parent status show through.
    view.setBackgroundColor?.('#00000000')
    const contents = view.webContents
    let closed = false
    let goneReported = false

    const reportGone = (): void => {
      if (closed || goneReported) return
      goneReported = true
      void options.onGone()
    }
    const preventNavigation = (event: unknown): void => {
      if (
        typeof event === 'object' &&
        event !== null &&
        'preventDefault' in event &&
        typeof event.preventDefault === 'function'
      ) {
        event.preventDefault()
      }
    }

    // The child renderer never owns navigation; all generated links stay inert inside the preview.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('unresponsive', reportGone)
    contents.on('render-process-gone', reportGone)
    contents.on('will-navigate', preventNavigation)
    contents.on('will-frame-navigate', preventNavigation)
    contents.on('will-redirect', preventNavigation)
    parentWindow.addChildView(view)
    const removeRuntimeStateListener = dependencies.listenRuntimeState((senderId, state) => {
      if (senderId !== contents.id || state.sessionId !== options.sessionId) return
      options.onState(state)
    })

    return {
      ownerId: contents.id,
      start: async (message) => {
        view.setPreviewResourceId?.(message.resource.id)
        await dependencies.loadRuntime(contents)
        if (closed || contents.isDestroyed()) {
          throw new Error('Office preview process closed before startup completed')
        }
        contents.send('office-preview-runtime:start', message)
      },
      setBounds: (bounds) => view.setBounds(bounds),
      setVisible: (visible) => view.setVisible(visible),
      captureSnapshot: view.captureSnapshot ? () => view.captureSnapshot!() : undefined,
      getMemoryUsageBytes: dependencies.getMemoryUsageBytes
        ? () => dependencies.getMemoryUsageBytes!(contents)
        : undefined,
      close: () => {
        if (closed) return
        closed = true
        removeRuntimeStateListener()
        contents.off('unresponsive', reportGone)
        contents.off('render-process-gone', reportGone)
        contents.off('will-navigate', preventNavigation)
        contents.off('will-frame-navigate', preventNavigation)
        contents.off('will-redirect', preventNavigation)
        // Electron may destroy the parent contentView before renderer teardown reaches this child.
        try {
          parentWindow.removeChildView(view)
        } catch {
          // The native hierarchy is already gone; continue releasing session-owned resources.
        }
        try {
          view.dispose?.()
        } catch {
          // Session teardown is best-effort after the renderer or partition has already gone.
        }
        if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false })
      }
    }
  }
}

export { createOfficePreviewViewFactory }
export type {
  OfficePreviewViewFactoryDependencies,
  PlatformParentWindow,
  PlatformView,
  PlatformWebContents
}
