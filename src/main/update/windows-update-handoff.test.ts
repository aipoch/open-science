import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cp,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyDesktopRecoveryReadiness } from '../desktop-recovery-readiness'
import type { DesktopRuntimeClient } from '../desktop-runtime-client'
import {
  readNativeInstallationUpdate,
  assertInstallationStartupAllowed,
  installationStateDirectory,
  releaseNativeInstallationUpdate
} from './installation-protection'
import { isWindowsInstallationWriterActive } from './windows-installation-processes'
import {
  acknowledgeWindowsUpdateReady,
  cleanupWindowsUpdateHandoffs,
  createWindowsUpdateRequest,
  prepareWindowsUpdateHandoff,
  windowsUpdateOperation,
  windowsUpdateReceipt,
  windowsUpdateHandoffRoot,
  writeWindowsUpdateFile,
  WINDOWS_UPDATE_OPERATION_ARG,
  prepareWindowsUpdateStartup,
  resumeInterruptedWindowsUpdate,
  windowsUpdateBoundRequest,
  windowsUpdateRequestBinding,
  windowsInstallationRecoveryDirectory,
  windowsInstallationRelaunchCommand,
  readWindowsUpdateRequest,
  waitForWindowsUpdateWindow
} from './windows-update-handoff'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})
vi.mock('./windows-installation-processes', () => ({
  isWindowsInstallationWriterActive: vi.fn(async () => false)
}))

let root: string
const resolveWindowsUpdateStartup = async (
  options: Parameters<typeof prepareWindowsUpdateStartup>[0]
): Promise<
  Omit<NonNullable<ReturnType<typeof prepareWindowsUpdateStartup>>, 'settle'> | undefined
> => {
  const prepared = prepareWindowsUpdateStartup(options)
  if (!prepared) return undefined
  await prepared.settle()
  return { startupOptions: prepared.startupOptions, confirmed: prepared.confirmed }
}
beforeEach(async () => {
  vi.mocked(rename).mockReset()
  root = await mkdtemp(join(tmpdir(), 'update-receipts-'))
  vi.stubEnv('OPEN_SCIENCE_INSTALLATION_STATE_ROOT', join(root, 'state'))
  vi.mocked(isWindowsInstallationWriterActive).mockReset().mockResolvedValue(false)
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
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
  await mkdir(join(root, 'installation'), { recursive: true })
  const { directory, request } = await createWindowsUpdateRequest(root, {
    targetVersion: '1.0.2',
    applicationPath: join(root, 'installation', 'app.exe'),
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

async function indexPending(fixture: Awaited<ReturnType<typeof setup>>): Promise<void> {
  const directory = await windowsInstallationRecoveryDirectory(root, fixture.ready.applicationPath)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'update.ini'),
    Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`[update]\r\noperationId=${fixture.operationId}\r\n`, 'utf16le')
    ])
  )
}

describe('Windows update presentation receipts', () => {
  it('keeps taskbar relaunch on the durable installation entry with Unicode paths', async () => {
    const { ready } = await setup()
    const directory = await windowsInstallationRecoveryDirectory(root, ready.applicationPath)
    await mkdir(directory, { recursive: true })
    const launcher = join(directory, `setup-${'a'.repeat(64)}.exe`)
    await writeFile(launcher, 'persistent signed installer fixture')
    const ini = `[installation]\r\napplicationPath=${ready.applicationPath}\r\nlauncherPath=${launcher}\r\n`
    await writeFile(
      join(directory, 'launch.ini'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(ini, 'utf16le')])
    )
    expect(await windowsInstallationRelaunchCommand(root, ready.applicationPath)).toBe(
      `"${launcher}" --open-science-launch`
    )
    await writeFile(
      join(directory, 'launch.ini'),
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(ini.replace(ready.applicationPath, join(root, 'another.exe')), 'utf16le')
      ])
    )
    await expect(windowsInstallationRelaunchCommand(root, ready.applicationPath)).rejects.toThrow(
      'Invalid'
    )
  })

  it('accepts a filesystem alias of the same persistent entry without trusting another directory', async () => {
    const { ready } = await setup()
    const alias = join(root, 'app-data-alias')
    await symlink(root, alias, 'junction')
    const directory = await windowsInstallationRecoveryDirectory(alias, ready.applicationPath)
    await mkdir(directory, { recursive: true })
    const launcher = join(directory, `setup-${'a'.repeat(64)}.exe`)
    await writeFile(launcher, 'persistent installer fixture')
    const metadata = (path: string): Buffer =>
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(
          `[installation]\r\napplicationPath=${ready.applicationPath}\r\nlauncherPath=${path}\r\n`,
          'utf16le'
        )
      ])
    await writeFile(join(directory, 'launch.ini'), metadata(launcher))
    expect(await windowsInstallationRelaunchCommand(alias, ready.applicationPath)).toBe(
      `"${launcher}" --open-science-launch`
    )
    const otherLauncher = join(root, `setup-${'a'.repeat(64)}.exe`)
    await writeFile(otherLauncher, 'unrelated entry')
    await writeFile(join(directory, 'launch.ini'), metadata(otherLauncher))
    await expect(windowsInstallationRelaunchCommand(alias, ready.applicationPath)).rejects.toThrow(
      'Invalid'
    )
  })

  async function interruptedUpdate(
    installerUrl?: string
  ): Promise<Awaited<ReturnType<typeof setup>>> {
    const fixture = await setup()
    const request = await readWindowsUpdateRequest(fixture.directory, fixture.operationId)
    await rm(join(fixture.directory, 'installed.receipt'))
    await writeFile(request.installerPath, 'verified installer')
    if (installerUrl) {
      request.installerUrl = installerUrl
      request.installerSha256 = createHash('sha256').update('verified installer').digest('hex')
      await writeFile(join(fixture.directory, 'request.json'), JSON.stringify(request))
    }
    await writeFile(
      join(fixture.directory, 'bound-request.json'),
      windowsUpdateBoundRequest(request)
    )
    const recoveryDirectory = await windowsInstallationRecoveryDirectory(
      root,
      request.applicationPath
    )
    await mkdir(recoveryDirectory, { recursive: true })
    const launcher = join(recoveryDirectory, `setup-${'a'.repeat(64)}.exe`)
    await writeFile(launcher, 'persistent signed NSIS fixture')
    await writeFile(
      join(recoveryDirectory, 'launch.ini'),
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(
          `[installation]\r\napplicationPath=${request.applicationPath}\r\nlauncherPath=${launcher}\r\n`,
          'utf16le'
        )
      ])
    )
    const state = installationStateDirectory({ installationRoot: join(root, 'installation') })
    await mkdir(state, { recursive: true })
    // Persisted bytes left by an exited owner; kernel-lock death itself is tested with real
    // subprocesses in installation-protection.test.ts.
    await writeFile(
      join(state, 'windows-update-in-progress.json'),
      JSON.stringify({
        schema: 1,
        operationId: request.operationId,
        phase: 'preparing',
        installationRoot: join(root, 'installation'),
        handoffDirectory: fixture.directory,
        targetVersion: request.targetVersion,
        requestSha256: windowsUpdateRequestBinding(request),
        installerSha512: createHash('sha512').update('verified installer').digest('base64')
      })
    )
    return fixture
  }

  it('ordinary startup resumes only the original verified package and operation after owner exit', async () => {
    const { ready, operationId } = await interruptedUpdate()
    const launch = vi.fn(async () => {})
    try {
      expect(
        await resumeInterruptedWindowsUpdate({ ...ready, args: [], version: 'old' }, launch)
      ).toBe(true)
      expect(launch).toHaveBeenCalledWith(
        join(
          await windowsInstallationRecoveryDirectory(root, ready.applicationPath),
          `setup-${'a'.repeat(64)}.exe`
        ),
        ['--open-science-launch']
      )
      expect(
        readNativeInstallationUpdate({ installationRoot: join(root, 'installation') })?.phase
      ).toBe('handoff')
    } finally {
      releaseNativeInstallationUpdate(
        { installationRoot: join(root, 'installation') },
        operationId,
        'installed'
      )
    }
  })

  it.each(['missing', 'corrupt'])(
    'delegates %s retained packages to the same persistent recovery entry',
    async (kind) => {
      const { ready, operationId } = await interruptedUpdate(
        'https://github.com/owner/repo/releases/download/v1/setup.exe'
      )
      await rm(join(root, 'installer.exe'))
      if (kind === 'corrupt') await writeFile(join(root, 'installer.exe'), 'damaged')
      const launch = vi.fn(async () => {})
      // The durable entry, including its embedded helper, owns writer waiting and downloads.
      // A partial installation need not still contain the app's process-probe executable.
      vi.mocked(isWindowsInstallationWriterActive).mockRejectedValue(
        new Error('installed helper missing')
      )
      try {
        expect(
          await resumeInterruptedWindowsUpdate({ ...ready, args: [], version: 'old' }, launch)
        ).toBe(true)
        expect(launch).toHaveBeenCalledWith(
          join(
            await windowsInstallationRecoveryDirectory(root, ready.applicationPath),
            `setup-${'a'.repeat(64)}.exe`
          ),
          ['--open-science-launch']
        )
        expect(isWindowsInstallationWriterActive).not.toHaveBeenCalled()
      } finally {
        releaseNativeInstallationUpdate(
          { installationRoot: join(root, 'installation') },
          operationId,
          'installed'
        )
      }
    }
  )

  it('preserves admission when the bound interrupted request has changed', async () => {
    const { ready, directory } = await interruptedUpdate()
    await writeFile(join(directory, 'bound-request.json'), 'changed')
    const launch = vi.fn(async () => {})
    await expect(
      resumeInterruptedWindowsUpdate({ ...ready, args: [], version: 'old' }, launch)
    ).rejects.toThrow('changed')
    expect(launch).not.toHaveBeenCalled()
    expect(
      readNativeInstallationUpdate({ installationRoot: join(root, 'installation') })
    ).toBeDefined()
  })

  it('holds durable admission through handoff and releases it only after the target writer settles', async () => {
    const { directory, ready } = await setup()
    await rm(directory, { recursive: true })
    const installerPath = join(root, 'installer.exe')
    await writeFile(installerPath, 'verified installer')
    const handoff = await prepareWindowsUpdateHandoff(
      root,
      {
        targetVersion: ready.version,
        applicationPath: ready.applicationPath,
        installerPath,
        profilePath: ready.profilePath,
        startupOptions: config()
      },
      { installerSha512: createHash('sha512').update('verified installer').digest('base64') }
    )
    const installationRoot = join(root, 'installation')
    expect(() => assertInstallationStartupAllowed(installationRoot)).toThrow('update')
    handoff.handoff()
    handoff.cancel()
    expect(readNativeInstallationUpdate({ installationRoot })?.phase).toBe('handoff')
    await writeFile(
      join(windowsUpdateHandoffRoot(root), handoff.operationId, 'installed.receipt'),
      windowsUpdateReceipt(handoff.operationId, 'installed')
    )
    vi.mocked(isWindowsInstallationWriterActive)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    const prepared = prepareWindowsUpdateStartup({
      ...ready,
      args: [WINDOWS_UPDATE_OPERATION_ARG + handoff.operationId]
    })
    // Profile selection and credential preflight can finish synchronously before any writer wait.
    expect(prepared?.startupOptions).toEqual(config())
    expect(isWindowsInstallationWriterActive).not.toHaveBeenCalled()
    expect(
      readWindowsUpdateRequest(
        join(windowsUpdateHandoffRoot(root), handoff.operationId),
        handoff.operationId
      ).successorPid
    ).toBeUndefined()
    expect(() => assertInstallationStartupAllowed(installationRoot)).toThrow('update')
    await prepared!.settle()
    expect(readNativeInstallationUpdate({ installationRoot })).toBeUndefined()
    expect(() => assertInstallationStartupAllowed(installationRoot)).not.toThrow()
  })

  it('leaves recovery storage absent when ordinary startup has no pending operation', async () => {
    const installation = join(root, 'new-installation')
    await mkdir(installation)
    expect(
      prepareWindowsUpdateStartup({
        appData: root,
        args: [],
        version: '1.0.2',
        applicationPath: join(installation, 'app.exe')
      })
    ).toBeUndefined()
    expect(await readdir(root)).toEqual(['new-installation'])
  })

  it('rejects changed profile binding between synchronous preparation and settlement', async () => {
    const { directory, operationId, ready } = await setup()
    const prepared = prepareWindowsUpdateStartup(ready)!
    const request = readWindowsUpdateRequest(directory, operationId)
    request.startupOptions.profilePath = join(root, 'different-profile')
    request.profilePath = request.startupOptions.profilePath
    await writeFile(join(directory, 'request.json'), JSON.stringify(request))
    await expect(prepared.settle()).rejects.toThrow('changed during credential preflight')
    expect(isWindowsInstallationWriterActive).not.toHaveBeenCalled()
  })

  it('rejects changed cached installers before taking admission or stopping a service', async () => {
    const { ready } = await setup()
    const installerPath = join(root, 'installer.exe')
    await writeFile(installerPath, 'changed installer')
    await expect(
      prepareWindowsUpdateHandoff(
        root,
        {
          targetVersion: ready.version,
          applicationPath: ready.applicationPath,
          installerPath,
          profilePath: ready.profilePath,
          startupOptions: config()
        },
        { installerSha512: createHash('sha512').update('verified installer').digest('base64') }
      )
    ).rejects.toThrow('changed')
    expect(
      readNativeInstallationUpdate({ installationRoot: join(root, 'installation') })
    ).toBeUndefined()
  })

  it('restores an installed but not ready update through the ordinary startup entry', async () => {
    const fixture = await setup()
    await indexPending(fixture)
    const { directory, operationId, ready } = fixture
    const ordinary = { ...ready, args: [] }
    expect(await resolveWindowsUpdateStartup(ordinary)).toEqual({
      startupOptions: config(),
      confirmed: false
    })
    expect(await acknowledgeWindowsUpdateReady(ordinary)).toBe(true)
    expect(await readFile(join(directory, 'ready.receipt'), 'utf8')).toBe(
      windowsUpdateReceipt(operationId, 'ready')
    )
    // A later normal launch must not overwrite a user's subsequently selected profile.
    expect(await resolveWindowsUpdateStartup(ordinary)).toBeUndefined()
  })

  it('does not discover another installation or an uninstalled target on ordinary startup', async () => {
    const fixture = await setup()
    await indexPending(fixture)
    const { directory, ready } = fixture
    expect(
      await resolveWindowsUpdateStartup({ ...ready, args: [], version: 'old' })
    ).toBeUndefined()
    await mkdir(join(root, 'other'))
    expect(
      await resolveWindowsUpdateStartup({
        ...ready,
        args: [],
        applicationPath: join(root, 'other', 'app.exe')
      })
    ).toBeUndefined()
    await rm(join(directory, 'installed.receipt'))
    expect(await resolveWindowsUpdateStartup({ ...ready, args: [] })).toBeUndefined()
  })

  it('uses only this installation index and ignores damaged unrelated historical leases', async () => {
    const first = await setup()
    const other = await setup()
    await writeFile(join(other.directory, 'request.json'), 'truncated unrelated request')
    await indexPending(first)
    expect(await resolveWindowsUpdateStartup({ ...first.ready, args: [] })).toEqual({
      startupOptions: config(),
      confirmed: false
    })
    const duplicate = join(root, 'Open-Science-UpdateHandoffs', first.operationId)
    await cp(first.directory, duplicate, { recursive: true })
    await expect(resolveWindowsUpdateStartup({ ...first.ready, args: [] })).rejects.toThrow(
      'ambiguous'
    )
  })

  it.each(['Open-Science', 'Open-Science/UpdateHandoffs'])(
    'restores the profile from safe fallback storage when installed at %s',
    async (installation) => {
      const applicationDirectory = join(root, installation)
      await mkdir(applicationDirectory, { recursive: true })
      const applicationPath = join(applicationDirectory, 'app.exe')
      const handoff = await prepareWindowsUpdateHandoff(root, {
        targetVersion: '1.0.2',
        applicationPath,
        installerPath: join(root, 'installer.exe'),
        profilePath: config().profilePath,
        startupOptions: config()
      })
      const directory = join(root, 'Open-Science-UpdateHandoffs', handoff.operationId)
      handoff.handoff()
      await writeFile(
        join(directory, 'installed.receipt'),
        windowsUpdateReceipt(handoff.operationId, 'installed')
      )
      const identity = {
        appData: root,
        args: [WINDOWS_UPDATE_OPERATION_ARG + handoff.operationId],
        version: '1.0.2',
        applicationPath
      }
      expect(await resolveWindowsUpdateStartup(identity)).toEqual({
        startupOptions: config(),
        confirmed: false
      })
      expect(
        await acknowledgeWindowsUpdateReady({
          ...identity,
          profilePath: config().profilePath,
          waitForPresentation: async () => {},
          verifyReady: async () => {}
        })
      ).toBe(true)
      expect((await resolveWindowsUpdateStartup(identity))?.confirmed).toBe(true)
      expect(await readdir(windowsUpdateHandoffRoot(root))).toEqual([])
    }
  )

  it.each(['.'])(
    'rejects handoff storage inside the installation at %s before shutdown',
    async (installation) => {
      const applicationDirectory = join(root, installation)
      await mkdir(applicationDirectory, { recursive: true })
      await expect(
        prepareWindowsUpdateHandoff(root, {
          targetVersion: '1.0.2',
          applicationPath: join(applicationDirectory, 'app.exe'),
          installerPath: join(root, 'installer.exe'),
          profilePath: config().profilePath,
          startupOptions: config()
        })
      ).rejects.toThrow('Update handoff storage must be outside the installation')
      expect(await readdir(windowsUpdateHandoffRoot(root))).toEqual([])
      expect(await readdir(join(root, 'Open-Science-UpdateHandoffs'))).toEqual([])
    }
  )

  it('uses the resolved installation location when selecting fallback storage', async () => {
    const installation = join(root, 'Open-Science')
    const alias = join(root, 'installation-alias')
    await mkdir(installation)
    await symlink(installation, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const handoff = await prepareWindowsUpdateHandoff(root, {
      targetVersion: '1.0.2',
      applicationPath: join(alias, 'app.exe'),
      installerPath: join(root, 'installer.exe'),
      profilePath: config().profilePath,
      startupOptions: config()
    })
    expect(await readdir(join(root, 'Open-Science-UpdateHandoffs', handoff.operationId))).toEqual([
      'request.json'
    ])
    expect(await readdir(windowsUpdateHandoffRoot(root))).toEqual([])
  })

  it('prepares a native installer handoff without copying or starting a helper', async () => {
    const startupOptions = config()
    await mkdir(join(root, 'installation'))
    const handoff = await prepareWindowsUpdateHandoff(root, {
      targetVersion: '1.0.2',
      applicationPath: join(root, 'installation', 'app.exe'),
      installerPath: join(root, 'installer.exe'),
      profilePath: startupOptions.profilePath,
      startupOptions
    })
    const directory = join(windowsUpdateHandoffRoot(root), handoff.operationId)
    expect(await readdir(directory)).toEqual(['request.json'])
    expect(JSON.parse(await readFile(join(directory, 'request.json'), 'utf8'))).not.toHaveProperty(
      'helperPid'
    )
    handoff.handoff()
    expect(await readFile(join(directory, 'handoff.receipt'), 'utf8')).toBe(
      windowsUpdateReceipt(handoff.operationId, 'handoff')
    )
    handoff.cancel()
    expect(await readFile(join(directory, 'unconfirmed.receipt'), 'utf8')).toBe(
      windowsUpdateReceipt(handoff.operationId, 'unconfirmed')
    )
    expect(await readdir(directory)).not.toContain('closed.receipt')
  })

  it('rejects duplicate operations across both fixed roots before restoring or acknowledging', async () => {
    const { directory, operationId, ready } = await setup()
    const duplicate = join(root, 'Open-Science-UpdateHandoffs', operationId)
    await cp(directory, duplicate, { recursive: true })
    await expect(resolveWindowsUpdateStartup(ready)).rejects.toThrow('ambiguous')
    await expect(acknowledgeWindowsUpdateReady(ready)).rejects.toThrow('ambiguous')
    expect(ready.verifyReady).not.toHaveBeenCalled()
    for (const path of [directory, duplicate])
      expect(await readdir(path)).not.toContain('ready.receipt')
  })

  it('checks successor identity and cleans failed leases in fallback storage', async () => {
    const { directory, operationId, ready } = await setup()
    const fallbackRoot = join(root, 'Open-Science-UpdateHandoffs')
    await mkdir(fallbackRoot)
    const fallback = join(fallbackRoot, operationId)
    await rename(directory, fallback)
    await expect(resolveWindowsUpdateStartup({ ...ready, version: 'other' })).rejects.toThrow(
      'does not match'
    )
    await expect(
      acknowledgeWindowsUpdateReady({ ...ready, profilePath: join(root, 'other') })
    ).rejects.toThrow('does not match')
    expect(ready.verifyReady).not.toHaveBeenCalled()
    await writeFile(join(fallback, 'failed.receipt'), windowsUpdateReceipt(operationId, 'failed'))
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('not running'), { code: 'ESRCH' })
    })
    await cleanupWindowsUpdateHandoffs(root)
    expect(await readdir(fallbackRoot)).toEqual([])
  })

  it('records an aborted request when installation admission fails before handoff', async () => {
    const startupOptions = config()
    await mkdir(join(root, 'installation'))
    const handoff = await prepareWindowsUpdateHandoff(root, {
      targetVersion: '1.0.2',
      applicationPath: join(root, 'installation', 'app.exe'),
      installerPath: join(root, 'installer.exe'),
      profilePath: startupOptions.profilePath,
      startupOptions
    })
    handoff.cancel()
    const directory = join(windowsUpdateHandoffRoot(root), handoff.operationId)
    expect(await readFile(join(directory, 'aborted.receipt'), 'utf8')).toBe(
      windowsUpdateReceipt(handoff.operationId, 'aborted')
    )
    expect(await readdir(directory)).not.toContain('helper.exe')
  })

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
    const fixture = await setup()
    await indexPending(fixture)
    const { ready } = fixture
    expect((await resolveWindowsUpdateStartup(ready))?.startupOptions).toEqual(config())
    await expect(resolveWindowsUpdateStartup({ ...ready, version: 'other' })).rejects.toThrow(
      'does not match'
    )
    expect(await resolveWindowsUpdateStartup({ ...ready, args: [] })).toEqual({
      startupOptions: config(),
      confirmed: false
    })
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
  it.each(['isComplete', 'isProjectDeletionRecoveryComplete'] as const)(
    'retains an unconfirmed update until %s becomes true',
    async (incomplete) => {
      const { directory, operationId, ready } = await setup()
      const diagnostics = {
        isComplete: true,
        isProjectDeletionRecoveryComplete: true,
        warnings: []
      }
      diagnostics[incomplete] = false
      const client = {
        startupState: () => ({ phase: 'ready' }),
        runtimeInfo: () => ({ startupOptions: config() }),
        invokeHost: async (channel: string) =>
          channel === 'storage:get-status'
            ? { dataRoot: config().dataRoot, dataRootMissing: false }
            : channel === 'sessions:list'
              ? { sessions: [], manifest: { version: 1 }, diagnostics }
              : []
      } as unknown as DesktopRuntimeClient
      ready.verifyReady = (expected) => verifyDesktopRecoveryReadiness(client, expected)

      await expect(acknowledgeWindowsUpdateReady(ready)).rejects.toThrow('saved conversations')
      expect(await readdir(directory)).not.toContain('ready.receipt')
      expect((await resolveWindowsUpdateStartup(ready))?.confirmed).toBe(false)

      diagnostics[incomplete] = true
      await expect(acknowledgeWindowsUpdateReady(ready)).resolves.toBe(true)
      expect(await readFile(join(directory, 'ready.receipt'), 'utf8')).toBe(
        windowsUpdateReceipt(operationId, 'ready')
      )
      expect((await resolveWindowsUpdateStartup(ready))?.confirmed).toBe(true)
    }
  )
  it('rejects a stale or partially written installer receipt', async () => {
    const { directory, ready } = await setup()
    for (const contents of ['other-operation\r\ninstalled\r\n', '']) {
      await writeFile(join(directory, 'installed.receipt'), contents)
      await expect(acknowledgeWindowsUpdateReady(ready)).rejects.toThrow('receipt')
    }
    expect(ready.verifyReady).not.toHaveBeenCalled()
  })
  it('keeps ordinary launches compatible and rejects path/duplicate operation arguments', async () => {
    const { directory, ready } = await setup()
    await rm(join(directory, 'installed.receipt'))
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
  it.skipIf(process.platform !== 'win32')(
    'publishes the request after a real Windows reader releases the failed replacement',
    async () => {
      const path = join(root, 'request.json')
      const previous = JSON.stringify({ operationId: 'same-operation', parentPid: 100 })
      const next = JSON.stringify({ operationId: 'same-operation', parentPid: 100, helperPid: 101 })
      await writeFile(path, previous)
      const reader = await open(path, 'r')
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
      let observedConflict = false
      vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
        try {
          await actual.rename(source, destination)
        } catch (error) {
          expect(error).toMatchObject({ code: 'EPERM' })
          expect(await reader.readFile('utf8')).toBe(previous)
          expect(await readFile(path, 'utf8')).toBe(previous)
          observedConflict = true
          await reader.close()
          throw error
        }
      })
      try {
        await writeWindowsUpdateFile(path, next)
        expect(observedConflict).toBe(true)
        expect(rename).toHaveBeenCalledTimes(2)
        expect(await readFile(path, 'utf8')).toBe(next)
        expect(await readdir(root)).toEqual(['request.json'])
      } finally {
        await reader.close()
      }
    }
  )
  it.skipIf(process.platform !== 'win32')(
    'rejects a persistently held Windows request without changing it or leaking the temporary file',
    async () => {
      const path = join(root, 'request.json')
      const previous = '{"operationId":"same-operation","parentPid":100}'
      await writeFile(path, previous)
      const reader = await open(path, 'r')
      try {
        await expect(writeWindowsUpdateFile(path, '{"helperPid":101}')).rejects.toMatchObject({
          code: 'EPERM'
        })
        expect(rename).toHaveBeenCalledTimes(6)
        expect(await reader.readFile('utf8')).toBe(previous)
        expect(await readFile(path, 'utf8')).toBe(previous)
        expect(await readdir(root)).toEqual(['request.json'])
      } finally {
        await reader.close()
      }
    }
  )
  it('preserves the original request and error without retrying a non-contention failure', async () => {
    const path = join(root, 'request.json')
    const previous = '{"operationId":"same-operation"}'
    await writeFile(path, previous)
    const failure = Object.assign(new Error('device failure'), { code: 'EIO' })
    vi.mocked(rename).mockRejectedValueOnce(failure)
    await expect(writeWindowsUpdateFile(path, '{"helperPid":101}')).rejects.toBe(failure)
    expect(rename).toHaveBeenCalledOnce()
    expect(await readFile(path, 'utf8')).toBe(previous)
    expect(await readdir(root)).toEqual(['request.json'])
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
    await writeFile(join(directory, 'installer.exe'), 'verified operation package')
    await writeFile(join(directory, 'bound-request.json'), 'immutable operation binding')
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    })
    await cleanupWindowsUpdateHandoffs(root)
    await expect(readFile(join(directory, 'request.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('cleans a native-only failed attempt without requiring a nonexistent helper receipt', async () => {
    const { directory, operationId } = await setup()
    await writeFile(join(directory, 'failed.receipt'), windowsUpdateReceipt(operationId, 'failed'))
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    })
    await cleanupWindowsUpdateHandoffs(root)
    await expect(readFile(join(directory, 'request.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
  it('still preserves an unclosed legacy helper attempt even when its PID is gone', async () => {
    const { directory, operationId } = await setup()
    const path = join(directory, 'request.json')
    const request = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...request, helperPid: 123 }))
    await writeFile(join(directory, 'failed.receipt'), windowsUpdateReceipt(operationId, 'failed'))
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    })
    await cleanupWindowsUpdateHandoffs(root)
    expect(JSON.parse(await readFile(path, 'utf8')).helperPid).toBe(123)
  })
  it('preserves the native repair package and binding after an interrupted failed install', async () => {
    const { directory, operationId } = await setup()
    await writeFile(join(directory, 'installer.exe'), 'verified operation package')
    await writeFile(join(directory, 'bound-request.json'), 'immutable operation binding')
    await writeFile(join(directory, 'failed.receipt'), windowsUpdateReceipt(operationId, 'failed'))
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    })
    await cleanupWindowsUpdateHandoffs(root)
    expect(await readFile(join(directory, 'installer.exe'), 'utf8')).toBe(
      'verified operation package'
    )
    expect(await readFile(join(directory, 'bound-request.json'), 'utf8')).toBe(
      'immutable operation binding'
    )
    expect(await readFile(join(directory, 'request.json'), 'utf8')).toContain(operationId)
  })
  it('removes only closed terminal operations with no live owner and preserves unknown resources', async () => {
    const complete = await setup(),
      active = await setup(),
      unknown = await setup(),
      foreign = await setup()
    await acknowledgeWindowsUpdateReady(complete.ready)
    await writeFile(join(complete.directory, 'helper.exe'), 'owned binary')
    await writeFile(join(complete.directory, 'config.bin'), 'owned config')
    for (const fixture of [complete, active, unknown]) {
      await writeFile(join(fixture.directory, 'installer.exe'), 'verified operation package')
      await writeFile(join(fixture.directory, 'bound-request.json'), 'immutable operation binding')
    }
    const persistentDirectory = await windowsInstallationRecoveryDirectory(
      root,
      complete.ready.applicationPath
    )
    await mkdir(persistentDirectory, { recursive: true })
    const persistentLauncher = join(persistentDirectory, `setup-${'a'.repeat(64)}.exe`)
    await writeFile(persistentLauncher, 'keep existing shortcut target')
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
    expect(await readFile(join(complete.directory, 'installer.exe'), 'utf8')).toBe(
      'verified operation package'
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
    await expect(readFile(join(complete.directory, 'installer.exe'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(await readFile(join(complete.directory, 'bound-request.json'), 'utf8')).toBe(
      'immutable operation binding'
    )
    expect(await readFile(join(unknown.directory, 'installer.exe'), 'utf8')).toBe(
      'verified operation package'
    )
    expect(await readFile(persistentLauncher, 'utf8')).toBe('keep existing shortcut target')
    expect(await readFile(join(foreign.directory, 'user-file'), 'utf8')).toBe('preserve')
    expect(await readFile(join(unknown.directory, 'request.json'), 'utf8')).toContain(
      unknown.operationId
    )
    expect(await readdir(windowsUpdateHandoffRoot(root))).toHaveLength(5)
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
