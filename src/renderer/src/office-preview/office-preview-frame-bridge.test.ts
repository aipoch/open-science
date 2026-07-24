import { describe, expect, it, vi } from 'vitest'

import type { OfficePreviewRuntimeStart } from '../../../shared/office-preview'

describe('Office preview frame bridge', () => {
  it('routes only parent messages for the active session', async () => {
    const module = await import('./office-preview-frame-bridge').catch(() => undefined)
    expect(module).toBeDefined()
    if (!module) return

    let messageListener: ((event: MessageEvent) => void) | undefined
    const parent = { postMessage: vi.fn() }
    const runtimeWindow = {
      parent,
      addEventListener: vi.fn((_type: 'message', listener: (event: MessageEvent) => void) => {
        messageListener = listener
      }),
      removeEventListener: vi.fn()
    }
    const bridge = module.createOfficePreviewFrameBridge({
      runtimeWindow: runtimeWindow as never,
      sessionId: 'session-1'
    })
    const onStart = vi.fn()
    bridge.onStart(onStart)
    const start: OfficePreviewRuntimeStart = {
      sessionId: 'session-1',
      resource: {
        id: 'resource-1',
        url: 'open-science-preview://resource-1/report.docx',
        size: 1024,
        mimeType: 'application/octet-stream',
        version: 1
      },
      extension: 'docx',
      name: 'report.docx',
      attempt: 0
    }
    const message = {
      channel: 'open-science-office-preview',
      version: 1,
      type: 'start',
      sessionId: 'session-1',
      start
    }

    expect(parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ready', sessionId: 'session-1' }),
      '*'
    )
    messageListener?.({ source: {}, data: message } as unknown as MessageEvent)
    messageListener?.({
      source: parent,
      data: { ...message, sessionId: 'different-session' }
    } as unknown as MessageEvent)
    expect(onStart).not.toHaveBeenCalled()

    messageListener?.({ source: parent, data: message } as unknown as MessageEvent)
    expect(onStart).toHaveBeenCalledWith(start)

    bridge.reportState({ sessionId: 'session-1', phase: 'ready' })
    expect(parent.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'state',
        sessionId: 'session-1',
        state: { sessionId: 'session-1', phase: 'ready' }
      }),
      '*'
    )

    bridge.dispose()
    expect(runtimeWindow.removeEventListener).toHaveBeenCalledWith('message', expect.any(Function))
  })
})
