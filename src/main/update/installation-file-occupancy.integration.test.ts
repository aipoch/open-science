import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  realpath,
  readFile,
  copyFile,
  chmod,
  symlink,
  unlink
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { inspectInstallationProcessesAsync } from './installation-occupancy'
import { inspectInstallationAvailability } from './installation-protection'
import { once } from 'node:events'

const scannerFixture = vi.hoisted(() => ({
  preload: '',
  command: '',
  timeoutMs: undefined as number | undefined
}))

it.runIf(process.platform === 'win32')(
  'admits a file holder that exits after the native occupancy snapshot',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'installation-exited-holder-'))
    const installationRoot = join(root, 'app')
    await mkdir(installationRoot)
    const file = join(installationRoot, 'fixture.dll')
    await writeFile(file, 'fixture')
    const child = spawn(
      process.execPath,
      [
        '-e',
        "require('node:fs').openSync(process.argv[1], 'r');process.stdout.write('ready');process.stdin.resume();process.stdin.on('end', () => process.exit(0))",
        file
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    )
    const exited = once(child, 'exit')
    try {
      await once(child.stdout, 'data')
      const location = { installationRoot, stateRoot: join(root, 'state') }
      await expect(inspectInstallationAvailability(location)).rejects.toMatchObject({
        reason: 'installation-busy',
        recovery: { detail: 'foreign-process', blockingProcesses: [{ pid: child.pid }] }
      })
      await expect(
        inspectInstallationAvailability({
          ...location,
          allowedProcessIds: async () => {
            // Admission is resolved after the real native scan; synchronize the exit at that seam.
            child.stdin.end()
            await exited
            return []
          }
        })
      ).resolves.toBeUndefined()
      expect(child.exitCode).toBe(0)
    } finally {
      child.stdin.end()
      await exited
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000
)
vi.mock('./verification-process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./verification-process')>()
  return {
    ...actual,
    runVerificationProcess: (
      ...[command, args, options]: Parameters<typeof actual.runVerificationProcess>
    ) =>
      actual.runVerificationProcess(
        scannerFixture.command || command,
        scannerFixture.preload ? ['--require', scannerFixture.preload, ...args] : args,
        scannerFixture.preload ? { ...options, timeoutMs: scannerFixture.timeoutMs } : options
      )
  }
})

it.runIf(process.platform === 'win32')(
  'runs the native scanner under Electron in Node mode',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'installation-electron-scan-'))
    try {
      await writeFile(join(root, 'fixture.txt'), 'fixture')
      scannerFixture.command = createRequire(__filename)('electron') as string
      await expect(inspectInstallationProcessesAsync(root)).resolves.toEqual([])
    } finally {
      scannerFixture.command = ''
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000
)

it.runIf(process.platform === 'win32')(
  'retains the caller but excludes the exited scanner from executable occupants',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'installation-scan-identity-'))
    const pidPath = join(root, 'pid.json')
    const preload = join(root, 'identity.cjs')
    try {
      await writeFile(
        preload,
        `require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify(process.pid))`
      )
      scannerFixture.preload = preload
      const pids = await inspectInstallationProcessesAsync(process.execPath)
      const scannerPid = JSON.parse(await readFile(pidPath, 'utf8'))
      expect(pids).toContain(process.pid)
      expect(pids).not.toContain(scannerPid)
      expect(() => process.kill(scannerPid, 0)).toThrow()
    } finally {
      scannerFixture.preload = ''
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000
)

it.runIf(process.platform === 'win32')(
  'finds a data-file holder through junctions with self and ancestor cycles',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'installation-junction-scan-'))
    const installation = join(root, 'Science')
    const target = join(root, 'linked-data')
    const junction = join(installation, 'resources')
    let child: ReturnType<typeof spawn> | undefined
    let exited: Promise<void> | undefined
    const links: string[] = []
    try {
      await mkdir(installation)
      await mkdir(target)
      const file = join(target, 'data ü.json')
      await writeFile(file, '{}')
      await symlink(target, junction, 'junction')
      links.push(junction)
      const self = join(target, 'self')
      await symlink(target, self, 'junction')
      links.push(self)
      const ancestor = join(target, 'ancestor')
      await symlink(installation, ancestor, 'junction')
      links.push(ancestor)
      const preload = join(root, 'bounded-scan.cjs')
      await writeFile(preload, '')
      scannerFixture.preload = preload
      scannerFixture.timeoutMs = 5000
      child = spawn(
        process.execPath,
        [
          '-e',
          "require('node:fs').openSync(" +
            JSON.stringify(file) +
            ", 'r');process.stdout.write('ready');process.stdin.resume()"
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      )
      exited = new Promise<void>((resolve) => child!.once('close', () => resolve()))
      await new Promise<void>((resolve, reject) => {
        child!.stdout!.once('data', () => resolve())
        child!.once('error', reject)
      })
      await expect(inspectInstallationProcessesAsync(installation)).resolves.toContain(child.pid)
      child.stdin!.end()
      await exited
      await expect(inspectInstallationProcessesAsync(installation)).resolves.not.toContain(
        child.pid
      )
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
      scannerFixture.preload = ''
      scannerFixture.timeoutMs = undefined
      for (const link of links.reverse()) await unlink(link)
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000
)

it.runIf(process.platform === 'win32')(
  'registers physical ASAR archives instead of their virtual contents under Electron',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'installation-asar-scan-'))
    const installation = join(root, 'Science')
    const input = join(root, 'archive-input')
    const archive = join(installation, 'app.asar')
    const resourcesPath = join(root, 'resources.json')
    const preload = join(root, 'record-resources.cjs')
    let child: ReturnType<typeof spawn> | undefined
    let closed: Promise<void> | undefined
    try {
      await mkdir(installation)
      await mkdir(input)
      await writeFile(join(input, 'inside.txt'), 'archived content')
      const require = createRequire(__filename)
      const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
      const appBuilderRequire = createRequire(
        builderRequire.resolve('app-builder-lib/package.json')
      )
      await appBuilderRequire('@electron/asar').createPackage(input, archive)
      await writeFile(
        preload,
        [
          "const fs = require('node:fs')",
          "const Module = require('node:module')",
          'const load = Module._load',
          'Module._load = function(id, ...args) {',
          '  const actual = load.call(this, id, ...args)',
          "  if (!id.endsWith('process_tree_native.node')) return actual",
          '  return {...actual, listWindowsInstallationOccupants(files) {',
          '    fs.writeFileSync(' + JSON.stringify(resourcesPath) + ', JSON.stringify(files))',
          '    return actual.listWindowsInstallationOccupants(files)',
          '  }}',
          '}'
        ].join('\n')
      )
      child = spawn(
        process.execPath,
        [
          '-e',
          "require('node:fs').openSync(" +
            JSON.stringify(archive) +
            ", 'r');process.stdout.write('ready');process.stdin.resume()"
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      )
      closed = new Promise<void>((resolve) => child!.once('close', () => resolve()))
      await new Promise<void>((resolve, reject) => {
        child!.stdout!.once('data', () => resolve())
        child!.once('error', reject)
      })
      scannerFixture.command = require('electron') as string
      scannerFixture.preload = preload
      await expect(inspectInstallationProcessesAsync(installation)).resolves.toContain(child.pid)
      expect(JSON.parse(await readFile(resourcesPath, 'utf8'))).toEqual([archive])
    } finally {
      scannerFixture.command = ''
      scannerFixture.preload = ''
      child?.stdin?.end()
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await closed
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000
)

describe.runIf(process.platform === 'win32')('interrupting a blocked installation scanner', () => {
  it.each([
    ['enumeration', 'cancel'],
    ['native', 'cancel'],
    ['enumeration', 'timeout'],
    ['native', 'timeout']
  ])(
    'reaps %s on %s while caller timers remain responsive',
    async (phase, action) => {
      const root = await mkdtemp(join(tmpdir(), 'installation-scan-interrupt-'))
      const readyPath = join(root, 'ready.json')
      const preload = join(root, 'block-scan.cjs')
      const controller = new AbortController()
      let ticks = 0
      const timer = setInterval(() => ticks++, 10)
      let pending: Promise<number[]> | undefined
      try {
        await writeFile(
          preload,
          `
        const fs = require('node:fs')
        const block = () => {
          fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({pid: process.pid}))
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000)
          throw new Error('Scanner was not interrupted')
        }
        if (${JSON.stringify(phase)} === 'enumeration') fs.readdirSync = block
        else {
          const Module = require('node:module')
          const load = Module._load
          Module._load = function(id, ...args) {
            const actual = load.call(this, id, ...args)
            return id.endsWith('process_tree_native.node')
              ? {...actual, listWindowsInstallationOccupants: block} : actual
          }
        }
      `
        )
        scannerFixture.preload = preload
        scannerFixture.timeoutMs = action === 'timeout' ? 5_000 : 120_000
        pending = inspectInstallationProcessesAsync(root, controller.signal)
        void pending.catch(() => {})
        let pid = 0
        await vi.waitFor(
          async () => {
            pid = JSON.parse(await readFile(readyPath, 'utf8')).pid
            expect(pid).toBeGreaterThan(0)
          },
          { timeout: 4_000, interval: 20 }
        )
        expect(ticks).toBeGreaterThan(0)
        const started = Date.now()
        if (action === 'cancel') {
          controller.abort(new Error('explicit scan cancellation'))
          await expect(pending).rejects.toThrow('explicit scan cancellation')
          expect(Date.now() - started).toBeLessThan(5_000)
        } else {
          await expect(pending).rejects.toMatchObject({
            reason: 'installation-busy',
            cause: expect.objectContaining({
              message: 'Installation verification exceeded its time limit.'
            })
          })
        }
        // The native call is still blocked: rejection alone must not leave its process running.
        expect(() => process.kill(pid, 0)).toThrow()
      } finally {
        controller.abort()
        await pending?.catch(() => {})
        clearInterval(timer)
        scannerFixture.preload = ''
        scannerFixture.timeoutMs = undefined
        await rm(root, { recursive: true, force: true })
      }
    },
    15_000
  )
})

it.runIf(process.platform === 'win32')(
  'verifies installation availability without PowerShell on PATH',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'installation-minimal-path-'))
    const installationRoot = join(root, 'Science')
    const originalPath = process.env.PATH
    try {
      await mkdir(installationRoot)
      await writeFile(join(installationRoot, 'fixture.txt'), 'fixture')
      process.env.PATH = root
      await expect(
        inspectInstallationAvailability({ installationRoot, stateRoot: join(root, 'state') })
      ).resolves.toBeUndefined()
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000
)

it.runIf(process.platform === 'darwin')(
  'ignores a path argument and ordinary descriptor for an installation file',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'installation-handle-'))
    const installation = join(root, 'Science.app')
    await mkdir(installation)
    const file = join(await realpath(installation), 'helper.dat')
    await writeFile(file, 'fixture')
    const child = spawn(
      process.execPath,
      [
        '-e',
        `
    process.once('message', () => {
      require('node:fs').openSync(process.argv[1], 'r');
      process.send('ready');
      setInterval(() => {}, 1000);
    });
  `,
        file
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
    )
    try {
      const ready = new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve())
        child.once('error', reject)
        child.once('exit', () => reject(new Error('Fixture exited before opening file')))
      })
      child.send('start')
      await ready
      expect(await inspectInstallationProcessesAsync(installation)).not.toContain(child.pid)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await rm(root, { recursive: true, force: true })
    }
  },
  30000
)

it.runIf(process.platform === 'darwin')(
  'detects an executable launched from the installation bundle',
  async () => {
    const installation = await mkdtemp(join(tmpdir(), 'Science App-'))
    try {
      const executable = join(installation, 'sleep')
      await copyFile('/bin/sleep', executable)
      await chmod(executable, 0o755)
      const child = spawn(executable, ['60'])
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
      const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
      try {
        expect(await inspectInstallationProcessesAsync(installation)).toContain(child.pid)
      } finally {
        child.kill()
        await exited
      }
    } finally {
      await rm(installation, { recursive: true, force: true })
    }
  },
  30000
)
