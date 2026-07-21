import { describe, expect, it, vi } from 'vitest'

import type { ActiveSessionInfo } from '../shared/storage'
import type {
  CloseConfirmChoice,
  CloseConfirmRequest,
  CloseConfirmResponse
} from '../shared/window-controls'
import { createCloseConfirm, type CloseConfirmDeps } from './window-close-confirm'

const session: ActiveSessionInfo = {
  projectName: 'my-analysis',
  sessionId: 's1',
  kind: 'agent'
}

// Builds a coordinator with controllable renderer plumbing. `emit` lets the test play the renderer.
const makeHarness = (
  overrides: Partial<CloseConfirmDeps> = {}
): {
  confirm: ReturnType<typeof createCloseConfirm>
  sent: CloseConfirmRequest[]
  nativeFallback: ReturnType<typeof vi.fn>
  ack: () => void
  choose: (choice: CloseConfirmResponse['choice']) => void
  reply: (payload: CloseConfirmResponse) => void
  fireGone: () => void
} => {
  let responder: ((payload: CloseConfirmResponse) => void) | undefined
  let goneCb: (() => void) | undefined
  const sent: CloseConfirmRequest[] = []
  const nativeFallback = vi.fn(async (): Promise<CloseConfirmChoice> => 'quit')
  const deps: CloseConfirmDeps = {
    send: (payload) => sent.push(payload),
    onResponse: (cb) => {
      responder = cb
      return () => {
        responder = undefined
      }
    },
    isRendererAvailable: () => true,
    onRenderGone: (cb) => {
      goneCb = cb
      return () => {
        goneCb = undefined
      }
    },
    nativeFallback,
    newRequestId: () => 'req-1',
    ackTimeoutMs: 10,
    ...overrides
  }
  return {
    confirm: createCloseConfirm(deps),
    sent,
    nativeFallback,
    ack: () => responder?.({ requestId: 'req-1', ack: true }),
    choose: (choice: CloseConfirmResponse['choice']) => responder?.({ requestId: 'req-1', choice }),
    reply: (payload: CloseConfirmResponse) => responder?.(payload),
    fireGone: () => goneCb?.()
  }
}

describe('createCloseConfirm', () => {
  it('resolves quit immediately for the quit variant with no running work (no IPC)', async () => {
    const h = makeHarness()
    await expect(h.confirm('quit', [])).resolves.toBe('quit')
    expect(h.sent).toHaveLength(0)
  })

  it('sends a request and resolves the renderer choice', async () => {
    const h = makeHarness()
    const pending = h.confirm('close-to-tray', [session])
    h.ack()
    h.choose('minimize')
    await expect(pending).resolves.toBe('minimize')
    expect(h.sent[0]).toMatchObject({ variant: 'close-to-tray', sessions: [session] })
  })

  it('ignores a stale response with a mismatched requestId', async () => {
    const h = makeHarness()
    const pending = h.confirm('close-to-tray', [session])
    h.ack()
    h.reply({ requestId: 'other', choice: 'quit' })
    h.choose('cancel')
    await expect(pending).resolves.toBe('cancel')
  })

  it('falls back to the native dialog when the renderer never acks', async () => {
    const h = makeHarness()
    const pending = h.confirm('close-to-tray', [session])
    await expect(pending).resolves.toBe('quit') // nativeFallback default
    expect(h.nativeFallback).toHaveBeenCalledWith('close-to-tray')
  })

  it('falls back immediately when no renderer is available', async () => {
    const h = makeHarness({ isRendererAvailable: () => false })
    await expect(h.confirm('close-to-tray', [session])).resolves.toBe('quit')
    expect(h.nativeFallback).toHaveBeenCalledWith('close-to-tray')
  })

  it('falls back once when the render process dies mid-modal', async () => {
    const h = makeHarness({ ackTimeoutMs: 10_000 })
    const pending = h.confirm('quit', [session])
    h.ack()
    h.fireGone()
    await expect(pending).resolves.toBe('quit')
    expect(h.nativeFallback).toHaveBeenCalledTimes(1)
  })

  it('still settles when the native fallback rejects (never strands the confirm)', async () => {
    // A stranded promise would pin the caller's in-flight guard forever and block quit. If the native
    // dialog rejects (e.g. the window was destroyed), quit proceeds and close-to-tray stays resident.
    const rejecting = vi.fn(async (): Promise<CloseConfirmChoice> => {
      throw new Error('dialog failed')
    })
    const quitHarness = makeHarness({ isRendererAvailable: () => false, nativeFallback: rejecting })
    await expect(quitHarness.confirm('quit', [session])).resolves.toBe('quit')

    const trayHarness = makeHarness({ isRendererAvailable: () => false, nativeFallback: rejecting })
    await expect(trayHarness.confirm('close-to-tray', [session])).resolves.toBe('minimize')
  })
})
