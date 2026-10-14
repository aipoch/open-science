import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
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
  completeInstallationStartup,
  installationRootForEntry,
  registerInstallationRuntime
} from './installation-protection'

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
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('installation protection', () => {
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
