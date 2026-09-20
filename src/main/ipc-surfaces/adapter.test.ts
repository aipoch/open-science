import { afterEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ channels: new Set<string>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string) => {
      if (native.channels.has(channel)) throw new Error(`duplicate channel: ${channel}`)
      native.channels.add(channel)
    },
    removeHandler: (channel: string) => native.channels.delete(channel)
  }
}))

import { createElectronSurfaceAdapter } from './adapter'
import { disposeIpcHandlerRegistry, ipcMainHandle } from '../ipc-handler-registry'

afterEach(() => disposeIpcHandlerRegistry())

it('removes channels even when auxiliary cleanup fails and runs cleanup only once', async () => {
  const failure = new Error('auxiliary cleanup failed')
  const cleanup = vi.fn(() => {
    throw failure
  })
  const adapter = createElectronSurfaceAdapter('test', () => {
    ipcMainHandle('test:owned', () => undefined)
    return cleanup
  })
  expect(native.channels.size).toBe(0)
  const installation = await adapter.install()
  expect(() => installation.uninstall()).toThrow(failure)
  expect(native.channels.size).toBe(0)
  await installation.uninstall()
  expect(cleanup).toHaveBeenCalledOnce()
})

it('preserves an earlier surface when a duplicate registration aborts a later surface', async () => {
  const earlier = await createElectronSurfaceAdapter('earlier', () => {
    ipcMainHandle('test:shared', () => undefined)
  }).install()
  const later = createElectronSurfaceAdapter('later', () => {
    ipcMainHandle('test:partial', () => undefined)
    ipcMainHandle('test:shared', () => undefined)
  })
  expect(() => later.install()).toThrow('duplicate channel: test:shared')
  expect([...native.channels]).toEqual(['test:shared'])
  await earlier.uninstall()
  expect(native.channels.size).toBe(0)
})
