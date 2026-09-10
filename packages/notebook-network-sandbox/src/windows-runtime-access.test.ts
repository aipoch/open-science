import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

it.skipIf(process.platform !== 'win32')(
  'reports a real elevation launch error instead of claiming the user cancelled',
  async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    reply({ authorized: false, registered: false })
    reply(null)
    verifierReply()
    host.spawn.mockImplementationOnce((program, args, options) =>
      actual.spawn(program, args, options)
    )
    reply(null)
    const missingHost = join(tmpdir(), `missing-r-access-helper-${process.pid}-${Date.now()}.exe`)
    await expect(
      setWindowsRuntimeAccess(missingHost, 'installation', 'owner-root', 'Rscript.exe', true, {
        ...verification,
        argv: [missingHost, 'launch', 'installation', 'owner-root', 'spec']
      })
    ).rejects.toThrow()
    expect(host.spawn.mock.calls.at(-1)?.[1][0]).toBe('cancel-setup')
  }
)

const verification = {
  argv: ['host.exe', 'launch', 'installation', 'owner-root', 'fixed-probe-spec'],
  env: { SystemRoot: 'C:\\Windows', PATH: 'selected-runtime-dlls' }
}

const verifierReply = (code?: number): { kill: ReturnType<typeof vi.fn> } => {
  const child = Object.assign(new EventEmitter(), {
    pid: 1234,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      child.emit('close', 1)
      return true
    })
  })
  host.spawn.mockImplementationOnce(() => {
    if (code !== undefined)
      queueMicrotask(() => {
        if (code !== 0) child.stderr.write('contained jsonlite is unavailable')
        child.emit('close', code)
      })
    return child
  })
  return child
}

it.skipIf(process.platform !== 'win32').each([1223, 5])(
  'classifies the native elevation error code without relying on message text (%s)',
  async (nativeCode) => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    reply({ authorized: false, registered: false })
    reply(null)
    verifierReply()
    host.spawn.mockImplementationOnce((program, args, options) => {
      const script = Buffer.from(args[4], 'base64').toString('utf16le')
      // Exercise the real PowerShell exception chain without opening a UAC prompt.
      const fixture = `Add-Type -TypeDefinition 'public class ElevationFailure { public static System.Diagnostics.Process Start(System.Diagnostics.ProcessStartInfo info) { throw new System.ComponentModel.Win32Exception(${nativeCode}, "fixture error text contains 1223"); } }'; `
      const fixtureScript = script.replace(
        '[System.Diagnostics.Process]::Start($start)',
        '[ElevationFailure]::Start($start)'
      )
      return actual.spawn(
        program,
        [...args.slice(0, 4), Buffer.from(fixture + fixtureScript, 'utf16le').toString('base64')],
        options
      )
    })
    reply(null)
    const result = setWindowsRuntimeAccess(
      'host.exe',
      'installation',
      'owner-root',
      'Rscript.exe',
      true,
      verification
    )
    if (nativeCode === 1223) await expect(result).resolves.toEqual({ cancelled: true })
    else await expect(result).rejects.toThrow('fixture error text contains 1223')
  }
)

it('commits verified runtime access with one elevation and the original contained environment', async () => {
  reply({ authorized: false, registered: false })
  reply(null)
  verifierReply(0)
  reply(null)
  await expect(
    setWindowsRuntimeAccess(
      'host.exe',
      'installation',
      'owner-root',
      'Rscript.exe',
      true,
      verification
    )
  ).resolves.toEqual({ cancelled: false })
  expect(
    host.spawn.mock.calls.map(([program, args]) => (program === 'powershell.exe' ? 'uac' : args[0]))
  ).toEqual([
    'runtime-access-status',
    'prepare-verified-runtime-access',
    'verify-runtime-access',
    'uac'
  ])
  expect(host.spawn.mock.calls[2]).toEqual([
    'host.exe',
    [
      'verify-runtime-access',
      'installation',
      'owner-root',
      expect.stringMatching(/^[a-f0-9]{64}$/),
      String(process.pid),
      'fixed-probe-spec'
    ],
    expect.objectContaining({ env: verification.env, windowsHide: true })
  ])
  const script = Buffer.from(host.spawn.mock.calls[3]![1][4], 'base64').toString('utf16le')
  expect(script).toContain('authorize-runtime-access')
  expect(script).toContain('"1234"')
  expect(script).toContain(`"${process.pid}"`)
  expect(script).not.toContain('fixed-probe-spec')
})

it('returns contained verification failure without starting another elevation', async () => {
  reply({ authorized: false, registered: false })
  reply(null)
  verifierReply(1)
  reply(null, 1)
  reply(null)
  await expect(
    setWindowsRuntimeAccess(
      'host.exe',
      'installation',
      'owner-root',
      'Rscript.exe',
      true,
      verification
    )
  ).rejects.toThrow('contained jsonlite is unavailable')
  expect(host.spawn.mock.calls.filter(([program]) => program === 'powershell.exe')).toHaveLength(1)
  expect(host.spawn.mock.calls.at(-1)?.[1][0]).toBe('cancel-setup')
})

it('stops the waiting verifier when the user cancels UAC', async () => {
  reply({ authorized: false, registered: false })
  reply(null)
  const verifier = verifierReply()
  reply(null, 1223)
  reply(null)
  await expect(
    setWindowsRuntimeAccess(
      'host.exe',
      'installation',
      'owner-root',
      'Rscript.exe',
      true,
      verification
    )
  ).resolves.toEqual({ cancelled: true })
  expect(verifier.kill).toHaveBeenCalledOnce()
  expect(host.spawn.mock.calls.filter(([program]) => program === 'powershell.exe')).toHaveLength(1)
})

it('does not classify an interrupted verifier as cancellation before the probe started', async () => {
  const controller = new AbortController()
  reply({ authorized: false, registered: false })
  reply(null)
  const verifier = verifierReply()
  host.spawn.mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough()
    })
    queueMicrotask(() => {
      controller.abort()
      child.stderr.end('verification interrupted after elevation')
      child.emit('close', 1)
    })
    return child
  })
  reply(null)
  await expect(
    setWindowsRuntimeAccess('host.exe', 'installation', 'owner-root', 'Rscript.exe', true, {
      ...verification,
      signal: controller.signal
    })
  ).rejects.toThrow('verification interrupted after elevation')
  expect(verifier.kill).toHaveBeenCalledOnce()
  expect(host.spawn.mock.calls.at(-1)?.[1][0]).toBe('cancel-setup')
})

it('refuses a verifier belonging to another installation before preparing permissions', async () => {
  reply({ authorized: false, registered: false })
  await expect(
    setWindowsRuntimeAccess('host.exe', 'installation', 'owner-root', 'Rscript.exe', true, {
      ...verification,
      argv: ['host.exe', 'launch', 'other-installation', 'owner-root', 'spec']
    })
  ).rejects.toThrow('contained launch')
  expect(host.spawn).toHaveBeenCalledOnce()
})

it('still reports a broken contained runtime when explicitly verifying an existing grant', async () => {
  reply({ authorized: true, registered: true })
  reply(null, 1)
  await expect(
    setWindowsRuntimeAccess(
      'host.exe',
      'installation',
      'owner-root',
      'Rscript.exe',
      true,
      verification
    )
  ).rejects.toThrow('pending owned operation')
  expect(host.spawn.mock.calls.map(([, args]) => args[0])).toEqual([
    'runtime-access-status',
    'launch'
  ])
})
