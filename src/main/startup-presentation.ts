import type { EventEmitter } from 'node:events'
import { STARTUP_PRESENTATION_CHANNEL } from '../shared/startup-presentation'
import type { StartupPresenter } from './startup-presenter'

type Surface = EventEmitter & {
  isDestroyed: () => boolean
  webContents: EventEmitter & { mainFrame: unknown }
}

export function createStartupPresentation({
  ipc,
  window,
  presenter,
  reveal,
  failed
}: {
  ipc: Pick<EventEmitter, 'on' | 'removeListener'>
  window: Surface
  presenter: StartupPresenter
  reveal: () => void
  failed?: () => void
}): { focus: () => boolean; dispose: () => void } {
  let pending = true
  // BrowserWindow's native getter is unavailable inside its closed event. Retain the event
  // emitter so a failed startup document can be discarded and replaced without breaking cleanup.
  const webContents = window.webContents
  const dispose = (): void => {
    ipc.removeListener(STARTUP_PRESENTATION_CHANNEL, onPhase)
    webContents.removeListener('render-process-gone', onGone)
    window.removeListener('closed', dispose)
  }
  const onGone = (): void => {
    if (pending) presenter.fail('startup-renderer-disconnected')
    dispose()
    failed?.()
  }
  const onPhase = (event: { sender: unknown; senderFrame: unknown }, phase: unknown): void => {
    if (
      !pending ||
      window.isDestroyed() ||
      event.sender !== webContents ||
      event.senderFrame !== webContents.mainFrame
    )
      return
    if (phase === 'interactive' || phase === 'blocked') {
      pending = false
      // The renderer acknowledges an interactive/error paint, not just DOM load or DB readiness.
      reveal()
      presenter.complete()
      dispose()
    } else if (
      ['startup-database', 'startup-runtime', 'startup-settings', 'startup-sessions'].includes(
        String(phase)
      )
    ) {
      presenter.update(String(phase))
    }
  }
  ipc.on(STARTUP_PRESENTATION_CHANNEL, onPhase)
  webContents.on('render-process-gone', onGone)
  window.on('closed', dispose)
  return {
    focus: () => {
      if (pending) presenter.focus()
      return pending
    },
    dispose
  }
}
