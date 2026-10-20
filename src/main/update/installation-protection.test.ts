import { realpath } from 'node:fs/promises'
import { installationFs } from './installation-filesystem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  readdirSync,
  existsSync,
  copyFileSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  advanceInstallationUpdate,
  advanceInstallationUpdateAsync,
  captureInstallationManifestAsync,
  finishInstallationRecoveryAsync,
  assertInstallationStartupAllowed,
  beginInstallationUpdate,
  captureInstallationManifest,
  checkInstallationResult,
  finishInstallationRecovery,
  inspectInstallationUpdate,
  inspectInstallationAvailability,
  inspectInstallationStartup,
  inspectInstallationStartupAsync,
  completeInstallationStartup,
  installationRootForEntry,
  installationStateDirectory,
  registerInstallationRuntime
} from './installation-protection'
import { protectInstallationStartup } from '../../../packages/open-science/installation-startup.cjs'
import {
  inspectInstallationProcesses,
  inspectInstallationProcessesAsync
} from './installation-occupancy'

vi.mock('./installation-filesystem', async (original) => {
  const { installationFs: fs } = await original<typeof import('./installation-filesystem')>()
  return {
    installationFs: { ...fs, promises: { ...fs.promises, realpath: vi.fn(fs.promises.realpath) } }
  }
})

// Boot-query integration is covered separately; lifecycle fixtures need a stable boot.
vi.mock('../system-boot-identity', async (original) => ({
  ...(await original<typeof import('../system-boot-identity')>()),
  systemBootIdentity: () => 'windows-boot:12345678-1234-4321-8123-123456789abc'
}))

const directories: string[] = []
const fixture = (): {
  directory: string
  entry: string
  location: { installationRoot: string; stateRoot: string }
  runtime: { pid: number; generation: string; configRoot: string }
  options: Parameters<typeof beginInstallationUpdate>[0]
} => {
  const directory = mkdtempSync(join(tmpdir(), 'installation-protection-'))
  directories.push(directory)
  const installationRoot = join(directory, 'Open-Science.app')
  const entry = join(installationRoot, 'Contents/Resources/backend/out/backend/index.cjs')
  mkdirSync(join(installationRoot, 'Contents/Resources/backend/out/backend'), { recursive: true })
  writeFileSync(entry, 'old')
  const location = { installationRoot, stateRoot: join(directory, 'external-state') }
  const runtime = {
    pid: process.pid,
    generation: 'generation',
    configRoot: join(directory, 'profile')
  }
  const startupOptions = {
    configRoot: runtime.configRoot,
    dataRoot: join(directory, 'data'),
    profilePath: join(directory, 'profile.json'),
    port: 44100,
    host: '127.0.0.1' as const,
    credentialStore: 'file' as const
  }
  const options = {
    ...location,
    runtime,
    startupOptions,
    currentVersion: '1',
    targetVersion: '2',
    inspectProcesses: () => []
  }
  return { directory, entry, location, runtime, options }
}
beforeEach(() => {
  vi.stubEnv('OPEN_SCIENCE_INSTALLATION_OWNER', process.env.OPEN_SCIENCE_INSTALLATION_OWNER)
  vi.stubEnv(
    'OPEN_SCIENCE_INSTALLATION_STATE_ROOT',
    process.env.OPEN_SCIENCE_INSTALLATION_STATE_ROOT
  )
})
afterEach(() => {
  vi.mocked(installationFs.promises.realpath).mockReset().mockImplementation(realpath)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it.each(['home', 'explicit', 'environment', 'e2e'] as const)(
  'keeps the %s installation state root when MCP helpers isolate their home',
  (source) => {
    const f = fixture()
    const hostHome = join(f.directory, 'host-home')
    const isolatedHome = join(f.directory, 'codex-home')
    const stateRoot =
      source === 'home'
        ? join(hostHome, '.open-science', 'installations')
        : source === 'e2e'
          ? join(f.directory, 'e2e', 'installations')
          : f.location.stateRoot
    vi.stubEnv('HOME', hostHome)
    vi.stubEnv('USERPROFILE', hostHome)
    vi.stubEnv('OPEN_SCIENCE_INSTALLATION_OWNER', undefined)
    vi.stubEnv(
      'OPEN_SCIENCE_INSTALLATION_STATE_ROOT',
      source === 'environment' ? stateRoot : undefined
    )
    vi.stubEnv(
      'OPEN_SCIENCE_E2E_STORAGE_ROOT',
      source === 'e2e' ? join(f.directory, 'e2e') : undefined
    )
    const runtime = registerInstallationRuntime({
      installationRoot: f.location.installationRoot,
      ...(source === 'explicit' ? { stateRoot } : {}),
      ...f.runtime
    })
    const launch = (flag: string): SpawnSyncReturns<string> =>
      spawnSync(
        process.execPath,
        [
          '-e',
          `
      process.argv.push(${JSON.stringify(flag)});
      const { protectInstallationStartup } = require(${JSON.stringify(join(process.cwd(), 'packages/open-science/installation-startup.cjs'))});
      const lease = protectInstallationStartup(${JSON.stringify(f.entry)}, 'bootstrap');
      process.stdout.write(JSON.stringify(lease.identity));
      lease.release();
    `
        ],
        {
          encoding: 'utf8',
          timeout: 5000,
          env: {
            ...process.env,
            HOME: isolatedHome,
            USERPROFILE: isolatedHome,
            CODEX_HOME: isolatedHome
          }
        }
      )
    try {
      for (const flag of [
        '--open-science-artifact-mcp',
        '--open-science-notebook-mcp',
        '--open-science-reviewer-mcp-proxy',
        '--open-science-skill-import-mcp',
        '--open-science-skill-runtime-mcp',
        '--open-science-plan-mcp'
      ]) {
        const result = launch(flag)
        expect(result.status, result.stderr).toBe(0)
        expect(JSON.parse(result.stdout).configRoot).toBe(f.runtime.configRoot)
      }
      expect(process.env.OPEN_SCIENCE_INSTALLATION_STATE_ROOT).toBe(stateRoot)
      const update = beginInstallationUpdate({ ...f.options, stateRoot })
      const blocked = launch('--open-science-notebook-mcp')
      expect(blocked.status).not.toBe(0)
      expect(blocked.stderr).toContain('Installation update requires recovery')
      finishInstallationRecovery({ ...f.location, stateRoot }, update.operationId, 'cancel')
      runtime.release()
      const stale = launch('--open-science-notebook-mcp')
      expect(stale.status).not.toBe(0)
      expect(stale.stderr).toContain('runtime helper installation capability is no longer valid')
    } finally {
      runtime.release()
    }
  }
)

describe('installation protection', () => {
  it.each([false, true])(
    'waits for short coordinator contention but preserves exclusion (held=%s)',
    async (held) => {
      const f = fixture()
      const directory = installationStateDirectory(f.location)
      mkdirSync(directory, { recursive: true })
      const script = `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE');
      process.stdout.write('locked');
      process.stdin.once('data', () => {
        ${held ? 'setInterval(() => {}, 1000)' : 'setTimeout(() => { db.close(); process.exit(0) }, 250)'}
      });
    `
      const child = spawn(process.execPath, ['-e', script, join(directory, 'coordinator.sqlite')], {
        stdio: ['pipe', 'pipe', 'pipe']
      })
      const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      try {
        await new Promise<void>((resolve, reject) => {
          child.stdout.once('data', () => resolve())
          child.once('error', reject)
          child.once('exit', () => reject(new Error('lock owner exited before readiness')))
        })
        child.stdin.write('attempt')
        if (held) {
          expect(() => registerInstallationRuntime({ ...f.location, ...f.runtime })).toThrow(
            'Installation coordination is busy'
          )
          expect(readdirSync(directory).filter((name) => name.endsWith('.json'))).toEqual([])
        } else {
          const runtime = registerInstallationRuntime({ ...f.location, ...f.runtime })
          try {
            // The short coordinator lock is released, but the lifetime lease still excludes updates.
            expect(() =>
              beginInstallationUpdate({
                ...f.options,
                runtime: { ...f.runtime, generation: 'other' }
              })
            ).toThrow('Another service')
          } finally {
            runtime.release()
          }
        }
      } finally {
        child.kill('SIGKILL')
        await exit
      }
    },
    10_000
  )

  it('preserves verified configuration across cancellation until successful startup consumes its operation', () => {
    const f = fixture()
    const record = beginInstallationUpdate(f.options)
    finishInstallationRecovery(f.location, record.operationId, 'cancel')
    expect(inspectInstallationStartup(f.location)?.startupOptions).toEqual(f.options.startupOptions)
    expect(() => beginInstallationUpdate(f.options)).toThrow('requires recovery')
    expect(() => completeInstallationStartup(f.location, 'stale-operation')).toThrow('changed')
    // The ticket preserves configuration without preventing the restored service from starting.
    expect(() =>
      assertInstallationStartupAllowed(f.location.installationRoot, f.location.stateRoot)
    ).not.toThrow()
    completeInstallationStartup(f.location, record.operationId)
    expect(inspectInstallationStartup(f.location)).toBeUndefined()
  })
  it('identifies the same full bundle from CLI and bundled backend entries', () => {
    const f = fixture()
    const cli = join(f.location.installationRoot, 'Contents/Resources/backend/cli.mjs')
    writeFileSync(cli, '')
    expect(installationRootForEntry(f.entry)).toBe(realpathSync(f.location.installationRoot))
    expect(installationRootForEntry(cli)).toBe(realpathSync(f.location.installationRoot))
  })
  it('coordinates cross-profile registrations and never stops them', () => {
    const f = fixture()
    const other = registerInstallationRuntime({
      ...f.location,
      configRoot: 'other',
      generation: 'other'
    })
    expect(() => beginInstallationUpdate(f.options)).toThrow('Another service')
    other.release()
    const record = beginInstallationUpdate(f.options)
    expect(() => registerInstallationRuntime({ ...f.location, ...f.runtime })).toThrow(
      'in progress'
    )
    expect(() =>
      assertInstallationStartupAllowed(f.location.installationRoot, f.location.stateRoot)
    ).toThrow('recovery')
    expect(finishInstallationRecovery(f.location, record.operationId, 'cancel')).toEqual(
      f.options.startupOptions
    )
    const next = registerInstallationRuntime({ ...f.location, ...f.runtime })
    next.release()
  })
  it('retains handoff protection on partial replacement and never expires it', () => {
    const f = fixture()
    writeFileSync(f.entry, 'new')
    const targetManifest = captureInstallationManifest(f.location.installationRoot, '2')
    writeFileSync(f.entry, 'old')
    const record = beginInstallationUpdate({ ...f.options, targetManifest })
    advanceInstallationUpdate(f.location, record.operationId, 'stopping')
    expect(() =>
      advanceInstallationUpdate(f.location, record.operationId, 'stopped', false)
    ).toThrow('clean')
    advanceInstallationUpdate(f.location, record.operationId, 'stopped', true)
    advanceInstallationUpdate(f.location, record.operationId, 'handoff')
    writeFileSync(f.entry, 'partial')
    expect(() => checkInstallationResult(f.location)).toThrow('completion evidence')
    expect(() => finishInstallationRecovery(f.location, record.operationId, 'cancel')).toThrow(
      'completion evidence'
    )
    writeFileSync(f.entry, 'new')
    expect(() => finishInstallationRecovery(f.location, record.operationId, 'complete')).toThrow(
      'completion evidence'
    )
    expect(inspectInstallationUpdate(f.location)?.phase).toBe('handoff')
  })
  it('rejects stale operation mutation and cancellation after files change', () => {
    const f = fixture()
    const record = beginInstallationUpdate(f.options)
    expect(() => advanceInstallationUpdate(f.location, 'other', 'stopping')).toThrow('changed')
    writeFileSync(f.entry, 'partial')
    expect(() => finishInstallationRecovery(f.location, record.operationId, 'cancel')).toThrow(
      'integrity'
    )
    expect(inspectInstallationUpdate(f.location)?.operationId).toBe(record.operationId)
  })
  it('detects unregistered installation processes before persisting or stopping', () => {
    const f = fixture()
    expect(() =>
      beginInstallationUpdate({ ...f.options, inspectProcesses: () => [process.pid + 100000] })
    ).toThrow('Another process')
    expect(inspectInstallationUpdate(f.location)).toBeUndefined()
  })
  it('keeps startup exclusion across a real process crash and permits stale registration reclamation', async () => {
    const f = fixture()
    const script = `const { protectInstallationStartup } = require(${JSON.stringify(join(process.cwd(), 'packages/open-science/installation-startup.cjs'))}); globalThis.lease = protectInstallationStartup(${JSON.stringify(f.entry)}, 'other-profile', ${JSON.stringify(f.location.stateRoot)}); process.stdout.write('ready'); setInterval(() => {}, 1000)`
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve())
        child.once('error', reject)
        child.once('exit', () => reject(new Error('child exited before registration')))
      })
      expect(() => beginInstallationUpdate(f.options)).toThrow('Another service')
    } finally {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.kill('SIGKILL')
      await exited
    }
    const record = beginInstallationUpdate(f.options)
    const blocked = spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
    const code = await new Promise<number | null>((resolve) => blocked.once('exit', resolve))
    expect(code).not.toBe(0)
    expect(inspectInstallationUpdate(f.location)?.operationId).toBe(record.operationId)
    finishInstallationRecovery(f.location, record.operationId, 'cancel')
  }, 15000)
})

it.runIf(process.platform === 'linux')(
  'blocks an unregistered bundled Node with rewritten argv until the actual process exits',
  async () => {
    const f = fixture()
    const executable = join(f.location.installationRoot, 'node')
    copyFileSync(process.execPath, executable)
    const child = spawn(
      executable,
      ['-e', "process.title='old-node';process.stdout.write('ready');setInterval(()=>{},1000)"],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve())
        child.once('error', reject)
        child.once('exit', () => reject(new Error('child exited before readiness')))
      })
      expect(inspectInstallationProcesses(f.location.installationRoot)).toContain(child.pid)
      expect(await inspectInstallationProcessesAsync(f.location.installationRoot)).toContain(
        child.pid
      )
      await expect(inspectInstallationAvailability(f.location)).rejects.toMatchObject({
        reason: 'installation-busy',
        recovery: { detail: 'other-runtime' }
      })
      expect(child.exitCode).toBeNull()
      expect(inspectInstallationUpdate(f.location)).toBeUndefined()
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
        child.kill('SIGTERM')
        await exited
      }
    }
    await expect(inspectInstallationAvailability(f.location)).resolves.toBeUndefined()
  },
  15000
)

it('uses the persisted path spelling when native realpath expands a Windows short name', async () => {
  const f = fixture()
  const record = beginInstallationUpdate(f.options)
  finishInstallationRecovery(f.location, record.operationId, 'cancel')
  const ticket = inspectInstallationStartup(f.location)
  // fs.promises.realpath uses the native resolver; fs.realpathSync preserves 8.3 names.
  const nativeRoot = join(f.directory, 'expanded-native-name')
  symlinkSync(f.location.installationRoot, nativeRoot, 'junction')
  const persistedRoot = record.installationRoot
  vi.mocked(installationFs.promises.realpath).mockImplementation(async (path) => {
    const resolved = await realpath(path)
    return resolved.startsWith(persistedRoot)
      ? nativeRoot + resolved.slice(persistedRoot.length)
      : resolved
  })
  await expect(inspectInstallationStartupAsync(f.location)).resolves.toEqual(ticket)
})

it('cancels streaming verification without clearing update protection', async () => {
  const f = fixture()
  writeFileSync(f.entry, Buffer.alloc(16 * 1024 * 1024, 7))
  const record = beginInstallationUpdate(f.options)
  const controller = new AbortController()
  const checking = finishInstallationRecoveryAsync(
    f.location,
    record.operationId,
    'cancel',
    controller.signal
  )
  setTimeout(() => controller.abort(new Error('stop verification')), 0)
  await expect(checking).rejects.toThrow()
  expect(inspectInstallationUpdate(f.location)?.operationId).toBe(record.operationId)
})
it('rejects a concurrent phase change during asynchronous recovery verification', async () => {
  const f = fixture()
  writeFileSync(f.entry, Buffer.alloc(4 * 1024 * 1024, 7))
  const record = beginInstallationUpdate(f.options)
  const checking = finishInstallationRecoveryAsync(f.location, record.operationId, 'cancel')
  advanceInstallationUpdate(f.location, record.operationId, 'stopping')
  await expect(checking).rejects.toThrow('changed during verification')
  expect(inspectInstallationUpdate(f.location)?.phase).toBe('stopping')
})
it('checks unregistered processes again at the final installer boundary', async () => {
  const f = fixture()
  const targetManifest = await captureInstallationManifestAsync(f.location.installationRoot, '2')
  const record = beginInstallationUpdate({ ...f.options, targetManifest })
  advanceInstallationUpdate(f.location, record.operationId, 'stopping')
  advanceInstallationUpdate(f.location, record.operationId, 'stopped', true)
  await expect(
    advanceInstallationUpdateAsync(f.location, record.operationId, 'handoff', undefined, {
      inspectProcesses: async () => [process.pid + 100000]
    })
  ).rejects.toThrow('Another process')
  expect(inspectInstallationUpdate(f.location)?.phase).toBe('stopped')
})

it('admits authenticated current-runtime helpers before the gate but blocks handoff until they exit', async () => {
  const f = fixture(),
    previous = process.env.OPEN_SCIENCE_INSTALLATION_OWNER
  const runtime = registerInstallationRuntime({ ...f.location, ...f.runtime })
  const script = `process.argv.push('--open-science-artifact-mcp');const {protectInstallationStartup}=require(${JSON.stringify(join(process.cwd(), 'packages/open-science/installation-startup.cjs'))});globalThis.lease=protectInstallationStartup(${JSON.stringify(f.entry)},'default',${JSON.stringify(f.location.stateRoot)});process.stdout.write('ready');setInterval(()=>{},1000)`
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve())
      child.once('exit', () => reject(new Error('helper failed')))
      child.once('error', reject)
    })
    await expect(
      inspectInstallationAvailability({
        ...f.location,
        runtime: f.runtime,
        inspectProcesses: async () => [child.pid!]
      })
    ).resolves.toBeUndefined()
    const record = beginInstallationUpdate({
      ...f.options,
      inspectProcesses: () => [child.pid!],
      targetManifest: captureInstallationManifest(f.location.installationRoot, '2')
    })
    advanceInstallationUpdate(f.location, record.operationId, 'stopping')
    advanceInstallationUpdate(f.location, record.operationId, 'stopped', true)
    runtime.release()
    expect(() => advanceInstallationUpdate(f.location, record.operationId, 'handoff')).toThrow()
  } finally {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGKILL')
    await exited
    runtime.release()
    if (previous === undefined) delete process.env.OPEN_SCIENCE_INSTALLATION_OWNER
    else process.env.OPEN_SCIENCE_INSTALLATION_OWNER = previous
  }
})

describe('stale registration garbage collection', () => {
  const registrations = (directory: string): string[] =>
    readdirSync(directory).filter((name) => /^[\da-f-]{36}\.(json|sqlite)$/.test(name))
  const leaveStale = (f: ReturnType<typeof fixture>, count: number): void => {
    for (let i = 0; i < count; i += 1)
      protectInstallationStartup(f.entry, 'profile', f.location.stateRoot).release()
  }

  it('removes released registrations when a runtime registers and keeps live ones', () => {
    const f = fixture()
    const live = protectInstallationStartup(f.entry, 'live', f.location.stateRoot)
    const directory = installationStateDirectory(f.location)
    for (let i = 0; i < 5; i += 1) {
      const id = `00000000-0000-0000-0000-00000000000${i}`
      writeFileSync(join(directory, `${id}.sqlite`), '')
      writeFileSync(join(directory, `${id}.json`), '{}')
    }
    expect(registrations(directory)).toHaveLength(12)
    const runtime = registerInstallationRuntime({ ...f.location, ...f.runtime })
    const left = registrations(directory)
    expect(left).toHaveLength(4)
    expect(left.some((name) => name.startsWith(live.identity.generation))).toBe(true)
    runtime.release()
    live.release()
  })

  it('collects stale registrations during backend startup before scanning helpers', () => {
    const f = fixture()
    leaveStale(f, 4)
    const directory = installationStateDirectory(f.location)
    const lease = protectInstallationStartup(f.entry, 'next', f.location.stateRoot)
    expect(registrations(directory)).toHaveLength(2)
    lease.release()
  })

  it('reclaims unreadable registrations whose lock is free and never blocks startup on them', () => {
    const f = fixture()
    leaveStale(f, 1)
    const directory = installationStateDirectory(f.location)
    const orphan = '11111111-1111-1111-1111-111111111111'
    writeFileSync(join(directory, `${orphan}.json`), '')
    writeFileSync(join(directory, '22222222-2222-2222-2222-222222222222.json'), '{broken')
    writeFileSync(join(directory, '33333333-3333-3333-3333-333333333333.sqlite'), '')
    const previous = process.env.OPEN_SCIENCE_INSTALLATION_OWNER
    const argv = [...process.argv]
    process.env.OPEN_SCIENCE_INSTALLATION_OWNER = JSON.stringify({
      pid: 1,
      generation: 'x',
      configRoot: 'c',
      token: 't'
    })
    process.argv.push('--open-science-artifact-mcp')
    try {
      expect(() => protectInstallationStartup(f.entry, 'default', f.location.stateRoot)).toThrow(
        'no longer valid'
      )
    } finally {
      process.argv.splice(0, process.argv.length, ...argv)
      if (previous === undefined) delete process.env.OPEN_SCIENCE_INSTALLATION_OWNER
      else process.env.OPEN_SCIENCE_INSTALLATION_OWNER = previous
    }
    expect(existsSync(join(directory, `${orphan}.json`))).toBe(false)
    expect(registrations(directory)).toHaveLength(0)
    writeFileSync(join(directory, `${orphan}.json`), '')
    const record = beginInstallationUpdate(f.options)
    expect(existsSync(join(directory, `${orphan}.json`))).toBe(false)
    finishInstallationRecovery(f.location, record.operationId, 'cancel')
  })

  it('keeps the update gate blocked by a live registration with an unreadable record', () => {
    const f = fixture()
    const live = protectInstallationStartup(f.entry, 'live', f.location.stateRoot)
    const directory = installationStateDirectory(f.location)
    writeFileSync(join(directory, `${live.identity.generation}.json`), '{broken')
    expect(() => beginInstallationUpdate(f.options)).toThrow()
    expect(existsSync(join(directory, `${live.identity.generation}.sqlite`))).toBe(true)
    live.release()
  })
})
