import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  discardPreparedInstallation,
  INSTALLATION_EXECUTOR_SOURCE,
  launchPreparedInstaller,
  prepareSupervisedDebInstallation,
  prepareSupervisedMacInstallation
} from './installation-executor'
import {
  advanceInstallationUpdate,
  beginInstallationUpdate,
  captureInstallationManifestAsync,
  inspectInstallationUpdate,
  installationStateDirectory
} from './installation-protection'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  inspectMac: vi.fn(),
  inspectArtifact: vi.fn(),
  prerequisites: vi.fn(),
  createGate: vi.fn(),
  cancelGate: vi.fn(),
  cancelUnclaimed: vi.fn(),
  run: vi.fn(),
  settled: vi.fn()
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: mocks.spawn
}))
vi.mock('./installation-artifact', async (original) => ({
  ...(await original<typeof import('./installation-artifact')>()),
  inspectMacUpdateArtifact: mocks.inspectMac,
  inspectUpdateArtifact: mocks.inspectArtifact
}))
vi.mock('./deb-systemd-gate', async (original) => ({
  ...(await original<typeof import('./deb-systemd-gate')>()),
  assertDebGraphicalPrerequisites: mocks.prerequisites,
  createDebSystemdGate: mocks.createGate,
  cancelDebSystemdGate: mocks.cancelGate,
  cancelUnclaimedDebGates: mocks.cancelUnclaimed
}))
vi.mock('./verification-process', () => ({
  runVerificationProcess: mocks.run,
  verificationDirectoryIsSettled: mocks.settled
}))

// Boot-query failures are covered separately; preparation fixtures need a stable boot.
vi.mock('../system-boot-identity', async (original) => ({
  ...(await original<typeof import('../system-boot-identity')>()),
  systemBootIdentity: () => 'windows-boot:12345678-1234-4321-8123-123456789abc'
}))

let root: string
beforeEach(async () => {
  vi.resetAllMocks()
  root = await realpath(await mkdtemp(join(tmpdir(), 'installation-preparation-')))
  mocks.settled.mockReturnValue(true)
  mocks.run.mockImplementation(async (command: string, args: string[]) => {
    if (command === '/usr/bin/ditto') await cp(args[0], args[1], { recursive: true })
    return { stdout: '', stderr: '' }
  })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function fixture(): Promise<Parameters<typeof prepareSupervisedDebInstallation>[0]> {
  const installationRoot = join(root, 'Open-Science.app')
  const replacement = join(root, 'downloaded.app')
  await mkdir(join(installationRoot, 'Contents/Resources/node-runtime'), { recursive: true })
  const runtimeNode = join(installationRoot, 'Contents/Resources/node-runtime/node')
  await writeFile(runtimeNode, 'isolated runtime fixture')
  await mkdir(replacement)
  await writeFile(join(replacement, 'program'), 'new application')
  const manifest = await captureInstallationManifestAsync(replacement, '2.0.0')
  mocks.inspectMac.mockImplementation(async (_archive, _version, _signal, retain) => {
    await retain(replacement)
    return manifest
  })
  mocks.inspectArtifact.mockResolvedValue(manifest)
  const archive = join(root, 'update.zip')
  await writeFile(archive, 'verified archive')
  return {
    installationRoot,
    stateRoot: join(root, 'state'),
    archive,
    targetVersion: '2.0.0',
    sha512: createHash('sha512').update('verified archive').digest('base64'),
    runtimeNode,
    currentExecutable: join(installationRoot, 'open-science')
  }
}

async function stagingDirectories(): Promise<string[]> {
  return (await readdir(root)).filter((name) => name.startsWith('.open-science-install-'))
}

describe('macOS installation preparation', () => {
  it('stages verified bytes beside the bundle and isolates its executable before handoff', async () => {
    const options = await fixture()
    const signal = new AbortController().signal
    const prepared = await prepareSupervisedMacInstallation({ ...options, signal })
    expect(prepared.installationRoot).toBe(options.installationRoot)
    expect(dirname(dirname(prepared.stagedBundle))).toBe(root)
    expect(dirname(prepared.directory)).toBe(installationStateDirectory(options))
    expect(await readFile(join(prepared.stagedBundle, 'program'), 'utf8')).toBe('new application')
    expect(await readFile(prepared.nodePath, 'utf8')).toBe('isolated runtime fixture')
    expect(await readFile(prepared.executorPath, 'utf8')).toBe(INSTALLATION_EXECUTOR_SOURCE)
    expect(mocks.run).toHaveBeenLastCalledWith(
      prepared.nodePath,
      ['-e', "new (require('node:sqlite').DatabaseSync)(':memory:').close()"],
      { cwd: prepared.directory, signal }
    )
    await discardPreparedInstallation(prepared)
    expect(await stagingDirectories()).toEqual([])
    expect(await readdir(installationStateDirectory(options))).toEqual([])
  })

  it('rejects a changed archive before extraction and removes unused staging', async () => {
    const options = await fixture()
    await writeFile(options.archive, 'tampered')
    await expect(prepareSupervisedMacInstallation(options)).rejects.toThrow('checksum has changed')
    expect(mocks.inspectMac).not.toHaveBeenCalled()
    expect(await stagingDirectories()).toEqual([])
  })

  it('rejects a staged payload that differs from the inspected manifest', async () => {
    const options = await fixture()
    mocks.inspectMac.mockImplementation(async (_archive, _version, _signal, retain) => {
      await retain(join(root, 'downloaded.app'))
      return { version: '2.0.0', files: { program: 'changed' } }
    })
    await expect(prepareSupervisedMacInstallation(options)).rejects.toThrow('integrity mismatch')
    expect(await stagingDirectories()).toEqual([])
  })

  it.each([true, false])('cleans a failed runtime probe only when settled=%s', async (settled) => {
    const options = await fixture()
    mocks.run.mockImplementation(async (command: string, args: string[]) => {
      if (command === '/usr/bin/ditto') return cp(args[0], args[1], { recursive: true })
      throw new Error('runtime probe failed')
    })
    mocks.settled.mockReturnValue(settled)
    await expect(prepareSupervisedMacInstallation(options)).rejects.toThrow('runtime probe failed')
    expect((await stagingDirectories()).length).toBe(settled ? 0 : 1)
    expect((await readdir(installationStateDirectory(options))).length).toBe(settled ? 0 : 1)
  })
})

describe('Debian installation preparation', () => {
  it('verifies the staged archive before authorizing a gate and cancels it before cleanup', async () => {
    const options = await fixture()
    const signal = new AbortController().signal
    mocks.createGate.mockImplementation(async ({ directory }) => ({
      directory,
      stateDirectory: join(root, 'gate'),
      binding: 'binding',
      nonce: 'nonce',
      unit: 'test.service'
    }))
    const prepared = await prepareSupervisedDebInstallation({ ...options, signal })
    expect(mocks.prerequisites).toHaveBeenCalledWith(signal)
    expect(mocks.cancelUnclaimed).toHaveBeenCalledWith(installationStateDirectory(options))
    expect(mocks.createGate).toHaveBeenCalledWith({
      ...options,
      signal,
      directory: prepared.directory,
      archive: prepared.stagedBundle
    })
    expect(prepared.channel).toBe('supervised-deb')
    expect(prepared.launchPath).toBe(options.currentExecutable)
    expect(await readFile(prepared.stagedBundle, 'utf8')).toBe('verified archive')
    expect(await readFile(prepared.executorPath, 'utf8')).toBe(INSTALLATION_EXECUTOR_SOURCE)
    await writeFile(join(prepared.directory, 'request.json'), 'accepted')
    await expect(discardPreparedInstallation(prepared)).rejects.toThrow('cannot be discarded')
    expect(mocks.cancelGate).not.toHaveBeenCalled()
    await rm(join(prepared.directory, 'request.json'))
    mocks.cancelGate.mockImplementation(async () => {
      expect(await readFile(prepared.stagedBundle, 'utf8')).toBe('verified archive')
    })
    await discardPreparedInstallation(prepared)
    expect(mocks.cancelGate).toHaveBeenCalledWith(prepared.debGate)
    expect(await readdir(installationStateDirectory(options))).toEqual([])
  })

  it('removes a failed staged checksum before creating an authorization gate', async () => {
    const options = await fixture()
    await writeFile(options.archive, 'tampered')
    await expect(prepareSupervisedDebInstallation(options)).rejects.toThrow('checksum has changed')
    expect(mocks.createGate).not.toHaveBeenCalled()
    expect(await readdir(installationStateDirectory(options))).toEqual([])
  })

  it.each([true, false])(
    'retains failed authorization materials when a durable gate exists=%s',
    async (hasGate) => {
      const options = await fixture()
      mocks.createGate.mockImplementation(async ({ directory }) => {
        if (hasGate) await writeFile(join(directory, 'deb-gate.json'), 'pending authorization')
        throw new Error('authorization failed')
      })
      await expect(prepareSupervisedDebInstallation(options)).rejects.toThrow(
        'authorization failed'
      )
      expect((await readdir(installationStateDirectory(options))).length).toBe(hasGate ? 1 : 0)
    }
  )
})

it('binds a durable request before launch and waits for the executor acknowledgement', async () => {
  const options = await fixture()
  const prepared = await prepareSupervisedMacInstallation(options)
  const record = beginInstallationUpdate({
    ...options,
    currentVersion: '1.0.0',
    targetManifest: prepared.manifest,
    runtime: { pid: process.pid, generation: 'fixture', configRoot: join(root, 'config') },
    startupOptions: {
      configRoot: join(root, 'config'),
      dataRoot: join(root, 'data'),
      profilePath: join(root, 'profile'),
      host: '127.0.0.1',
      port: 0,
      credentialStore: 'file'
    },
    inspectProcesses: () => []
  })
  advanceInstallationUpdate(options, record.operationId, 'stopping')
  advanceInstallationUpdate(options, record.operationId, 'stopped', true)
  advanceInstallationUpdate(options, record.operationId, 'handoff')
  const child = Object.assign(new EventEmitter(), { pid: 12345, unref: vi.fn() })
  mocks.spawn.mockImplementation((_node, args) => {
    const requestBytes = readFileSync(args[1])
    const requestSha256 = createHash('sha256').update(requestBytes).digest('hex')
    expect(inspectInstallationUpdate(options)?.executor).toEqual({
      channel: 'supervised-mac',
      directory: prepared.directory,
      requestSha256
    })
    expect(JSON.parse(requestBytes.toString())).toMatchObject({
      operationId: record.operationId,
      installationRoot: options.installationRoot,
      stagedBundle: prepared.stagedBundle,
      nodeSha256: createHash('sha256').update('isolated runtime fixture').digest('hex'),
      executorSha256: createHash('sha256').update(INSTALLATION_EXECUTOR_SOURCE).digest('hex'),
      desktopPid: process.pid,
      relaunch: false
    })
    writeFileSync(
      join(prepared.directory, 'ready.json'),
      JSON.stringify({
        operationId: record.operationId,
        requestSha256,
        pid: child.pid
      })
    )
    return child
  })
  await expect(
    launchPreparedInstaller(options, 'stale-operation', prepared, {
      desktopPid: process.pid,
      relaunch: false
    })
  ).rejects.toThrow('operation changed')
  expect(mocks.spawn).not.toHaveBeenCalled()
  await launchPreparedInstaller(options, record.operationId, prepared, {
    desktopPid: process.pid,
    relaunch: false
  })
  expect(mocks.spawn).toHaveBeenCalledWith(
    prepared.nodePath,
    [prepared.executorPath, join(prepared.directory, 'request.json')],
    { detached: true, stdio: 'ignore' }
  )
  expect(child.unref).toHaveBeenCalledOnce()
  await expect(discardPreparedInstallation(prepared)).rejects.toThrow('cannot be discarded')
})
