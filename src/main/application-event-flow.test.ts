import { beforeEach, describe, expect, it, vi } from 'vitest'

const windows: Array<{
  isDestroyed: () => boolean
  webContents: { send: ReturnType<typeof vi.fn> }
}> = []

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => windows }
}))

import type { AcpRuntimeEvent } from '../shared/acp'
import { ApplicationEventHub } from './application-events'
import { broadcastToRenderers, installRendererBroadcastEventHub } from './renderer-broadcast'
import {
  projectPublicTaskEvent,
  projectTaskRuntimeEvents,
  projectWebRendererEvent
} from './web-service/application-event-projections'

beforeEach(() => {
  windows.length = 0
})

describe('application event flow', () => {
  it('delivers terminal stop and failure events once in Electron, Task, and Web order', () => {
    const order: string[] = []
    const payloads: AcpRuntimeEvent[] = [
      {
        id: 'stop-1',
        timestamp: 100,
        kind: 'stop',
        level: 'info',
        sessionId: 'session-1',
        turnUsage: {
          inputTokens: 12,
          cacheTokens: 7,
          cachedReadTokens: 5,
          cachedWriteTokens: 2,
          outputTokens: 4,
          turnCount: 3
        }
      },
      {
        id: 'failure-1',
        timestamp: 101,
        kind: 'error',
        level: 'error',
        sessionId: 'session-1',
        text: 'provider failed',
        providerError: true
      }
    ]
    windows.push({
      isDestroyed: () => false,
      webContents: {
        send: vi.fn((_channel, payload: readonly AcpRuntimeEvent[]) => {
          order.push(`electron:${payload[0]?.kind}`)
        })
      }
    })
    const hub = new ApplicationEventHub()
    const uninstall = installRendererBroadcastEventHub(hub)
    const removeTask = hub.subscribe((event) => {
      for (const projection of projectTaskRuntimeEvents(event)) {
        order.push(`task:${projection.kind}`)
      }
    })
    const removeWeb = hub.subscribe((event) => {
      const rendererProjection = projectWebRendererEvent(event)
      if (rendererProjection) {
        const batch = rendererProjection.payload as readonly AcpRuntimeEvent[]
        order.push(`web:${batch[0]?.kind}`)
      }
      const publicProjection = projectPublicTaskEvent(event)
      if (publicProjection?.type === 'run.event') {
        order.push(`public:${publicProjection.data.kind}`)
      }
    })

    for (const payload of payloads) broadcastToRenderers('acp:event', [payload])

    expect(order).toEqual([
      'electron:stop',
      'task:stop',
      'web:stop',
      'public:stop',
      'electron:error',
      'task:error',
      'web:error',
      'public:error'
    ])
    expect(windows[0].webContents.send).toHaveBeenNthCalledWith(1, 'acp:event', [payloads[0]])
    expect(windows[0].webContents.send).toHaveBeenNthCalledWith(2, 'acp:event', [payloads[1]])

    removeWeb()
    removeTask()
    uninstall()
    hub.dispose()
  })
})
