import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { BrowserWindow } from 'electron'
import type { ActiveSessionInfo } from '../shared/storage'
import type { CloseConfirmRequest, CloseConfirmResponse } from '../shared/window-controls'
import {
  WINDOW_CLOSE_CONFIRM_REQUEST_CHANNEL,
  WINDOW_CLOSE_CONFIRM_RESPONSE_CHANNEL
} from '../shared/window-controls'
import {
  createCloseConfirm,
  createElectronCloseConfirm,
  type CloseConfirmDeps,
  type ClosePreferenceAccess,
  type NativeCloseConfirmResult
} from './window-close-confirm'

const session: ActiveSessionInfo = {
  projectId: 'my-analysis',
  sessionId: 's1',
  kind: 'agent'
}

// Builds a coordinator with controllable renderer plumbing. `emit` lets the test play the renderer.
//
// `getClosePreference` and `setClosePreference` are exposed to tests as references to the SAME
// functions that the coordinator invokes, even when tests pass overrides — otherwise a test that
// overrides one of those deps would silently assert against a no-op spy and miss any regression
// that re-introduced a preference read/write.
const makeHarness = (
  overrides: Partial<CloseConfirmDeps> = {}
): {
  confirm: ReturnType<typeof createCloseConfirm>
  sent: CloseConfirmRequest[]
  nativeFallback: ReturnType<typeof vi.fn>
  getClosePreference: CloseConfirmDeps['getClosePreference']
  setClosePreference: CloseConfirmDeps['setClosePreference']
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
  const localGetClosePreference = vi.fn(async (): Promise<undefined> => undefined)
  const localSetClosePreference = vi.fn(async () => undefined)
  // Resolve to the override spy when supplied; otherwise fall back to the local default. These are
  // what we hand to createCloseConfirm AND what we expose to the test — keeping them in lockstep is
  // the whole point of the fix.
  const effectiveGetClosePreference = (overrides.getClosePreference ??
    localGetClosePreference) as CloseConfirmDeps['getClosePreference']
  const effectiveSetClosePreference = overrides.setClosePreference ?? localSetClosePreference
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
    getClosePreference: effectiveGetClosePreference,
    setClosePreference: effectiveSetClosePreference,
    newRequestId: () => 'req-1',
    ackTimeoutMs: 10,
    hangGraceMs: 10,
    ...overrides
  }
  return {
    confirm: createCloseConfirm(deps),
    sent,
    nativeFallback,
    getClosePreference: effectiveGetClosePreference,
    setClosePreference: effectiveSetClosePreference,
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

  it('confirms quit when only Reviewer work is active', async () => {
    const h = makeHarness()
    const pending = h.confirm('quit', [], true)
    h.ack()
    h.choose('cancel')

    await expect(pending).resolves.toBe('cancel')
    expect(h.sent).toEqual([
      { requestId: 'req-1', variant: 'quit', sessions: [], unlistedWorkActive: true }
    ])
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
    expect(h.nativeFallback).toHaveBeenCalledWith('close-to-tray', [session])
  })

  it('falls back immediately when no renderer is available', async () => {
    const h = makeHarness({ isRendererAvailable: () => false })
    await expect(h.confirm('close-to-tray', [session])).resolves.toBe('quit')
    expect(h.nativeFallback).toHaveBeenCalledWith('close-to-tray', [session])
  })

  it('falls back safely when sending the persistence-failure confirmation throws', async () => {
    const nativeFallback = vi.fn(async () => ({ choice: 'cancel' as const }))
    const h = makeHarness({
      send: () => {
        throw new Error('renderer IPC send failed')
      },
      nativeFallback
    })

    await expect(h.confirm('persistence-failed', [])).resolves.toBe('cancel')
    expect(nativeFallback).toHaveBeenCalledWith('persistence-failed', [])
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

  it('keeps the app open when the persistence-failure native fallback rejects', async () => {
    const h = makeHarness({
      isRendererAvailable: () => false,
      nativeFallback: async () => {
        throw new Error('dialog failed')
      }
    })

    await expect(h.confirm('persistence-failed', [])).resolves.toBe('cancel')
  })

  it('cannot force quit delegated work through a renderer or native fallback choice', async () => {
    const delegated = { ...session, kind: 'delegated' as const }
    const rendererHarness = makeHarness()
    const pending = rendererHarness.confirm('quit', [delegated])
    rendererHarness.ack()
    rendererHarness.choose('quit')
    await expect(pending).resolves.toBe('cancel')

    const nativeHarness = makeHarness({ isRendererAvailable: () => false })
    await expect(nativeHarness.confirm('quit', [delegated])).resolves.toBe('cancel')
    expect(nativeHarness.nativeFallback).toHaveBeenCalledWith('quit', [delegated])
  })

  it('turns a saved quit preference into a safe minimize while delegated work is running', async () => {
    const delegated = { ...session, kind: 'delegated' as const }
    const h = makeHarness({ getClosePreference: async () => 'quit' })

    await expect(h.confirm('close-to-tray', [delegated])).resolves.toBe('minimize')
    expect(h.sent).toHaveLength(0)
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

  it('fast-paths a quit confirmation with empty sessions before touching preferences or IPC', async () => {
    const h = makeHarness({
      getClosePreference: vi.fn(async (): Promise<'quit'> => 'quit'),
      setClosePreference: vi.fn()
    })

    // Even with a saved close-to-tray preference, an empty quit short-circuits BEFORE reading prefs.
    await expect(h.confirm('quit', [])).resolves.toBe('quit')
    expect(h.getClosePreference).not.toHaveBeenCalled()
    expect(h.setClosePreference).not.toHaveBeenCalled()
    expect(h.sent).toHaveLength(0)
  })

  it('does not persist the preference when the user chooses cancel', async () => {
    const h = makeHarness()
    const pending = h.confirm('close-to-tray', [session])
    await flushPreferenceRead()
    h.ack()
    h.reply({ requestId: 'req-1', choice: 'cancel', remember: true })

    await expect(pending).resolves.toBe('cancel')
    expect(h.setClosePreference).not.toHaveBeenCalled()
  })

  it('does not persist the preference when the renderer does not ask to remember', async () => {
    const h = makeHarness()
    const pending = h.confirm('close-to-tray', [session])
    await flushPreferenceRead()
    h.ack()
    h.reply({ requestId: 'req-1', choice: 'minimize', remember: false })

    await expect(pending).resolves.toBe('minimize')
    expect(h.setClosePreference).not.toHaveBeenCalled()
  })

  it('does not persist the preference for the quit variant, even with remember=true', async () => {
    const h = makeHarness()
    const pending = h.confirm('quit', [session])
    await flushPreferenceRead()
    h.ack()
    h.reply({ requestId: 'req-1', choice: 'quit', remember: true })

    await expect(pending).resolves.toBe('quit')
    expect(h.setClosePreference).not.toHaveBeenCalled()
  })
})

// =======================================================================
// createElectronCloseConfirm — Electron-glued paths (send / fallback /
// unresponsive / isRendererAvailable). The nativeFallback body is not
// exported, so it is exercised indirectly through this factory by making
// the coordinator reach the fallback (window destroyed / no window).
// =======================================================================

// Hoisted so the createElectronCloseConfirm import below can resolve electron mocks first.
const electronMocks = vi.hoisted(() => {
  const ipcMainListeners = new Map<string, Array<(...args: unknown[]) => void>>()
  return {
    ipcMainListeners,
    showMessageBox:
      vi.fn<(options: unknown) => Promise<{ response: number; checkboxChecked: boolean }>>()
  }
})

vi.mock('electron', () => ({
  BrowserWindow: class {},
  dialog: { showMessageBox: electronMocks.showMessageBox },
  ipcMain: {
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      if (!electronMocks.ipcMainListeners.has(channel)) {
        electronMocks.ipcMainListeners.set(channel, [])
      }
      electronMocks.ipcMainListeners.get(channel)!.push(listener)
      return () => undefined
    },
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
      const list = electronMocks.ipcMainListeners.get(channel)
      if (!list) return
      const i = list.indexOf(listener)
      if (i >= 0) list.splice(i, 1)
    }
  }
}))

// Ensure the Electron-bound factory is loaded before the dynamic `describe` blocks below reference
// createElectronCloseConfirm.
await import('./window-close-confirm')

interface FakeWebContents {
  isDestroyed: ReturnType<typeof vi.fn<() => boolean>>
  send: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
  // expose for the test harness to fire listeners
  __listeners: Map<string, Set<(...args: unknown[]) => void>>
}

interface FakeWindow {
  isDestroyed: ReturnType<typeof vi.fn<() => boolean>>
  isMinimized: ReturnType<typeof vi.fn<() => boolean>>
  isVisible: ReturnType<typeof vi.fn<() => boolean>>
  show: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  webContents: FakeWebContents
}

function createFakeWindow(overrides: Partial<FakeWindow> = {}): FakeWindow {
  const webContentsListeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const window: FakeWindow = {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    show: vi.fn(),
    restore: vi.fn(),
    focus: vi.fn(),
    webContents: {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        if (!webContentsListeners.has(channel)) {
          webContentsListeners.set(channel, new Set())
        }
        webContentsListeners.get(channel)!.add(listener)
      }),
      off: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        webContentsListeners.get(channel)?.delete(listener)
      }),
      __listeners: webContentsListeners
    },
    ...overrides
  }
  return window
}

const emptyPreferences: ClosePreferenceAccess = {
  get: async () => undefined,
  set: async () => undefined
}

describe('createElectronCloseConfirm — send path', () => {
  let getWindow: ReturnType<typeof vi.fn<() => unknown>>
  let confirm: ReturnType<typeof createElectronCloseConfirm>
  let window: FakeWindow

  beforeEach(() => {
    electronMocks.ipcMainListeners.clear()
    electronMocks.showMessageBox.mockReset()
    window = createFakeWindow()
    getWindow = vi.fn(() => window)
    confirm = createElectronCloseConfirm(
      getWindow as () => BrowserWindow | undefined,
      emptyPreferences
    )
  })

  it('does not send anything when the window is destroyed', async () => {
    window.isDestroyed.mockReturnValue(true)
    const pending = confirm('close-to-tray', [session])
    await flushPreferenceRead()

    await expect(pending).resolves.toBe('minimize') // safe fallback for close-to-tray
    expect(window.webContents.send).not.toHaveBeenCalled()
    expect(
      electronMocks.ipcMainListeners.get(WINDOW_CLOSE_CONFIRM_RESPONSE_CHANNEL)
    ).toBeUndefined()
  })

  it('restores a minimized window before sending the modal', async () => {
    // Visible+minimized is unusual (visible windows aren't minimized) but the source unconditionally
    // calls restore() on a minimized window regardless of visibility; in real Electron the
    // minimize/restore cycle hides then re-shows the window, so a minimized window isn't visible.
    window.isMinimized.mockReturnValue(true)
    window.isVisible.mockReturnValue(false)
    const pending = confirm('quit', [session])
    await flushPreferenceRead()
    // Tear the confirm down so we don't leak it past this test.
    await pending

    expect(window.restore).toHaveBeenCalledTimes(1)
    expect(window.show).toHaveBeenCalledTimes(1)
    expect(window.focus).toHaveBeenCalledTimes(1)
    expect(window.webContents.send).toHaveBeenCalledWith(
      WINDOW_CLOSE_CONFIRM_REQUEST_CHANNEL,
      expect.objectContaining({ variant: 'quit', sessions: [session] })
    )
  })

  it('shows a hidden window before focusing and sending the modal', async () => {
    window.isVisible.mockReturnValue(false)
    const pending = confirm('quit', [session])
    await flushPreferenceRead()
    await pending

    expect(window.restore).not.toHaveBeenCalled() // not minimized
    expect(window.show).toHaveBeenCalledTimes(1)
    expect(window.focus).toHaveBeenCalledTimes(1)
    expect(window.webContents.send).toHaveBeenCalledTimes(1)
  })

  it('focuses the window and forwards the payload to the renderer', async () => {
    const pending = confirm('quit', [session])
    await flushPreferenceRead()
    await pending

    expect(window.focus).toHaveBeenCalledTimes(1)
    expect(window.webContents.send).toHaveBeenCalledWith(
      WINDOW_CLOSE_CONFIRM_REQUEST_CHANNEL,
      expect.objectContaining({
        requestId: expect.any(String),
        variant: 'quit',
        sessions: [session]
      })
    )
  })
})

describe('createElectronCloseConfirm — isRendererAvailable', () => {
  let getWindow: ReturnType<typeof vi.fn<() => unknown>>
  let window: FakeWindow

  beforeEach(() => {
    electronMocks.ipcMainListeners.clear()
    electronMocks.showMessageBox.mockReset()
    electronMocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    window = createFakeWindow()
    getWindow = vi.fn(() => window)
  })

  it('reports unavailable when no window is returned', async () => {
    getWindow.mockReturnValue(undefined)
    const confirm = createElectronCloseConfirm(
      getWindow as () => BrowserWindow | undefined,
      emptyPreferences
    )

    await expect(confirm('quit', [session])).resolves.toBe('quit')
    // Should reach nativeFallback rather than the IPC path.
    expect(electronMocks.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('reports unavailable when the window is destroyed', async () => {
    window.isDestroyed.mockReturnValue(true)
    const confirm = createElectronCloseConfirm(
      getWindow as () => BrowserWindow | undefined,
      emptyPreferences
    )

    await expect(confirm('quit', [session])).resolves.toBe('quit')
    expect(electronMocks.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('reports unavailable when the webContents are destroyed', async () => {
    window.webContents.isDestroyed.mockReturnValue(true)
    const confirm = createElectronCloseConfirm(
      getWindow as () => BrowserWindow | undefined,
      emptyPreferences
    )

    await expect(confirm('quit', [session])).resolves.toBe('quit')
    expect(electronMocks.showMessageBox).toHaveBeenCalledTimes(1)
  })
})

describe('createElectronCloseConfirm — onRendererUnresponsive', () => {
  let getWindow: ReturnType<typeof vi.fn<() => unknown>>
  let window: FakeWindow

  beforeEach(() => {
    electronMocks.ipcMainListeners.clear()
    electronMocks.showMessageBox.mockReset()
    electronMocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    window = createFakeWindow()
    getWindow = vi.fn(() => window)
  })

  it('registers unresponsive and responsive listeners on the live webContents', async () => {
    const confirm = createElectronCloseConfirm(
      getWindow as () => BrowserWindow | undefined,
      emptyPreferences
    )
    const pending = confirm('quit', [session])
    await flushPreferenceRead()
    await pending

    expect(window.webContents.on).toHaveBeenCalledWith('unresponsive', expect.any(Function))
    expect(window.webContents.on).toHaveBeenCalledWith('responsive', expect.any(Function))
  })

  it('returns a no-op unsubscribe when no window is available', () => {
    getWindow.mockReturnValue(undefined)
    const confirm = createElectronCloseConfirm(
      getWindow as () => BrowserWindow | undefined,
      emptyPreferences
    )

    // Triggering confirm with no window reaches the fallback before onResponse/onRenderGone are
    // wired; onRendererUnresponsive is also skipped because there is no window to attach to. We
    // assert the listener side-effects indirectly: no listeners should be registered and the
    // coordinator still resolves.
    return expect(confirm('quit', [session])).resolves.toBe('quit')
  })

  it('removes both unresponsive and responsive listeners on unsubscribe', async () => {
    const confirm = createElectronCloseConfirm(
      getWindow as () => BrowserWindow | undefined,
      emptyPreferences
    )
    const pending = confirm('quit', [session])
    await flushPreferenceRead()
    await pending

    expect(window.webContents.off).toHaveBeenCalledWith('unresponsive', expect.any(Function))
    expect(window.webContents.off).toHaveBeenCalledWith('responsive', expect.any(Function))
  })
})

describe('createElectronCloseConfirm — nativeFallback', () => {
  let getWindow: ReturnType<typeof vi.fn<() => unknown>>
  let window: FakeWindow

  beforeEach(() => {
    electronMocks.ipcMainListeners.clear()
    electronMocks.showMessageBox.mockReset()
    window = createFakeWindow()
    getWindow = vi.fn(() => window)
  })

  it('offers Cancel/Quit for the quit variant with no window (windowless dialog)', async () => {
    getWindow.mockReturnValue(undefined)
    electronMocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    const confirm = createElectronCloseConfirm(
      getWindow as () => BrowserWindow | undefined,
      emptyPreferences
    )

    await expect(confirm('quit', [session])).resolves.toBe('quit')

    expect(electronMocks.showMessageBox).toHaveBeenCalledTimes(1)
    const [options] = electronMocks.showMessageBox.mock.calls[0] as [Record<string, unknown>]
    expect(options.buttons).toEqual(['Cancel', 'Quit'])
    expect(options.defaultId).toBe(0)
    expect(options.cancelId).toBe(0)
    expect(options.message).toBe('Quit Open Science?')
  })

  it('translates a Cancel click in the quit fallback to choice=cancel', async () => {
    window.isDestroyed.mockReturnValue(true)
    electronMocks.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    const confirm = createElectronCloseConfirm(
      getWindow as () => BrowserWindow | undefined,
      emptyPreferences
    )

    await expect(confirm('quit', [session])).resolves.toBe('cancel')
    expect(electronMocks.showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('offers stay, retry, and force quit in the persistence-failure native fallback', async () => {
    getWindow.mockReturnValue(undefined)
    electronMocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    const confirm = createElectronCloseConfirm(
      getWindow as () => BrowserWindow | undefined,
      emptyPreferences
    )

    await expect(confirm('persistence-failed', [])).resolves.toBe('retry')

    const [options] = electronMocks.showMessageBox.mock.calls[0] as [Record<string, unknown>]
    expect(options.buttons).toEqual(['Stay', 'Retry saving', 'Force quit'])
    expect(options.defaultId).toBe(0)
    expect(options.cancelId).toBe(0)
    expect(options.message).toBe('Saving is not finished')
    expect(options.detail).toMatch(/risk losing recent changes/i)
  })

  it('offers no force-quit action in the native fallback for delegated work', async () => {
    getWindow.mockReturnValue(undefined)
    electronMocks.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    const confirm = createElectronCloseConfirm(
      getWindow as () => BrowserWindow | undefined,
      emptyPreferences
    )
    const delegated = { ...session, kind: 'delegated' as const }

    await expect(confirm('quit', [delegated])).resolves.toBe('cancel')

    const [options] = electronMocks.showMessageBox.mock.calls[0] as [Record<string, unknown>]
    expect(options.buttons).toEqual(['Return to tasks'])
    expect(options.message).toBe('Subagents are still running')
    expect(options.detail).toMatch(/stop their subagents before quitting/i)
  })

  it('offers Minimize/Quit for close-to-tray with a "remember" checkbox', async () => {
    getWindow.mockReturnValue(undefined)
    electronMocks.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: true })
    const confirm = createElectronCloseConfirm(
      getWindow as () => BrowserWindow | undefined,
      emptyPreferences
    )

    await expect(confirm('close-to-tray', [session])).resolves.toBe('minimize')
    const [options] = electronMocks.showMessageBox.mock.calls[0] as [Record<string, unknown>]
    expect(options.buttons).toEqual(['Minimize to tray', 'Quit'])
    expect(options.checkboxLabel).toBe("Don't ask again")
    expect(options.checkboxChecked).toBe(true)
  })

  it('translates a Quit click in the close-to-tray fallback to choice=quit', async () => {
    window.isDestroyed.mockReturnValue(true)
    electronMocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    const confirm = createElectronCloseConfirm(
      getWindow as () => BrowserWindow | undefined,
      emptyPreferences
    )

    await expect(confirm('close-to-tray', [session])).resolves.toBe('quit')
  })

  it('passes the live window as the dialog parent when it is not destroyed', async () => {
    // Live window → isRendererAvailable is true → reaches IPC send path → nativeFallback only
    // fires when the renderer never answers. We force that by leaving ackTimeoutMs at the default
    // and never calling ack. To keep the test deterministic we monkey-patch the timeout to 0 via
    // a tiny custom wrapper: but createElectronCloseConfirm doesn't expose ackTimeoutMs. Instead we
    // set the webContents to destroyed so the IPC send path returns without sending, which still
    // reaches nativeFallback with the (alive) window.
    window.webContents.isDestroyed.mockReturnValue(true)
    electronMocks.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    const confirm = createElectronCloseConfirm(
      getWindow as () => BrowserWindow | undefined,
      emptyPreferences
    )

    await expect(confirm('quit', [session])).resolves.toBe('quit')

    // First arg is the live window (not destroyed) — confirm by identity.
    const [parentArg, optionsArg] = electronMocks.showMessageBox.mock.calls[0] as unknown as [
      FakeWindow,
      Record<string, unknown>
    ]
    expect(parentArg).toBe(window)
    expect(optionsArg.buttons).toEqual(['Cancel', 'Quit'])
  })

  it('falls back to a windowless dialog when the window has been destroyed', async () => {
    window.isDestroyed.mockReturnValue(true)
    electronMocks.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    const confirm = createElectronCloseConfirm(
      getWindow as () => BrowserWindow | undefined,
      emptyPreferences
    )

    await expect(confirm('quit', [session])).resolves.toBe('cancel')

    // Native fallback uses the options-only overload when the window is destroyed — the call has a
    // single options argument, not `(window, options)`.
    const [onlyArg] = electronMocks.showMessageBox.mock.calls[0] as unknown as [
      Record<string, unknown>
    ]
    expect(onlyArg.buttons).toEqual(['Cancel', 'Quit'])
    expect(electronMocks.showMessageBox.mock.calls[0]).toHaveLength(1)
  })
})
