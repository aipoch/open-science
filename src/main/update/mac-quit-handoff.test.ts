import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { macQuitHandoff } from './mac-quit-handoff'

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
  mkdirSync: vi.fn(),
  spawn: vi.fn()
}))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  existsSync: mocks.existsSync,
  lstatSync: mocks.lstatSync,
  mkdirSync: mocks.mkdirSync
}))

describe('macOS quit handoff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('process', { ...process, getuid: () => 501, resourcesPath: '/app/Resources' })
    mocks.existsSync.mockReturnValue(true)
    mocks.lstatSync.mockReturnValue({ isDirectory: () => true, uid: 501, mode: 0o700 })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('starts normally when there is no handoff or its directory is not private', async () => {
    mocks.existsSync.mockReturnValueOnce(false)
    expect(await macQuitHandoff('reopen', '1', [])).toBe(false)
    mocks.lstatSync.mockReturnValueOnce({ isDirectory: () => true, uid: 502, mode: 0o700 })
    expect(await macQuitHandoff('reopen', '1', [])).toBe(false)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('transfers successive launch requests over IPC before yielding the GUI', async () => {
    const child = Object.assign(new EventEmitter(), {
      connected: true,
      disconnect: vi.fn(),
      unref: vi.fn(),
      send: vi.fn((_request, sent) => sent())
    })
    mocks.spawn.mockReturnValue(child)
    const file = 'file:///studies/test.science'
    const link = 'open-science://open'
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce({ args: [], urls: [file] })
      .mockResolvedValue({ args: [], urls: [file, link] })
    const pending = macQuitHandoff('reopen', '1', [], snapshot)
    child.emit('message', 'armed')
    expect(await pending).toBe(true)
    expect(child.send.mock.calls.map(([request]) => request.urls)).toEqual([[file], [file, link]])
    expect(mocks.spawn.mock.calls[0][1]).not.toContain(file)
    expect(child.disconnect).toHaveBeenCalledOnce()
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('bounds an unresponsive observer and preserves normal startup on IPC failure', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), {
      connected: true,
      disconnect: vi.fn(),
      unref: vi.fn(),
      kill: vi.fn(),
      send: vi.fn((_request, sent) => sent(new Error('closed')))
    })
    mocks.spawn.mockReturnValue(child)
    const watching = macQuitHandoff('watch', '1', ['/cache', '2'])
    await vi.advanceTimersByTimeAsync(2500)
    expect(await watching).toBe(false)
    expect(child.kill).toHaveBeenCalledOnce()
    const reopening = macQuitHandoff('reopen', '1', [], async () => ({ args: [], urls: [] }))
    child.emit('message', 'armed')
    expect(await reopening).toBe(false)
  })
})

const { readHandoffLine } = createRequire(import.meta.url)('../../../build/mac-quit-handoff.cjs')

describe('macOS handoff framing', () => {
  it.each(['reopen', JSON.stringify({ targetVersion: '1.3.2' })])(
    'waits for a complete handshake and delivers it once: %s',
    (line) => {
      const peer = new PassThrough()
      const received = vi.fn()
      readHandoffLine(peer, received)
      for (const byte of Buffer.from(line)) peer.write(Buffer.from([byte]))
      expect(received).not.toHaveBeenCalled()
      peer.end('\nextra\n')
      expect(received.mock.calls).toEqual([[line]])
    }
  )

  it('closes the peer when an unterminated handshake grows too large', () => {
    const peer = new PassThrough()
    const received = vi.fn()
    readHandoffLine(peer, received)
    peer.write(Buffer.alloc(1024))
    peer.write('x')
    expect(peer.destroyed).toBe(true)
    expect(received).not.toHaveBeenCalled()
  })
})
