import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: host.spawn }))
import {
  getWindowsRuntimeAccess,
  setWindowsRuntimeAccess
} from '../runtime/src/platform/windows-appcontainer.js'

const reply = (value: unknown, code = 0): void => {
  host.spawn.mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough()
    })
    queueMicrotask(() => {
      if (code === 0) child.stdout.end(JSON.stringify(value))
      else child.stderr.end('pending owned operation')
      child.emit('close', code)
    })
    return child
  })
}
beforeEach(() => host.spawn.mockReset())

it.each([true, false])(
  'reads R access without starting elevation (authorized: %s)',
  async (authorized) => {
    reply({ authorized, registered: true })
    await expect(
      getWindowsRuntimeAccess('host.exe', 'installation', 'owner-root', 'Rscript.exe')
    ).resolves.toEqual({ authorized, registered: true })
    expect(host.spawn).toHaveBeenCalledExactlyOnceWith(
      'host.exe',
      ['runtime-access-status', 'installation', 'owner-root', 'Rscript.exe'],
      expect.objectContaining({ windowsHide: true })
    )
  }
)

it.each([null, {}, { authorized: 'true', registered: true }, { authorized: true, registered: 1 }])(
  'rejects malformed native access status without elevation: %j',
  async (status) => {
    reply(status)
    await expect(
      getWindowsRuntimeAccess('host.exe', 'installation', 'owner-root', 'Rscript.exe')
    ).rejects.toThrow('invalid runtime access status')
    expect(host.spawn).toHaveBeenCalledOnce()
  }
)

it('does not elevate when the native owner cannot inspect its receipt', async () => {
  reply(null, 1)
  await expect(
    setWindowsRuntimeAccess('host.exe', 'installation', 'owner-root', 'Rscript.exe', true)
  ).rejects.toThrow('pending owned operation')
  expect(host.spawn).toHaveBeenCalledOnce()
})

it('keeps an existing R authorization idempotent without UAC', async () => {
  reply({ authorized: true, registered: true })
  await expect(
    setWindowsRuntimeAccess('host.exe', 'installation', 'owner-root', 'Rscript.exe', true)
  ).resolves.toEqual({ cancelled: false })
  expect(host.spawn).toHaveBeenCalledOnce()
})

it('finishes an accepted native authorization before returning', async () => {
  reply({ authorized: false, registered: false })
  reply(null)
  reply(null)
  reply(null)
  await expect(
    setWindowsRuntimeAccess('host.exe', 'installation', 'owner-root', 'Rscript.exe', true)
  ).resolves.toEqual({ cancelled: false })
  expect(
    host.spawn.mock.calls.map(([program, args]) => (program === 'powershell.exe' ? 'uac' : args[0]))
  ).toEqual(['runtime-access-status', 'prepare-runtime-access', 'uac', 'finish-setup'])
})

it('cancels the native setup journal when Windows declines UAC', async () => {
  reply({ authorized: false, registered: false })
  reply(null)
  reply(null, 1223)
  reply(null)
  await expect(
    setWindowsRuntimeAccess('host.exe', 'installation', 'owner-root', 'Rscript.exe', true)
  ).resolves.toEqual({ cancelled: true })
  expect(
    host.spawn.mock.calls.map(([program, args]) => (program === 'powershell.exe' ? 'uac' : args[0]))
  ).toEqual(['runtime-access-status', 'prepare-runtime-access', 'uac', 'cancel-setup'])
})
