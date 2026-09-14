import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createStartupPresentation } from './startup-presentation'

// The fixture intentionally preserves Vitest's inferred mock types for assertions.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function setup() {
  const ipc = new EventEmitter()
  const webContents = Object.assign(new EventEmitter(), { mainFrame: {} })
  const window = Object.assign(new EventEmitter(), {
    webContents,
    isDestroyed: () => false,
    show: vi.fn(),
    focus: vi.fn()
  })
  const presenter = { update: vi.fn(), complete: vi.fn(), fail: vi.fn(), focus: vi.fn() }
  const reveal = vi.fn()
  const owner = createStartupPresentation({ ipc, window, presenter, reveal })
  const send = (phase: string, frame: object = webContents.mainFrame): boolean =>
    ipc.emit('startup-presentation:phase', { sender: webContents, senderFrame: frame }, phase)
  return { ipc, window, presenter, reveal, owner, send }
}

describe('continuous startup presentation', () => {
  it('keeps the progress surface until an interactive renderer is painted', () => {
    const s = setup()
    s.send('startup-settings')
    s.send('startup-sessions')
    expect(s.reveal).not.toHaveBeenCalled()
    expect(s.owner.focus()).toBe(true)
    expect(s.presenter.focus).toHaveBeenCalledOnce()
    s.send('interactive')
    expect(s.reveal).toHaveBeenCalledOnce()
    expect(s.presenter.complete).toHaveBeenCalledOnce()
    expect(s.owner.focus()).toBe(false)
    s.send('interactive')
    expect(s.reveal).toHaveBeenCalledOnce()
    expect(s.ipc.listenerCount('startup-presentation:phase')).toBe(0)
  })
  it('does not accept another frame, another window or arbitrary phases', () => {
    const s = setup()
    s.send('interactive', {})
    s.ipc.emit(
      'startup-presentation:phase',
      { sender: {}, senderFrame: s.window.webContents.mainFrame },
      'interactive'
    )
    s.send('completed')
    expect(s.reveal).not.toHaveBeenCalled()
    expect(s.presenter.update).not.toHaveBeenCalled()
    s.owner.dispose()
  })
  it('reveals an actionable database error before runtime startup completes', () => {
    const s = setup()
    s.send('blocked')
    expect(s.reveal).toHaveBeenCalledOnce()
    expect(s.presenter.complete).toHaveBeenCalledOnce()
  })
  it('retains startup diagnostics if the hidden renderer dies', () => {
    const s = setup()
    s.window.webContents.emit('render-process-gone')
    expect(s.presenter.fail).toHaveBeenCalledOnce()
    expect(s.reveal).not.toHaveBeenCalled()
    s.owner.dispose()
  })
})
