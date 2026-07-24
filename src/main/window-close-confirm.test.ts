import { describe, expect, it, vi } from 'vitest'

import type { ActiveSessionInfo } from '../shared/storage'
import type { CloseConfirmRequest, CloseConfirmResponse } from '../shared/window-controls'
import {
  createCloseConfirm,
  type CloseConfirmDeps,
  type NativeCloseConfirmResult
} from './window-close-confirm'

const session: ActiveSessionInfo = {
  projectId: 'my-analysis',
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
  setClosePreference: ReturnType<typeof vi.fn>
  ack: () => void
  choose: (choice: CloseConfirmResponse['choice']) => void
  reply: (payload: CloseConfirmResponse) => void
  fireGone: () => void
  fireHang: () => void
  fireRecover: () => void
} => {
  let responder: ((payload: CloseConfirmResponse) => void) | undefined
  let goneCb: (() => void) | undefined
  let hangCbs: { onHang: () => void; onRecover: () => void } | undefined
  const sent: CloseConfirmRequest[] = []
  const nativeFallback = vi.fn(async (): Promise<NativeCloseConfirmResult> => ({ choice: 'quit' }))
  const setClosePreference = vi.fn(async () => undefined)
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
    onRendererUnresponsive: (cbs) => {
      hangCbs = cbs
      return () => {
        hangCbs = undefined
      }
    },
    nativeFallback,
    getClosePreference: async () => undefined,
    setClosePreference,
    newRequestId: () => 'req-1',
    ackTimeoutMs: 10,
    hangGraceMs: 10,
    ...overrides
  }
  return {
    confirm: createCloseConfirm(deps),
    sent,
    nativeFallback,
    setClosePreference,
    ack: () => responder?.({ requestId: 'req-1', ack: true }),
    choose: (choice: CloseConfirmResponse['choice']) => responder?.({ requestId: 'req-1', choice }),
    reply: (payload: CloseConfirmResponse) => responder?.(payload),
    fireGone: () => goneCb?.(),
    fireHang: () => hangCbs?.onHang(),
    fireRecover: () => hangCbs?.onRecover()
  }
}

// Resolves after `ms` real milliseconds so a test can outlast a short ackTimeoutMs/hangGraceMs timer.
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const flushPreferenceRead = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
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
    await flushPreferenceRead()
    h.ack()
    h.choose('minimize')
    await expect(pending).resolves.toBe('minimize')
    expect(h.sent[0]).toMatchObject({ variant: 'close-to-tray', sessions: [session] })
  })

  it('persists a remembered close-to-tray choice before resolving it', async () => {
    const h = makeHarness()
    const pending = h.confirm('close-to-tray', [session])
    await flushPreferenceRead()
    h.ack()
    h.reply({ requestId: 'req-1', choice: 'minimize', remember: true })

    await expect(pending).resolves.toBe('minimize')
    expect(h.setClosePreference).toHaveBeenCalledWith('minimize')
  })

  it('uses a saved close-to-tray preference without showing the dialog', async () => {
    const h = makeHarness({ getClosePreference: async () => 'quit' })

    await expect(h.confirm('close-to-tray', [session])).resolves.toBe('quit')
    expect(h.sent).toHaveLength(0)
  })

  it('shows the dialog when reading the saved preference fails', async () => {
    const h = makeHarness({
      getClosePreference: async () => {
        throw new Error('settings unavailable')
      }
    })
    const pending = h.confirm('close-to-tray', [session])
    await flushPreferenceRead()
    h.ack()
    h.choose('minimize')

    await expect(pending).resolves.toBe('minimize')
    expect(h.sent).toHaveLength(1)
  })

  it('still confirms an explicit quit with running work when a close preference is saved', async () => {
    const h = makeHarness({ getClosePreference: async () => 'quit' })
    const pending = h.confirm('quit', [session])
    h.ack()
    h.choose('cancel')

    await expect(pending).resolves.toBe('cancel')
    expect(h.sent[0]).toMatchObject({ variant: 'quit', sessions: [session] })
  })

  it('ignores a stale response with a mismatched requestId', async () => {
    const h = makeHarness()
    const pending = h.confirm('close-to-tray', [session])
    await flushPreferenceRead()
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

  it('persists a remembered choice from the native fallback', async () => {
    const h = makeHarness({
      isRendererAvailable: () => false,
      nativeFallback: async () => ({ choice: 'minimize', remember: true })
    })

    await expect(h.confirm('close-to-tray', [session])).resolves.toBe('minimize')
    expect(h.setClosePreference).toHaveBeenCalledWith('minimize')
  })

  it('falls back once when the render process dies mid-modal', async () => {
    const h = makeHarness({ ackTimeoutMs: 10_000 })
    const pending = h.confirm('quit', [session])
    await flushPreferenceRead()
    h.ack()
    h.fireGone()
    await expect(pending).resolves.toBe('quit')
    expect(h.nativeFallback).toHaveBeenCalledTimes(1)
  })

  it('still settles when the native fallback rejects (never strands the confirm)', async () => {
    // A stranded promise would pin the caller's in-flight guard forever and block quit. If the native
    // dialog rejects (e.g. the window was destroyed), quit proceeds and close-to-tray stays resident.
    const rejecting = vi.fn(async (): Promise<NativeCloseConfirmResult> => {
      throw new Error('dialog failed')
    })
    const quitHarness = makeHarness({ isRendererAvailable: () => false, nativeFallback: rejecting })
    await expect(quitHarness.confirm('quit', [session])).resolves.toBe('quit')

    const trayHarness = makeHarness({ isRendererAvailable: () => false, nativeFallback: rejecting })
    await expect(trayHarness.confirm('close-to-tray', [session])).resolves.toBe('minimize')
  })

  it('still resolves the choice when saving a remembered preference fails', async () => {
    const setClosePreference = vi.fn(async () => {
      throw new Error('settings unavailable')
    })
    const h = makeHarness({ setClosePreference })
    const pending = h.confirm('close-to-tray', [session])
    await flushPreferenceRead()
    h.ack()
    h.reply({ requestId: 'req-1', choice: 'quit', remember: true })

    await expect(pending).resolves.toBe('quit')
    expect(setClosePreference).toHaveBeenCalledWith('quit')
  })

  it('falls back after the grace period when an ACKed modal stays unresponsive', async () => {
    const h = makeHarness({ ackTimeoutMs: 10_000, hangGraceMs: 10 })
    const pending = h.confirm('quit', [session])
    await flushPreferenceRead()
    h.ack()
    h.fireHang()
    // The grace timer is armed but hasn't elapsed yet, so no fallback has fired.
    expect(h.nativeFallback).not.toHaveBeenCalled()
    await expect(pending).resolves.toBe('quit')
    expect(h.nativeFallback).toHaveBeenCalledTimes(1)
  })

  it('does not fall back when a hung modal becomes responsive again before the grace elapses', async () => {
    const h = makeHarness({ ackTimeoutMs: 10_000, hangGraceMs: 10 })
    const pending = h.confirm('quit', [session])
    await flushPreferenceRead()
    h.ack()
    h.fireHang()
    h.fireRecover()
    await wait(30) // outlast the (cancelled) grace timer
    expect(h.nativeFallback).not.toHaveBeenCalled()
    h.choose('cancel')
    await expect(pending).resolves.toBe('cancel')
  })

  it('ignores a hang before ack: the ack timer still owns the pre-ack window', async () => {
    const h = makeHarness({ ackTimeoutMs: 10, hangGraceMs: 10_000 })
    const pending = h.confirm('quit', [session])
    await flushPreferenceRead()
    h.fireHang() // pre-ack: must not arm the (10s) hang timer
    await expect(pending).resolves.toBe('quit') // resolved by the 10ms ack timeout, not the hang path
    expect(h.nativeFallback).toHaveBeenCalledTimes(1)
  })
})
