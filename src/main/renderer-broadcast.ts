import { BrowserWindow } from 'electron'

import type {
  ApplicationEventChannel,
  ApplicationEventMap,
  ApplicationEvents
} from './application-events'

export type RendererBroadcastSink = <Channel extends ApplicationEventChannel>(
  channel: Channel,
  payload: ApplicationEventMap[Channel]
) => void

let installedEvents: ApplicationEvents | undefined
let removeElectronProjection: (() => void) | undefined
const sinks = new Set<RendererBroadcastSink>()
const sinkSubscriptions = new Map<RendererBroadcastSink, () => void>()

const projectToElectron = <Channel extends ApplicationEventChannel>(
  channel: Channel,
  payload: ApplicationEventMap[Channel]
): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

// Compatibility facade for existing publishers. Production installs the application-owned hub
// before exposing IPC surfaces, so one publication fans out through ordered projections. The direct
// path keeps isolated unit tests and startup-before-install behavior identical to the old broadcaster.
const broadcastToRenderers = <Channel extends ApplicationEventChannel>(
  channel: Channel,
  payload: ApplicationEventMap[Channel]
): void => {
  if (installedEvents) {
    installedEvents.publish(channel, payload)
    return
  }

  projectToElectron(channel, payload)
  for (const sink of sinks) sink(channel, payload)
}

const subscribeSink = (events: ApplicationEvents, sink: RendererBroadcastSink): (() => void) =>
  events.subscribe((event) => sink(event.channel, event.payload))

const addRendererBroadcastSink = (sink: RendererBroadcastSink): (() => void) => {
  if (!sinks.has(sink)) {
    sinks.add(sink)
    if (installedEvents) sinkSubscriptions.set(sink, subscribeSink(installedEvents, sink))
  }

  return () => {
    if (!sinks.delete(sink)) return
    sinkSubscriptions.get(sink)?.()
    sinkSubscriptions.delete(sink)
  }
}

// The composition root owns the hub; this adapter only binds the legacy publisher facade and the
// Electron projection for one application runtime generation.
const installRendererBroadcastEventHub = (events: ApplicationEvents): (() => void) => {
  if (installedEvents) throw new Error('Renderer broadcast event hub is already installed.')
  installedEvents = events
  removeElectronProjection = events.subscribe((event) =>
    projectToElectron(event.channel, event.payload)
  )
  for (const sink of sinks) sinkSubscriptions.set(sink, subscribeSink(events, sink))

  return () => {
    if (installedEvents !== events) return
    removeElectronProjection?.()
    removeElectronProjection = undefined
    for (const unsubscribe of sinkSubscriptions.values()) unsubscribe()
    sinkSubscriptions.clear()
    installedEvents = undefined
  }
}

export { addRendererBroadcastSink, broadcastToRenderers, installRendererBroadcastEventHub }
