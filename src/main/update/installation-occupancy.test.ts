import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  inspectOwnedCrashpadProcesses,
  inspectOwnedLinuxZygoteProcesses,
  inspectOwnedLinuxAppImageLauncher,
  inspectInstallationProcesses,
  inspectInstallationProcessesAsync
} from './installation-occupancy'

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  run: vi.fn(),
  realpath: vi.fn(),
  readlink: vi.fn(),
  readFile: vi.fn(),
  arguments: vi.fn()
}))
vi.mock('node:module', () => ({
  createRequire: () => () => ({ getDarwinProcessArguments: mocks.arguments })
}))
vi.mock('node:fs', () => ({
  realpathSync: mocks.realpath,
  readlinkSync: mocks.readlink,
  readFileSync: mocks.readFile
}))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: mocks.spawnSync
}))
vi.mock('./verification-process', () => ({ runVerificationProcess: mocks.run }))
beforeEach(() => {
  vi.resetAllMocks()
  mocks.readlink.mockImplementation(() => {
    throw Object.assign(new Error('Process exited'), { code: 'ENOENT' })
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('defers native loading until macOS inspection and retains occupancy when the binding fails', () => {
  // Exercise the actual CommonJS dependency boundary, outside Vitest's native-module mock.
  const script = `
    const assert = require('node:assert/strict')
    const Module = require('node:module')
    const fs = require('node:fs')
    const path = require('node:path')
    const ts = require('typescript')
    const filename = ${JSON.stringify(join(__dirname, 'installation-occupancy.ts'))}
    Module._extensions['.ts'] = (instance, source) => instance._compile(
      ts.transpileModule(fs.readFileSync(source, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
      }).outputText, source)
    const root = path.resolve('fixture', 'Science.app')
    const executable = path.join(root, 'Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler')
    const database = path.resolve('fixture', 'profile --backup', 'Crashpad')
    const options = { installationRoot: root, crashDumpsPath: database, instanceId: 'current' }
    let attempts = 0
    let binding
    const originalLoad = Module._load
    Module._load = function(id, ...args) {
      if (id === '@aipoch/process-tree-native') {
        attempts++
        if (!binding) throw Object.assign(new Error('Missing native binding'), { code: 'MODULE_NOT_FOUND' })
        return binding
      }
      const actual = originalLoad.call(this, id, ...args)
      if (id === 'node:fs') return { ...actual, realpathSync: value => value }
      if (id === 'node:child_process') return {
        ...actual, spawnSync: () => ({ status: 0, stdout: '42 ' + executable + '\\n' })
      }
      return actual
    }
    for (const platform of ['linux', 'win32', 'darwin']) {
      Object.defineProperty(process, 'platform', { value: platform })
      delete require.cache[filename]
      const occupancy = require(filename)
      assert.equal(attempts, 0, platform + ' module startup must not load the native binding')
      if (platform === 'darwin') {
        assert.deepEqual(occupancy.inspectOwnedCrashpadProcesses(options), [])
        assert.equal(attempts, 1)
        binding = {}
        assert.deepEqual(occupancy.inspectOwnedCrashpadProcesses(options), [])
        binding = { getDarwinProcessArguments: () => [
          executable, '--database=' + database, '--annotation=openScienceInstance=current'
        ] }
        assert.deepEqual(occupancy.inspectOwnedCrashpadProcesses(options), [42])
        assert.equal(attempts, 3, 'each macOS inspection must consult the native loader')
      }
    }
    process.stdout.write('native-loading-ok')
  `
  expect(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' })).toBe(
    'native-loading-ok'
  )
})

// Both APIs must find the same occupants from the platform's native process-list format.
describe.each(['sync', 'async'] as const)('%s installation occupancy', (mode) => {
  const inspect = async (root: string, signal?: AbortSignal): Promise<number[]> =>
    mode === 'sync'
      ? inspectInstallationProcesses(root)
      : inspectInstallationProcessesAsync(root, signal)
  function output(...values: string[]): void {
    for (const stdout of values) {
      mocks.spawnSync.mockReturnValueOnce({ status: 0, stdout })
      mocks.run.mockResolvedValueOnce({ stdout, stderr: '' })
    }
  }

  it('finds Linux command-line occupants and deduplicates PIDs', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    output('  10 /opt/Open Science/node\n20 unrelated\n10 /opt/Open Science/backend\ninvalid\n')
    const signal = new AbortController().signal
    expect(await inspect('/opt/Open Science', signal)).toEqual([10])
    if (mode === 'async')
      expect(mocks.run).toHaveBeenCalledWith('/bin/ps', ['-axo', 'pid=,command='], {
        signal,
        timeoutMs: 15_000
      })
  })

  it('finds Linux executables after argv is rewritten without matching sibling installations', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    output('10 old-node\n20 old-node\n30 old-node\n40 old-node\n')
    const executables: Record<string, string> = {
      '/proc/10/exe': '/opt/Open Science/node-runtime/node',
      '/proc/20/exe': '/opt/Open Science-old/node-runtime/node',
      '/proc/30/exe': '/opt/Open Science/node-runtime/node (deleted)',
      '/proc/40/exe': '/usr/bin/node'
    }
    mocks.readlink.mockImplementation((path: string) => executables[path])
    expect(await inspect('/opt/Open Science')).toEqual([10, 30])
  })

  it.each(['', ' (deleted)'])('finds the exact Linux image executable%s', async (suffix) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    output('10 renamed-image\n')
    mocks.readlink.mockReturnValue(`/opt/Science.AppImage${suffix}`)
    expect(await inspect('/opt/Science.AppImage')).toEqual([10])
  })

  it.each(['ENOENT', 'ESRCH', 'EACCES', 'EPERM'])(
    'retains Linux command-line detection when an executable link is unavailable (%s)',
    async (code) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
      output('10 /opt/Science/node\n20 unrelated\n')
      mocks.readlink.mockImplementation(() => {
        throw Object.assign(new Error('Unavailable'), { code })
      })
      expect(await inspect('/opt/Science')).toEqual([10])
    }
  )

  it('fails closed on unexpected Linux executable inspection errors', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    output('10 renamed-node\n')
    mocks.readlink.mockImplementation(() => {
      throw Object.assign(new Error('I/O error'), { code: 'EIO' })
    })
    await expect(inspect('/opt/Science')).rejects.toThrow('executable occupancy')
  })

  it('includes macOS text mappings without accepting similarly prefixed bundles', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    output(
      '10 /Applications/Science.app/node\n',
      'p10\nn/Applications/Science.app/node\np11\nn/Applications/Science.app\np12\nn/Applications/Science.app/Contents/node\np13\nn/Applications/Science.app-old/node\n'
    )
    expect(await inspect('/Applications/Science.app')).toEqual([10, 11, 12])
  })

  it.each([true, false])(
    'reads case-insensitive Windows process identities (array=%s)',
    async (array) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
      const executable = { ProcessId: '42', ExecutablePath: 'C:\\Apps\\Science\\node.exe' }
      output(
        JSON.stringify(
          array
            ? [
                executable,
                { ProcessId: 43, CommandLine: 'node C:\\APPS\\SCIENCE\\backend.cjs' },
                { ProcessId: 44, ExecutablePath: null, CommandLine: null }
              ]
            : executable
        )
      )
      expect(await inspect('c:\\apps\\science')).toEqual(array ? [42, 43] : [42])
    }
  )

  it.each(['linux', 'win32', 'darwin'] as const)(
    'fails closed when %s inspection fails',
    async (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      if (platform === 'darwin') output('')
      mocks.spawnSync.mockReturnValueOnce({ status: 1, stdout: '' })
      mocks.run.mockRejectedValueOnce(new Error('inspection failed'))
      await expect(inspect('/installed/app')).rejects.toThrow(
        mode === 'sync' ? 'could not be inspected' : 'inspection failed'
      )
    }
  )

  it('rejects invalid Windows process JSON instead of reporting an empty installation', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    output('not JSON')
    await expect(inspect('C:\\Apps\\Science')).rejects.toThrow()
  })
})

describe('current macOS Crashpad ownership', () => {
  const root = join('/Applications', 'Open Science.app')
  const executable = join(
    root,
    'Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler'
  )
  const database = '/profiles/current profile/Crashpad'
  const options = { installationRoot: root, crashDumpsPath: database, instanceId: 'current-launch' }
  const command = (db = database, instance = options.instanceId): string =>
    `${executable} --no-rate-limit --database=${db} --annotation=openScienceInstance=${instance} --handshake-fd=43`
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mocks.realpath.mockImplementation((path: string) =>
      path.startsWith(join('/var/')) ? join('/private', path) : path
    )
  })
  const snapshot = (comm: string, args: string): void => {
    mocks.spawnSync.mockReturnValueOnce({ status: 0, stdout: comm })
    mocks.arguments.mockImplementation((pid: number) => {
      const row = args.split('\n').find((line) => line.startsWith(`${pid} `))
      return row
        ? row
            .slice(String(pid).length + 1)
            .split(' --')
            .map((arg, i) => (i ? '--' + arg : arg))
        : null
    })
  }

  it('recognizes its reparented handler without trusting its PPID or process name', () => {
    snapshot(`101 ${executable}\n102 /usr/bin/node`, `101 ${command()}\n102 ${command()}`)
    expect(inspectOwnedCrashpadProcesses(options)).toEqual([101])
  })

  it.each([
    ['another profile', command('/profiles/other/Crashpad')],
    ['previous or other instance', command(database, 'other-launch')],
    ['missing instance', `${executable} --database=${database}`],
    ['prefix instance', command(database, 'current-launch-extra')],
    ['prefix database', command(`${database}-other`)],
    ['duplicate database', `${command()} --database=${database}`],
    ['duplicate instance', `${command()} --annotation=openScienceInstance=current-launch`],
    [
      'another executable',
      `/usr/bin/node --database=${database} --annotation=openScienceInstance=current-launch`
    ]
  ])('does not allow %s', (_name, args) => {
    snapshot(`101 ${executable}`, `101 ${args}`)
    expect(inspectOwnedCrashpadProcesses(options)).toEqual([])
  })

  it('preserves option-like text inside the Crashpad database path', () => {
    const path = '/profiles/current --backup/Crashpad'
    snapshot(`101 ${executable}`, '')
    mocks.arguments.mockReturnValue([
      executable,
      '--database=' + path,
      '--annotation=openScienceInstance=current-launch'
    ])
    expect(inspectOwnedCrashpadProcesses({ ...options, crashDumpsPath: path })).toEqual([101])
  })

  it('requires the actual executable independently of matching arguments', () => {
    snapshot(`101 ${executable}-other`, `101 ${command()}`)
    expect(inspectOwnedCrashpadProcesses(options)).toEqual([])
  })

  it('canonicalizes macOS path aliases including database paths with spaces', () => {
    const aliasRoot = join('/var/test', 'Open Science.app')
    const aliasExecutable = executable.replace(root, aliasRoot)
    snapshot(
      `101 ${aliasExecutable}`,
      `101 ${command(join('/var/test', 'profile space/Crashpad')).replace(executable, aliasExecutable)}`
    )
    expect(
      inspectOwnedCrashpadProcesses({
        ...options,
        installationRoot: join('/private/var/test', 'Open Science.app'),
        crashDumpsPath: join('/private/var/test', 'profile space/Crashpad')
      })
    ).toEqual([101])
  })

  it('rejects unreadable native arguments without falling back to flattened ps text', () => {
    snapshot(`101 ${executable}`, `101 ${command()}`)
    mocks.arguments.mockReturnValue(null)
    expect(inspectOwnedCrashpadProcesses(options)).toEqual([])
  })

  it('keeps disappeared or unreadable candidates out of the allow list', () => {
    snapshot('101 /gone', `101 ${command()}`)
    mocks.realpath.mockImplementation((path: string) => {
      if (path === '/gone') throw new Error('ENOENT')
      return path
    })
    expect(inspectOwnedCrashpadProcesses(options)).toEqual([])
  })

  it('fails closed if the process snapshot fails', () => {
    mocks.spawnSync.mockReturnValueOnce({ status: null, stdout: '', error: new Error('timeout') })
    expect(() => inspectOwnedCrashpadProcesses(options)).toThrow('ownership could not be inspected')
  })

  it.each(['freebsd'] as const)('does not exempt handlers on %s', (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    expect(inspectOwnedCrashpadProcesses(options)).toEqual([])
    expect(mocks.spawnSync).not.toHaveBeenCalled()
  })
})

describe('Windows crash reporter ownership', () => {
  const root = join(process.cwd(), 'fixture application')
  const executable = join(root, 'open-science.exe')
  const database = join(root, 'profile space', 'Crashpad')
  const options = { installationRoot: root, crashDumpsPath: database, instanceId: 'current-launch' }
  const row = (): {
    ProcessId: number
    ParentProcessId: number
    ExecutablePath: string
    Arguments: string[]
  } => ({
    ProcessId: 101,
    ParentProcessId: process.pid,
    ExecutablePath: executable,
    Arguments: [
      executable,
      '--type=crashpad-handler',
      '--database=' + database,
      '--annotation=openScienceInstance=current-launch'
    ]
  })
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    mocks.realpath.mockImplementation((path: string) =>
      path === process.execPath ? executable : path
    )
  })
  const snapshot = (rows: unknown): void => {
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: JSON.stringify(rows) })
  }
  it('recognizes its own handler using native parsed arguments and actual executable identity', () => {
    snapshot([row()])
    expect(inspectOwnedCrashpadProcesses(options)).toEqual([101])
  })
  it.each([
    ['another parent', { ParentProcessId: process.pid + 1 }],
    ['another executable', { ExecutablePath: executable + '-other' }],
    [
      'previous launch',
      { Arguments: [...row().Arguments.slice(0, -1), '--annotation=openScienceInstance=previous'] }
    ],
    [
      'another profile',
      {
        Arguments: row().Arguments.map((arg) =>
          arg.startsWith('--database=') ? '--database=' + database + '-other' : arg
        )
      }
    ],
    [
      'another process type',
      {
        Arguments: row().Arguments.map((arg) =>
          arg === '--type=crashpad-handler' ? '--type=renderer' : arg
        )
      }
    ],
    [
      'duplicate instance',
      { Arguments: [...row().Arguments, '--annotation=openScienceInstance=current-launch'] }
    ],
    ['duplicate database', { Arguments: [...row().Arguments, '--database=' + database] }],
    ['missing annotation', { Arguments: row().Arguments.slice(0, -1) }],
    ['invalid arguments', { Arguments: null }]
  ])('does not exempt %s', (_name, change) => {
    snapshot([{ ...row(), ...change }])
    expect(inspectOwnedCrashpadProcesses(options)).toEqual([])
  })
  it('does not exempt its handler from a different installation', () => {
    snapshot([row()])
    expect(
      inspectOwnedCrashpadProcesses({ ...options, installationRoot: root + '-other' })
    ).toEqual([])
  })
  it('fails closed on a failed native process query or malformed output', () => {
    mocks.spawnSync.mockReturnValue({ status: null, error: new Error('timeout'), stdout: '' })
    expect(() => inspectOwnedCrashpadProcesses(options)).toThrow('ownership could not be inspected')
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: '{bad-json' })
    expect(() => inspectOwnedCrashpadProcesses(options)).toThrow('ownership could not be inspected')
  })
})

describe('Linux desktop helper ownership', () => {
  const executable = '/opt/Science/open-science'
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    mocks.realpath.mockImplementation((path: string) =>
      path === process.execPath ? executable : path
    )
  })
  it.each(['\0', ' '])('allows owned zygotes with argv separator %j only', (separator) => {
    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: `12 11\n11 ${process.pid}\n13 ${process.pid}\n14 90\n15 13\n16 ${process.pid}\n17 ${process.pid}\n`
    })
    mocks.readlink.mockImplementation((path: string) =>
      path === '/proc/16/exe' ? '/usr/bin/node' : executable
    )
    mocks.readFile.mockImplementation((path: string) =>
      path === '/proc/13/cmdline'
        ? `${executable}\0--type=utility\0`
        : path === '/proc/17/cmdline'
          ? `${executable}\0--type=zygote-spoof\0`
          : `${executable}${separator}--type=zygote${separator}--no-sandbox\0`
    )
    expect(inspectOwnedLinuxZygoteProcesses()).toEqual([11, 12])
  })
  it('does not exempt an unreadable or exited zygote', () => {
    mocks.spawnSync.mockReturnValue({ status: 0, stdout: `11 ${process.pid}\n` })
    expect(inspectOwnedLinuxZygoteProcesses()).toEqual([])
  })
  it('fails closed if the zygote process snapshot fails', () => {
    mocks.spawnSync.mockReturnValue({ status: 1, stdout: '' })
    expect(() => inspectOwnedLinuxZygoteProcesses()).toThrow('Zygote ownership')
  })
  it.each(['darwin', 'win32'] as const)('does not inspect zygotes on %s', (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    expect(inspectOwnedLinuxZygoteProcesses()).toEqual([])
    expect(mocks.spawnSync).not.toHaveBeenCalled()
  })
  it.each(['current', 'special-path', 'old', 'other-executable', 'unreadable'])(
    'checks the Linux crash reporter executable and launch identity (%s)',
    (kind) => {
      const handler = join('/opt/Science', 'chrome_crashpad_handler')
      const database =
        kind === 'special-path' ? '/profile/current --backup/Crashpad' : '/profile/Crashpad'
      mocks.spawnSync.mockReturnValueOnce({ status: 0, stdout: '11 chrome_crashpad' })
      mocks.readFile.mockReturnValue(
        `${handler}\0--database=${database}\0--annotation=openScienceInstance=${kind === 'old' ? 'old' : 'current'}\0`
      )
      mocks.readlink.mockImplementation(() => {
        if (kind === 'unreadable') throw new Error('EACCES')
        return kind === 'other-executable' ? '/usr/bin/node' : handler
      })
      expect(
        inspectOwnedCrashpadProcesses({
          installationRoot: '/opt/Science',
          crashDumpsPath: database,
          instanceId: 'current'
        })
      ).toEqual(kind === 'current' || kind === 'special-path' ? [11] : [])
    }
  )
})

describe('AppImage runtime parent ownership', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.stubEnv('APPIMAGE', '/apps/Science.AppImage')
    vi.stubEnv('APPDIR', join('/tmp', 'extracted'))
    mocks.realpath.mockImplementation((path: string) =>
      path === process.execPath ? join('/tmp', 'extracted', 'open-science') : path
    )
    mocks.readlink.mockReturnValue('/apps/Science.AppImage')
  })
  it('allows only the direct launcher of this extracted application', () => {
    expect(inspectOwnedLinuxAppImageLauncher()).toEqual([process.ppid])
    expect(mocks.readlink).toHaveBeenCalledWith(`/proc/${process.ppid}/exe`)
  })
  it('does not accept another executable even with matching environment variables', () => {
    mocks.readlink.mockReturnValue('/usr/bin/node')
    expect(inspectOwnedLinuxAppImageLauncher()).toEqual([])
  })
  it('does not accept an image launcher for a different extraction directory', () => {
    vi.stubEnv('APPDIR', '/tmp/extracted-other')
    expect(inspectOwnedLinuxAppImageLauncher()).toEqual([])
  })
  it('does not accept unreadable parent identity', () => {
    mocks.readlink.mockImplementation(() => {
      throw new Error('EACCES')
    })
    expect(inspectOwnedLinuxAppImageLauncher()).toEqual([])
  })
  it.each(['APPIMAGE', 'APPDIR'])('requires %s', (variable) => {
    vi.stubEnv(variable, undefined)
    expect(inspectOwnedLinuxAppImageLauncher()).toEqual([])
  })
  it('does not inspect launchers on macOS', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    expect(inspectOwnedLinuxAppImageLauncher()).toEqual([])
  })
})
