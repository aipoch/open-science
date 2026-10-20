import { createHash } from 'node:crypto'
import { verifyDesktopRecoveryReadiness } from './desktop-recovery-readiness'
import type { DesktopRuntimeClient } from './desktop-runtime-client'
import * as occupancy from './update/installation-occupancy'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  beginInstallationUpdate,
  bindInstallationExecutor,
  finishInstallationRecovery,
  finishInstallationRecoveryAsync,
  advanceInstallationUpdate,
  installationStateDirectory,
  captureInstallationManifest,
  inspectInstallationStartup,
  inspectInstallationUpdate
} from './update/installation-protection'
import {
  connectDesktopRuntimeForStartup,
  DesktopRuntimeStartupError,
  resolveDesktopInstallationStartup
} from './desktop-startup-recovery'
// Boot-query integration is covered separately; lifecycle fixtures need a stable boot.
vi.mock('./system-boot-identity', async (original) => ({
  ...(await original<typeof import('./system-boot-identity')>()),
  systemBootIdentity: () => 'windows-boot:12345678-1234-4321-8123-123456789abc'
}))

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it('retains installation protection through early resolution and rechecks integrity before launching', async () => {
  const root = mkdtempSync(join(tmpdir(), 'early-installation-'))
  roots.push(root)
  const installationRoot = join(root, 'app')
  const target = join(root, 'target')
  mkdirSync(installationRoot)
  mkdirSync(target)
  writeFileSync(join(installationRoot, 'program'), 'old')
  writeFileSync(join(target, 'program'), 'new')
  const location = { installationRoot, stateRoot: join(root, 'external-state') }
  const options = {
    configRoot: join(root, 'config'),
    dataRoot: join(root, 'data'),
    profilePath: join(root, 'profile'),
    host: '127.0.0.1' as const,
    port: 44001,
    credentialStore: 'file' as const
  }
  const record = beginInstallationUpdate({
    ...location,
    runtime: { pid: process.pid, generation: 'generation', configRoot: options.configRoot },
    startupOptions: options,
    currentVersion: '1',
    targetVersion: '2',
    targetManifest: captureInstallationManifest(target, '2'),
    inspectProcesses: () => []
  })
  await expect(resolveDesktopInstallationStartup({ ...location, version: '2' })).rejects.toThrow(
    DesktopRuntimeStartupError
  )
  advanceInstallationUpdate(location, record.operationId, 'stopping')
  advanceInstallationUpdate(location, record.operationId, 'stopped', true)
  advanceInstallationUpdate(location, record.operationId, 'handoff')
  const executor = join(root, 'executor')
  mkdirSync(executor)
  const request = JSON.stringify({ operationId: record.operationId })
  const requestSha256 = createHash('sha256').update(request).digest('hex')
  writeFileSync(join(executor, 'request.json'), request)
  bindInstallationExecutor(location, record.operationId, {
    channel: 'supervised-mac',
    directory: executor,
    requestSha256
  })
  writeFileSync(
    join(executor, 'result.json'),
    JSON.stringify({ operationId: record.operationId, requestSha256, outcome: 'installed' })
  )
  writeFileSync(join(installationRoot, 'program'), 'new')
  const recovery = (await resolveDesktopInstallationStartup({ ...location, version: '2' }))!
  expect(recovery.startupOptions).toEqual(options)
  expect(inspectInstallationUpdate(location)).toBeDefined()
  writeFileSync(join(installationRoot, 'program'), 'partial')
  await expect(recovery.completeBeforeLaunch()).rejects.toMatchObject({
    name: 'DesktopRuntimeStartupError',
    issue: { reason: 'startup-recovery-required', canRecover: true }
  })
  expect(inspectInstallationUpdate(location)).toBeDefined()
  writeFileSync(join(installationRoot, 'program'), 'new')
  await recovery.completeBeforeLaunch()
  expect(inspectInstallationUpdate(location)).toBeUndefined()
  expect(inspectInstallationStartup(location)?.startupOptions).toEqual(options)
  // Simulate Desktop disappearing between releasing installation protection and reading data.
  const restarted = (await resolveDesktopInstallationStartup({ ...location, version: '2' }))!
  expect(restarted.startupOptions).toEqual(options)
  await restarted.completeBeforeLaunch()
  expect(inspectInstallationStartup(location)).toBeDefined()
  let isComplete = false
  const client = {
    startupState: () => ({ phase: 'ready' }),
    runtimeInfo: () => ({ startupOptions: options }),
    invokeHost: async (name: string) =>
      name === 'storage:get-status'
        ? { dataRoot: options.dataRoot, dataRootMissing: false }
        : name === 'sessions:list'
          ? {
              sessions: [],
              diagnostics: { isComplete, warnings: [], isProjectDeletionRecoveryComplete: true }
            }
          : []
  } as unknown as DesktopRuntimeClient
  const finishStartup = async (): Promise<void> => {
    await verifyDesktopRecoveryReadiness(client, options)
    await restarted.completeAfterReady()
  }
  await expect(finishStartup()).rejects.toThrow('saved conversations')
  expect(inspectInstallationStartup(location)?.startupOptions).toEqual(options)
  isComplete = true
  await finishStartup()
  expect(inspectInstallationStartup(location)).toBeUndefined()
})

it('offers startup Recover after a real executor rollback and retains its configuration ticket', async () => {
  const { spawn } = await import('node:child_process')
  const { createHash } = await import('node:crypto')
  const { INSTALLATION_EXECUTOR_SOURCE } = await import('./update/installation-executor')
  const { advanceInstallationUpdate, bindInstallationExecutor, installationStateDirectory } =
    await import('./update/installation-protection')
  const root = mkdtempSync(join(tmpdir(), 'startup-rollback-'))
  roots.push(root)
  const app = join(root, 'app'),
    replacement = join(root, 'replacement'),
    executor = join(root, 'executor'),
    configRoot = join(root, 'config')
  for (const path of [app, replacement, executor, configRoot]) mkdirSync(path)
  writeFileSync(join(app, 'program'), 'old')
  writeFileSync(join(replacement, 'program'), 'new')
  const location = { installationRoot: app, stateRoot: join(root, 'state') }
  const config = {
    configRoot,
    dataRoot: join(root, 'data'),
    profilePath: join(root, 'profile'),
    host: '127.0.0.1' as const,
    port: 43001,
    credentialStore: 'file' as const
  }
  const record = beginInstallationUpdate({
    ...location,
    currentVersion: '1',
    targetVersion: '2',
    runtime: { pid: 2147483647, generation: 'g', configRoot },
    startupOptions: config,
    targetManifest: captureInstallationManifest(replacement, '2'),
    inspectProcesses: () => []
  })
  advanceInstallationUpdate(location, record.operationId, 'stopping')
  advanceInstallationUpdate(location, record.operationId, 'stopped', true)
  advanceInstallationUpdate(location, record.operationId, 'handoff')
  const bytes = JSON.stringify({
    channel: 'supervised-mac',
    operationId: record.operationId,
    recordPath: join(installationStateDirectory(location), 'update-in-progress.json'),
    installationRoot: record.installationRoot,
    stagedBundle: replacement,
    backup: join(root, 'backup'),
    discard: join(root, 'discard'),
    desktopPid: 2147483647,
    relaunch: false,
    fault: 'after-old-rename'
  })
  writeFileSync(join(executor, 'request.json'), bytes)
  writeFileSync(join(executor, 'executor.cjs'), INSTALLATION_EXECUTOR_SOURCE)
  bindInstallationExecutor(location, record.operationId, {
    channel: 'supervised-mac',
    directory: executor,
    requestSha256: createHash('sha256').update(bytes).digest('hex')
  })
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(executor, 'executor.cjs'), join(executor, 'request.json')],
      { stdio: 'ignore' }
    )
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`executor exit ${code}`))
    )
  })
  const blocked = await resolveDesktopInstallationStartup({ ...location, version: '1' }).catch(
    (error) => error
  )
  expect(blocked).toBeInstanceOf(DesktopRuntimeStartupError)
  await blocked.recover()
  expect(inspectInstallationUpdate(location)).toBeUndefined()
  const startup = await resolveDesktopInstallationStartup({ ...location, version: '1' })
  expect(startup?.startupOptions).toEqual(config)
  expect(startup?.outcome).toBe('recovered')
  expect(inspectInstallationStartup(location)).toBeDefined()
})

it('startup Recover settles a prior-boot failed stop and keeps the ticket until readiness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'startup-reboot-'))
  roots.push(root)
  const installationRoot = join(root, 'app'),
    configRoot = join(root, 'config'),
    dataRoot = join(root, 'data'),
    profilePath = join(root, 'profile')
  for (const p of [installationRoot, configRoot, dataRoot, profilePath]) mkdirSync(p)
  writeFileSync(join(installationRoot, 'program'), 'original')
  const location = { installationRoot, stateRoot: join(root, 'state') }
  const record = beginInstallationUpdate({
    ...location,
    currentVersion: '1',
    targetVersion: '2',
    runtime: { pid: process.pid, generation: 'prior-boot', configRoot },
    startupOptions: {
      configRoot,
      dataRoot,
      profilePath,
      host: '127.0.0.1',
      port: 0,
      credentialStore: 'file'
    },
    inspectProcesses: () => []
  })
  const stopping = advanceInstallationUpdate(location, record.operationId, 'stopping', false)
  // Simulated OS reboot evidence: no actual host reboot or process mutation.
  stopping.bootIdentity =
    record.bootIdentity!.split(':')[0] + ':ffffffff-ffff-4fff-8fff-ffffffffffff'
  writeFileSync(
    join(installationStateDirectory(location), 'update-in-progress.json'),
    JSON.stringify(stopping)
  )
  const blocked = await resolveDesktopInstallationStartup({
    ...location,
    version: '1',
    allowedProcessIds: () => [process.pid]
  }).catch((e) => e)
  expect(blocked).toBeInstanceOf(DesktopRuntimeStartupError)
  await blocked.recover()
  expect(inspectInstallationUpdate(location)).toBeUndefined()
  const startup = await resolveDesktopInstallationStartup({ ...location, version: '1' })
  expect(startup?.outcome).toBe('recovered')
  expect(inspectInstallationStartup(location)?.startupOptions).toEqual(record.startupOptions)
  await startup!.completeBeforeLaunch()
  expect(inspectInstallationStartup(location)).toBeDefined()
  await startup!.completeAfterReady()
  expect(inspectInstallationStartup(location)).toBeUndefined()
})

it.each(['missing', 'failed', 'unsafe-boot'])(
  'never completes a non-handoff target tree with %s stop proof',
  async (evidence) => {
    const root = mkdtempSync(join(tmpdir(), 'startup-incomplete-stop-'))
    roots.push(root)
    const app = join(root, 'app'),
      target = join(root, 'target'),
      configRoot = join(root, 'config')
    for (const p of [app, target, configRoot]) mkdirSync(p)
    writeFileSync(join(app, 'program'), 'old')
    writeFileSync(join(target, 'program'), 'new')
    const location = { installationRoot: app, stateRoot: join(root, 'state') }
    const record = beginInstallationUpdate({
      ...location,
      currentVersion: '1',
      targetVersion: '2',
      runtime: { pid: 2147483647, generation: 'failed-generation', configRoot },
      startupOptions: {
        configRoot,
        dataRoot: configRoot,
        profilePath: configRoot,
        host: '127.0.0.1',
        port: 0,
        credentialStore: 'file'
      },
      targetManifest: captureInstallationManifest(target, '2'),
      inspectProcesses: () => []
    })
    const stopping = advanceInstallationUpdate(location, record.operationId, 'stopping', false)
    if (evidence === 'unsafe-boot') {
      stopping.bootIdentity = 'darwin:123:456'
      writeFileSync(
        join(installationStateDirectory(location), 'update-in-progress.json'),
        JSON.stringify(stopping)
      )
    }
    if (evidence === 'failed')
      writeFileSync(join(configRoot, 'runtime-exit.json'), JSON.stringify({ outcome: 'failed' }))
    writeFileSync(join(app, 'program'), 'new')
    const blocked = await resolveDesktopInstallationStartup({ ...location, version: '2' }).catch(
      (error) => error
    )
    expect(blocked).toBeInstanceOf(DesktopRuntimeStartupError)
    await expect(blocked.recover()).rejects.toThrow()
    expect(() => finishInstallationRecovery(location, record.operationId, 'complete')).toThrow(
      'settled installer handoff'
    )
    await expect(
      finishInstallationRecoveryAsync(location, record.operationId, 'complete')
    ).rejects.toThrow('settled installer handoff')
    expect(inspectInstallationUpdate(location)?.stoppedClean).toBe(false)
    expect(inspectInstallationStartup(location)).toBeUndefined()
  }
)
it.each([false, true])(
  'uses fresh own UI process metrics while still refusing external occupants: %s',
  async (external) => {
    const root = mkdtempSync(join(tmpdir(), 'startup-live-metrics-'))
    roots.push(root)
    const app = join(root, 'app'),
      configRoot = join(root, 'config')
    mkdirSync(app)
    mkdirSync(configRoot)
    writeFileSync(join(app, 'program'), 'original')
    const location = { installationRoot: app, stateRoot: join(root, 'state') }
    const record = beginInstallationUpdate({
      ...location,
      currentVersion: '1',
      targetVersion: '2',
      runtime: { pid: 2147483647, generation: 'prior-boot', configRoot },
      startupOptions: {
        configRoot,
        dataRoot: configRoot,
        profilePath: configRoot,
        host: '127.0.0.1',
        port: 0,
        credentialStore: 'file'
      },
      inspectProcesses: () => []
    })
    const stopping = advanceInstallationUpdate(location, record.operationId, 'stopping', false)
    stopping.bootIdentity =
      record.bootIdentity!.split(':')[0] + ':ffffffff-ffff-4fff-8fff-ffffffffffff'
    writeFileSync(
      join(installationStateDirectory(location), 'update-in-progress.json'),
      JSON.stringify(stopping)
    )
    let own: number[] = []
    const metrics = vi.fn(() => [process.pid, ...own])
    const blocked = await resolveDesktopInstallationStartup({
      ...location,
      version: '1',
      allowedProcessIds: metrics
    }).catch((error) => error)
    expect(blocked).toBeInstanceOf(DesktopRuntimeStartupError)
    own = [876543]
    let scans = 0
    vi.spyOn(occupancy, 'inspectInstallationProcessesAsync').mockImplementation(async () => {
      if (++scans === 2) own.push(876544) // another legitimate process can appear during verification
      return [...own, ...(external ? [876545] : [])]
    })
    if (external) {
      await expect(blocked.recover()).rejects.toThrow('Another process')
      expect(inspectInstallationUpdate(location)).toBeDefined()
    } else {
      await blocked.recover()
      expect(metrics).toHaveBeenCalledTimes(2)
      expect(inspectInstallationUpdate(location)).toBeUndefined()
      expect(inspectInstallationStartup(location)?.intent).toBe('cancel')
    }
  }
)

it('deduplicates pending stops and allows a rejected stop to be retried', async () => {
  const stop = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(undefined)
  const error = new DesktopRuntimeStartupError(
    { reason: 'legacy-service', desktopVersion: '2', canStop: true, canRecover: true },
    'Older service',
    stop
  )
  await expect(error.stopAndContinue()).rejects.toThrow('unavailable')
  await Promise.all([error.stopAndContinue(), error.stopAndContinue()])
  expect(stop).toHaveBeenCalledTimes(2)
})

const fakeClient = (controlReason?: string): DesktopRuntimeClient =>
  ({
    runtimeInfo: () => ({ control: 'held', controlReason }),
    refreshControl: vi.fn(async () => undefined),
    close: vi.fn()
  }) as unknown as DesktopRuntimeClient

it('replaces a runtime that is already stopping instead of entering as a spectator', async () => {
  const stopping = fakeClient('runtime-stopping')
  const fresh = { ...fakeClient(undefined), runtimeInfo: () => ({ control: 'granted' }) }
  const connect = vi
    .fn()
    .mockResolvedValueOnce(stopping)
    .mockResolvedValueOnce(fresh as unknown as DesktopRuntimeClient)
  const replaceRuntime = vi.fn(async () => undefined)
  await expect(
    connectDesktopRuntimeForStartup({ connect, version: 'test', replaceRuntime })
  ).resolves.toBe(fresh)
  expect(replaceRuntime).toHaveBeenCalledOnce()
  expect(stopping.close).toHaveBeenCalled()
})

it('makes startup recover do real work when the runtime is stopping', async () => {
  const connect = vi.fn().mockResolvedValue(fakeClient('runtime-stopping'))
  let replaced = 0
  const replaceRuntime = vi.fn(async () => {
    replaced += 1
    if (replaced === 1) throw new Error('first replacement failed')
  })
  const error = await connectDesktopRuntimeForStartup({
    connect,
    version: 'test',
    replaceRuntime
  }).catch((reason: unknown) => reason)
  expect(error).toBeInstanceOf(DesktopRuntimeStartupError)
  await (error as DesktopRuntimeStartupError).recover()
  expect(replaceRuntime).toHaveBeenCalledTimes(2)
})

it('retains modern stop authority and reviewed configuration after transient recovery failure', async () => {
  const config = {
    configRoot: '/config',
    dataRoot: '/data',
    profilePath: '/profile',
    host: '127.0.0.1' as const,
    port: 0,
    credentialStore: 'os' as const
  }
  const stop = vi
    .fn()
    .mockRejectedValueOnce(new Error('shutdown unavailable'))
    .mockResolvedValue(undefined)
  const failure = new DesktopRuntimeStartupError(
    { reason: 'version-mismatch', desktopVersion: '2', canStop: true, canRecover: false },
    'Version mismatch',
    stop,
    undefined,
    config
  )
  await expect(failure.stopAndContinue()).rejects.toThrow('shutdown unavailable')
  const retry = failure.withRetryDiagnostics('redacted failure')
  expect(retry.issue).toMatchObject({
    reason: 'version-mismatch',
    canStop: true,
    canRecover: false,
    diagnostics: 'redacted failure'
  })
  expect(retry.startupOptions).toBe(config)
  await expect(retry.stopAndContinue()).resolves.toBeUndefined()
  expect(stop).toHaveBeenCalledTimes(2)
  await expect(retry.recover()).rejects.toBe(retry)
})

it('retains recovery-only capabilities without granting stop authority', async () => {
  const recover = vi.fn().mockResolvedValue(undefined)
  const failure = new DesktopRuntimeStartupError(
    { reason: 'startup-recovery-required', desktopVersion: '2', canStop: false, canRecover: true },
    'Recovery required',
    undefined,
    recover
  )
  const retry = failure.withRetryDiagnostics('redacted failure')
  await expect(retry.recover()).resolves.toBeUndefined()
  expect(recover).toHaveBeenCalledOnce()
  await expect(retry.stopAndContinue()).rejects.toBe(retry)
})
