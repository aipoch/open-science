import { beforeEach, describe, expect, it, vi } from 'vitest'

const windows: Array<{
  destroyed: boolean
  isDestroyed: () => boolean
  webContents: { send: ReturnType<typeof vi.fn> }
}> = []

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => windows
  }
}))

import { addRendererBroadcastSink, broadcastToRenderers } from './renderer-broadcast'

beforeEach(() => {
  windows.length = 0
})

describe('broadcastToRenderers', () => {
  it('sends to live Electron windows and registered external sinks', () => {
    const live = {
      destroyed: false,
      isDestroyed(): boolean {
        return this.destroyed
      },
      webContents: { send: vi.fn() }
    }
    const dead = {
      destroyed: true,
      isDestroyed(): boolean {
        return this.destroyed
      },
      webContents: { send: vi.fn() }
    }
    windows.push(live, dead)
    const sink = vi.fn()
    const remove = addRendererBroadcastSink(sink)

    broadcastToRenderers('channel', { value: 1 })
    expect(live.webContents.send).toHaveBeenCalledWith('channel', { value: 1 })
    expect(dead.webContents.send).not.toHaveBeenCalled()
    expect(sink).toHaveBeenCalledWith('channel', { value: 1 })

    remove()
    broadcastToRenderers('other', null)
    expect(sink).toHaveBeenCalledTimes(1)
  })
})
