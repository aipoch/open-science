import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acknowledgeWindowsUpdateReady,
  cleanupWindowsUpdateHandoffs,
  createWindowsUpdateRequest,
  windowsUpdateOperation,
  windowsUpdateReceipt,
  windowsUpdateHandoffRoot,
  writeWindowsUpdateFile,
  WINDOWS_UPDATE_OPERATION_ARG,
  resolveWindowsUpdateStartup,
  waitForWindowsUpdateWindow
} from './windows-update-handoff'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'update-receipts-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})
const config = (): {
  configRoot: string
  dataRoot: string
  profilePath: string
  port: number
  host: '127.0.0.1'
  credentialStore: 'os'
} => ({
  configRoot: join(root, 'config'),
  dataRoot: join(root, 'data'),
  profilePath: join(root, 'profile'),
  port: 44100,
  host: '127.0.0.1',
  credentialStore: 'os'
})
async function setup(): Promise<{
  directory: string
  operationId: string
  ready: Parameters<typeof acknowledgeWindowsUpdateReady>[0]
}> {
  const startupOptions = config()
  const { directory, request } = await createWindowsUpdateRequest(root, {
    targetVersion: '1.0.2',
    applicationPath: join(root, 'app.exe'),
    installerPath: join(root, 'installer.exe'),
    profilePath: startupOptions.profilePath,
    startupOptions
  })
  const operationId = request.operationId
  await writeWindowsUpdateFile(
    join(directory, 'installed.receipt'),
    windowsUpdateReceipt(operationId, 'installed')
  )
  return {
    directory,
    operationId,
    ready: {
      appData: root,
      args: [WINDOWS_UPDATE_OPERATION_ARG + operationId],
      version: request.targetVersion,
      applicationPath: request.applicationPath,
      profilePath: request.profilePath,
      waitForPresentation: async () => {},
      verifyReady: vi.fn(async () => {})
    }
  }
}

describe('Windows update presentation receipts', () => {
  it('requires exact operation, target, profile and backend/data readiness before acknowledging', async () => {
    const { directory, operationId, ready } = await setup()
    let finish!: () => void
    ready.verifyReady = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const result = acknowledgeWindowsUpdateReady(ready)
    await vi.waitFor(() => expect(ready.verifyReady).toHaveBeenCalledWith(config()))
    await expect(readFile(join(directory, 'ready.receipt'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    finish()
    expect(await result).toBe(true)
    expect(await readFile(join(directory, 'ready.receipt'), 'utf8')).toBe(
      windowsUpdateReceipt(operationId, 'ready')
    )
  })
  it.each(['version', 'applicationPath', 'profilePath'] as const)(
    'rejects a different successor %s',
    async (field) => {
      const { directory, ready } = await setup()
      ready[field] += '-different'
      await expect(acknowledgeWindowsUpdateReady(ready)).rejects.toThrow('does not match')
      expect(ready.verifyReady).not.toHaveBeenCalled()
      expect(await readdir(directory)).not.toContain('ready.receipt')
    }
  )
  it('restores the original profile and configuration only for the matching installed target', async () => {
    const { ready } = await setup()
    expect((await resolveWindowsUpdateStartup(ready))?.startupOptions).toEqual(config())
    await expect(resolveWindowsUpdateStartup({ ...ready, version: 'other' })).rejects.toThrow(
      'does not match'
    )
    expect(await resolveWindowsUpdateStartup({ ...ready, args: [] })).toBeUndefined()
  })
  it.each(['missing', 'corrupt'])(
    'rejects %s startup configuration instead of selecting a default profile',
    async (scenario) => {
      const { directory, ready } = await setup()
      const request = join(directory, 'request.json')
      if (scenario === 'missing') await rm(request)
      else await writeFile(request, '{invalid')
      await expect(resolveWindowsUpdateStartup(ready)).rejects.toThrow()
    }
  )
  it('does not reuse previous readiness for the next update operation', async () => {
    const previous = await setup()
    await acknowledgeWindowsUpdateReady(previous.ready)
    const current = await setup()
    expect(current.operationId).not.toBe(previous.operationId)
    expect((await resolveWindowsUpdateStartup(previous.ready))?.confirmed).toBe(true)
    expect((await resolveWindowsUpdateStartup(current.ready))?.confirmed).toBe(false)
    await writeFile(
      join(current.directory, 'ready.receipt'),
      windowsUpdateReceipt(previous.operationId, 'ready')
    )
    await expect(resolveWindowsUpdateStartup(current.ready)).rejects.toThrow('readiness receipt')
  })
  it('retains configuration through successor lifetime and a later Electron relaunch', async () => {
    const { directory, operationId, ready } = await setup()
    const requestPath = join(directory, 'request.json')
    const request = JSON.parse(await readFile(requestPath, 'utf8'))
    request.parentPid = 2147483647
    request.helperPid = 2147483646
    await writeFile(requestPath, JSON.stringify(request))
    expect((await resolveWindowsUpdateStartup(ready))?.startupOptions).toEqual(config())
    await acknowledgeWindowsUpdateReady(ready)
    await writeWindowsUpdateFile(
      join(directory, 'closed.receipt'),
      windowsUpdateReceipt(operationId, 'closed')
    )
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === process.pid) return true
      throw Object.assign(new Error('not running'), { code: 'ESRCH' })
    })
    await cleanupWindowsUpdateHandoffs(root)
    const subsequent = await resolveWindowsUpdateStartup(ready)
    expect(subsequent?.startupOptions).toEqual(config())
    expect(subsequent?.confirmed).toBe(true) // Normal relaunch no longer asserts the old dataRoot.
    kill.mockImplementation(() => {
      throw Object.assign(new Error('not running'), { code: 'ESRCH' })
    })
    await cleanupWindowsUpdateHandoffs(root)
    // Another profile may clean during the no-live-PID gap of Electron relaunch.
    expect((await resolveWindowsUpdateStartup(ready))?.startupOptions).toEqual(config())
  })
  it('does not acknowledge when the original data cannot be read', async () => {
    const { directory, ready } = await setup()
    ready.verifyReady = async () => {
      throw new Error('Original data unavailable')
    }
    await expect(acknowledgeWindowsUpdateReady(ready)).rejects.toThrow('Original data unavailable')
    expect(await readdir(directory)).not.toContain('ready.receipt')
  })
  it('rejects a stale or partially written installer receipt', async () => {
    const { directory, ready } = await setup()
    for (const contents of ['other-operation\r\ninstalled\r\n', '']) {
      await writeFile(join(directory, 'installed.receipt'), contents)
      await expect(acknowledgeWindowsUpdateReady(ready)).rejects.toThrow('receipt')
    }
    expect(ready.verifyReady).not.toHaveBeenCalled()
  })
  it('keeps ordinary launches compatible and rejects path/duplicate operation arguments', async () => {
    const { ready } = await setup()
    expect(await acknowledgeWindowsUpdateReady({ ...ready, args: [] })).toBe(false)
    expect(() => windowsUpdateOperation([WINDOWS_UPDATE_OPERATION_ARG + '../outside'])).toThrow()
    expect(() => windowsUpdateOperation([...ready.args, ...ready.args])).toThrow('Ambiguous')
  })
  it('publishes complete files and leaves no temporary file after a failed publication', async () => {
    const path = join(root, 'receipt')
    await writeWindowsUpdateFile(path, 'complete')
    expect(await readFile(path, 'utf8')).toBe('complete')
    const conflict = join(root, 'directory')
    await mkdir(conflict)
    await expect(writeWindowsUpdateFile(conflict, 'cannot replace a directory')).rejects.toThrow()
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
  it('removes an aborted dead attempt including owned publication leftovers', async () => {
    const { directory, operationId } = await setup()
    await writeFile(join(directory, 'closed.receipt'), windowsUpdateReceipt(operationId, 'closed'))
    await writeFile(
      join(directory, 'aborted.receipt'),
      windowsUpdateReceipt(operationId, 'aborted')
    )
    await writeFile(join(directory, 'closed.receipt.tmp'), 'partial')
    await writeFile(join(directory, `request.json.${operationId}.tmp`), 'partial')
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    })
    await cleanupWindowsUpdateHandoffs(root)
    await expect(readFile(join(directory, 'request.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
  it('removes only closed terminal operations with no live owner and preserves unknown resources', async () => {
    const complete = await setup(),
      active = await setup(),
      unknown = await setup(),
      foreign = await setup()
    await acknowledgeWindowsUpdateReady(complete.ready)
    await writeFile(join(complete.directory, 'helper.exe'), 'owned binary')
    await writeFile(join(complete.directory, 'config.bin'), 'owned config')
    for (const fixture of [complete, active, unknown, foreign]) {
      await writeWindowsUpdateFile(
        join(fixture.directory, 'closed.receipt'),
        windowsUpdateReceipt(fixture.operationId, 'closed')
      )
    }
    await writeFile(join(foreign.directory, 'user-file'), 'preserve')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    // Keep the first completed operation while its owner is alive.
    await cleanupWindowsUpdateHandoffs(root)
    expect(await readFile(join(complete.directory, 'request.json'), 'utf8')).toContain(
      complete.operationId
    )
    kill.mockImplementation(() => {
      throw Object.assign(new Error('not running'), { code: 'ESRCH' })
    })
    await cleanupWindowsUpdateHandoffs(root)
    expect(await readFile(join(complete.directory, 'request.json'), 'utf8')).toContain(
      complete.operationId
    )
    await expect(readFile(join(complete.directory, 'helper.exe'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(readFile(join(complete.directory, 'config.bin'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(await readFile(join(foreign.directory, 'user-file'), 'utf8')).toBe('preserve')
    expect(await readFile(join(unknown.directory, 'request.json'), 'utf8')).toContain(
      unknown.operationId
    )
    expect(await readdir(windowsUpdateHandoffRoot(root))).toHaveLength(4)
  })
})

describe('successor window readiness', () => {
  it('keeps the receipt absent when backend/data are ready but the main window is still hidden', async () => {
    const { directory, ready } = await setup()
    const window = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isVisible: () => false
    })
    ready.waitForPresentation = async () => waitForWindowsUpdateWindow(window)
    const completion = acknowledgeWindowsUpdateReady(ready)
    await vi.waitFor(() => expect(window.listenerCount('show')).toBe(1))
    expect(await readdir(directory)).not.toContain('ready.receipt')
    window.emit('show')
    expect(await completion).toBe(true)
    expect(await readdir(directory)).toContain('ready.receipt')
    expect(window.listenerCount('closed')).toBe(0)
  })
  it('rechecks backend/data after a late window instead of acknowledging stale health', async () => {
    const { directory, ready } = await setup()
    const window = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isVisible: () => false
    })
    ready.waitForPresentation = () => waitForWindowsUpdateWindow(window)
    const completion = acknowledgeWindowsUpdateReady(ready)
    await vi.waitFor(() => expect(window.listenerCount('show')).toBe(1))
    expect(ready.verifyReady).not.toHaveBeenCalled()
    ready.verifyReady = async () => {
      throw new Error('Backend disconnected while window loaded')
    }
    window.emit('show')
    await expect(completion).rejects.toThrow('Backend disconnected')
    expect(await readdir(directory)).not.toContain('ready.receipt')
  })
  it('rejects a closed window and removes presentation listeners', async () => {
    const window = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isVisible: () => false
    })
    const wait = waitForWindowsUpdateWindow(window)
    window.emit('closed')
    await expect(wait).rejects.toThrow('closed before presentation')
    expect(window.listenerCount('show')).toBe(0)
    await expect(waitForWindowsUpdateWindow(undefined)).rejects.toThrow('unavailable')
  })
})
