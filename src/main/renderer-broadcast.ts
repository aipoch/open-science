import { BrowserWindow } from 'electron'

export type RendererBroadcastSink = (channel: string, payload: unknown) => void

const sinks = new Set<RendererBroadcastSink>()

const broadcastToRenderers = <Payload>(channel: string, payload: Payload): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }

  for (const sink of sinks) sink(channel, payload)
}

const addRendererBroadcastSink = (sink: RendererBroadcastSink): (() => void) => {
  sinks.add(sink)
  return () => sinks.delete(sink)
}

export { addRendererBroadcastSink, broadcastToRenderers }
