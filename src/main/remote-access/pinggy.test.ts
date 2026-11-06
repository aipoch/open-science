import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'

import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock
}))

import { PinggyTunnel } from './pinggy'

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  spawnMock.mockReset()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PinggyTunnel', () => {
  it('keeps a ready tunnel alive after the startup timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-pinggy-'))
    roots.push(root)
    await mkdir(join(root, 'remote-access'))
    await writeFile(join(root, 'remote-access', 'pinggy_ed25519'), '')

    const child = new EventEmitter() as ChildProcess
    const stdout = new EventEmitter()
    Object.assign(child, { pid: 12345, stdout, stderr: new EventEmitter() })
    spawnMock.mockReturnValue(child)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const onUrl = vi.fn()
    const onDisconnect = vi.fn()
    vi.useFakeTimers()

    const tunnel = new PinggyTunnel(root, 4180, 'auto', undefined, onUrl, onDisconnect)
    await tunnel.start()
    stdout.emit('data', Buffer.from('https://example.pinggy-free.link'))
    expect(onUrl).toHaveBeenCalledWith('https://example.pinggy-free.link')

    await vi.advanceTimersByTimeAsync(31_000)
    expect(kill).not.toHaveBeenCalled()
    expect(onDisconnect).not.toHaveBeenCalled()
    tunnel.stop()
  })
})
