import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acknowledgeMacUpdateReady, startMacInstallProgress } from './macos-install-progress'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- inferred fixture ports retain mock types.
async function fixture() {
  const profilePath = await realpath(await mkdtemp(join(tmpdir(), 'mac-handoff-')))
  directories.push(profilePath)
  const applicationPath = join(profilePath, 'application')
  await writeFile(applicationPath, '')
  const operationId = randomUUID()
  const root = join(profilePath, 'mac-update-handoff')
  const directory = join(root, operationId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const startupOptions = {
    configRoot: profilePath,
    dataRoot: profilePath,
    profilePath,
    port: 0,
    host: '127.0.0.1' as const,
    credentialStore: 'os' as const
  }
  const request = {
    operationId,
    createdAt: Date.now(),
    parentPid: process.pid + 1,
    applicationPath,
    profilePath,
    targetVersion: '1.0.2',
    startupOptions
  }
  const save = async (path: string, value: unknown): Promise<void> => {
    await writeFile(path, JSON.stringify(value), { mode: 0o600 })
  }
  await save(join(root, 'active.json'), operationId)
  await save(join(directory, 'request.json'), request)
  await save(join(directory, 'state.json'), { operationId, phase: 'handoff' })
  const options = {
    profilePath,
    applicationPath,
    version: '1.0.2',
    waitForPresentation: vi.fn(async () => {}),
    verifyReady: vi.fn(async () => {})
  }
  return { profilePath, root, directory, operationId, request, options, save }
}

describe.skipIf(process.platform === 'win32')('macOS successor presentation receipts', () => {
  it('waits for the visible window and readable original data before dismissing', async () => {
    const f = await fixture()
    let shown!: () => void
    f.options.waitForPresentation.mockImplementation(
      () =>
        new Promise((resolve) => {
          shown = resolve
        })
    )
    const done = acknowledgeMacUpdateReady(f.options)
    await vi.waitFor(() => expect(f.options.waitForPresentation).toHaveBeenCalledOnce())
    expect(f.options.verifyReady).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8')).phase).toBe(
      'handoff'
    )
    shown()
    expect(await done).toBe(true)
    expect(f.options.verifyReady).toHaveBeenCalledWith(f.request.startupOptions)
    expect(JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8')).phase).toBe('ready')
  })
  it.each(['targetVersion', 'applicationPath', 'profilePath', 'operationId'] as const)(
    'rejects a mismatched %s',
    async (field) => {
      const f = await fixture()
      await f.save(join(f.directory, 'request.json'), {
        ...f.request,
        [field]:
          field === 'operationId' ? randomUUID() : field.endsWith('Path') ? '/different' : '2.0.0'
      })
      await expect(acknowledgeMacUpdateReady(f.options)).rejects.toThrow('does not match')
      expect(f.options.verifyReady).not.toHaveBeenCalled()
    }
  )
  it.each(['prepared', 'cancelled', 'unconfirmed', 'ready'])(
    'does not acknowledge %s',
    async (phase) => {
      const f = await fixture()
      await f.save(join(f.directory, 'state.json'), { operationId: f.operationId, phase })
      expect(await acknowledgeMacUpdateReady(f.options)).toBe(false)
    }
  )
  it.each(['parent', 'expired', 'future'])('ignores %s attempts', async (kind) => {
    const f = await fixture()
    await f.save(join(f.directory, 'request.json'), {
      ...f.request,
      ...(kind === 'parent'
        ? { parentPid: process.pid }
        : { createdAt: Date.now() + (kind === 'future' ? 60000 : -600001) })
    })
    expect(await acknowledgeMacUpdateReady(f.options)).toBe(false)
  })
  it('leaves the window open when original data verification fails', async () => {
    const f = await fixture()
    f.options.verifyReady.mockRejectedValue(new Error('Unreadable original data'))
    await expect(acknowledgeMacUpdateReady(f.options)).rejects.toThrow('Unreadable original data')
    expect(JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8')).phase).toBe(
      'handoff'
    )
  })
  it('does not acknowledge an attempt replaced while readiness is pending', async () => {
    const f = await fixture()
    f.options.verifyReady.mockImplementation(async () => {
      await f.save(join(f.root, 'active.json'), randomUUID())
    })
    expect(await acknowledgeMacUpdateReady(f.options)).toBe(false)
  })
  it.each(['symlink', 'writable'])('rejects %s presentation files', async (kind) => {
    const f = await fixture()
    const path = join(f.root, 'active.json')
    if (kind === 'symlink') {
      await rm(path)
      await symlink(join(f.directory, 'request.json'), path)
    } else await chmod(path, 0o666)
    await expect(acknowledgeMacUpdateReady(f.options)).rejects.toThrow(
      'Invalid update presentation file'
    )
  })
  it('tolerates a dismissed helper without reporting update failure', async () => {
    const f = await fixture()
    await rm(f.directory, { recursive: true })
    expect(await acknowledgeMacUpdateReady(f.options)).toBe(false)
  })
  it('does not leave files when the packaged helper is missing', async () => {
    const f = await fixture()
    const app = join(f.profilePath, 'Test.app/Contents/MacOS/app')
    await mkdir(join(f.profilePath, 'Test.app/Contents/MacOS'), { recursive: true })
    await writeFile(app, '')
    await expect(
      startMacInstallProgress({
        helperPath: join(f.profilePath, 'missing'),
        applicationPath: app,
        profilePath: f.profilePath,
        targetVersion: '1.0.2',
        startupOptions: f.request.startupOptions,
        translate: (s) => s,
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
      })
    ).rejects.toThrow()
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(f.root)).filter((name) => name !== 'active.json')).toEqual([
      f.operationId
    ])
  })
})
