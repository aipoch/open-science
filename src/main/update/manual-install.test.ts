import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ManualInstallInfo, UpdateStatus } from '../../shared/update'
import {
  ManualInstallerFallback,
  manualInstallerFormat,
  type ManualInstallerOptions
} from './manual-install'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
// Keep the fixture return shape inferred so mock signatures remain exact.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function fixture(options: ManualInstallerOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'manual-update-test-'))
  directories.push(directory)
  const path = join(directory, 'aipoch-open-science-2.0.0-linux-x64.AppImage')
  const bytes = Buffer.from('complete verified installer')
  await writeFile(path, bytes)
  let status: UpdateStatus = { state: 'ready', current: '1.0.0', latest: '2.0.0', localPath: path }
  const publish = vi.fn((manualInstall: ManualInstallInfo | undefined) => {
    status = { ...status, manualInstall }
  })
  const signature = vi.fn(async () => {})
  const reveal = vi.fn(async () => {})
  const store = join(directory, 'receipt.json')
  const configuration = {
    manualInstallStorePath: store,
    verifyManualInstallerSignature: signature,
    revealManualInstallerFile: reveal,
    ...options
  }
  const create = (): ManualInstallerFallback =>
    new ManualInstallerFallback(
      'linux',
      'x64',
      '1.0.0',
      configuration,
      () => status,
      publish,
      (update) => {
        status = { ...status, ...update }
      }
    )
  const owner = create()
  const input = {
    platform: 'linux' as const,
    arch: 'x64',
    version: '2.0.0',
    path,
    source: 'https://updates.example/aipoch-open-science-2.0.0-linux-x64.AppImage',
    size: bytes.length,
    algorithm: 'sha512' as const,
    checksum: createHash('sha512').update(bytes).digest('base64'),
    format: 'appimage' as const,
    standalone: true
  }
  await owner.capture(input)
  return {
    owner,
    create,
    store,
    path,
    bytes,
    input,
    signature,
    reveal,
    publish,
    status: () => status,
    setStatus: (update: Partial<UpdateStatus>) => {
      status = { ...status, ...update }
    }
  }
}

describe('manual installer qualification and continuity', () => {
  const occupancy: Partial<UpdateStatus> = {
    reason: 'installation-busy',
    recovery: {
      phase: 'preparing',
      runtime: 'running',
      installation: 'unchanged',
      canCancel: true,
      canRetryInstall: false,
      canRecover: false,
      detail: 'other-runtime'
    }
  }
  it('offers verified reveal with a quit warning for a live-confirmed pre-native occupancy refusal', async () => {
    const safety = vi.fn().mockResolvedValue('quit-required')
    const f = await fixture({ inspectManualInstallSafety: safety })
    // No failed installer record: the updater was refused before any native handoff.
    f.setStatus(occupancy)
    expect(f.owner.entry()?.kind).toBe('website')
    expect(await f.owner.get()).toMatchObject({
      kind: 'local',
      requiresQuitAndReleaseOccupancy: true
    })
    expect(f.signature).toHaveBeenCalledOnce()
    expect(await f.owner.revealInstaller()).toMatchObject({
      kind: 'local',
      requiresQuitAndReleaseOccupancy: true
    })
    expect(f.reveal).toHaveBeenCalledExactlyOnceWith(f.path)
    expect(safety).toHaveBeenCalledTimes(4)
  })
  it('keeps the occupancy warning on a website fallback without trusting an invalid file', async () => {
    const f = await fixture({ inspectManualInstallSafety: async () => 'quit-required' })
    f.setStatus(occupancy)
    await writeFile(f.path, Buffer.alloc(f.bytes.length, 42))
    expect(await f.owner.revealInstaller()).toMatchObject({
      kind: 'website',
      reason: 'unavailable',
      requiresQuitAndReleaseOccupancy: true
    })
    expect(f.reveal).not.toHaveBeenCalled()
  })
  it('requires the live hook for the occupancy exception and still checks the publisher', async () => {
    const missing = await fixture()
    missing.setStatus(occupancy)
    expect((await missing.owner.get()).kind).toBe('blocked')
    const f = await fixture({
      inspectManualInstallSafety: async () => 'quit-required',
      verifyManualInstallerSignature: async () => {
        throw new Error('invalid publisher')
      }
    })
    f.setStatus(occupancy)
    expect(await f.owner.get()).toMatchObject({
      kind: 'website',
      requiresQuitAndReleaseOccupancy: true
    })
  })
  it.each([
    { detail: 'operation-pending' },
    { detail: 'occupancy-unknown' },
    { detail: 'save-failed' },
    { detail: 'controller-held' },
    { installation: 'pending' },
    { installation: 'unknown' },
    { phase: 'stopping' },
    { phase: 'handoff' },
    { runtime: 'unknown' }
  ] as Partial<NonNullable<UpdateStatus['recovery']>>[])(
    'does not broaden the exception to unsafe recovery fields: %j',
    async (recovery) => {
      const f = await fixture({ inspectManualInstallSafety: async () => 'quit-required' })
      f.setStatus({ ...occupancy, recovery: { ...occupancy.recovery!, ...recovery } })
      expect((await f.owner.revealInstaller()).kind).toBe('blocked')
      expect(f.reveal).not.toHaveBeenCalled()
    }
  )
  it('rejects an old qualification and in-flight signature when native handoff starts', async () => {
    let release!: () => void
    const signature = vi.fn().mockResolvedValue(undefined)
    const f = await fixture({
      inspectManualInstallSafety: async () => 'quit-required',
      verifyManualInstallerSignature: signature
    })
    f.setStatus(occupancy)
    const offer = await f.owner.get()
    expect(f.owner.isCurrent(offer)).toBe(true)
    signature.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
    const pending = f.owner.revealInstaller()
    await vi.waitFor(() => expect(signature).toHaveBeenCalledTimes(2))
    await f.owner.beforeHandoff('native-operation')
    expect(f.owner.isCurrent(offer)).toBe(false)
    release()
    expect((await pending).kind).toBe('blocked')
    expect(f.reveal).not.toHaveBeenCalled()
    // A stale other-runtime UI snapshot cannot override a durable pending attempt on restart.
    expect((await f.create().get()).kind).toBe('blocked')
  })
  it('rechecks live safety after signature verification and invalidates old lifecycle offers', async () => {
    const safety = vi.fn().mockResolvedValueOnce('quit-required').mockResolvedValue(false)
    const f = await fixture({ inspectManualInstallSafety: safety })
    f.setStatus(occupancy)
    expect((await f.owner.revealInstaller()).kind).toBe('blocked')
    expect(f.signature).toHaveBeenCalledOnce()
    expect(f.reveal).not.toHaveBeenCalled()
    safety.mockResolvedValue('quit-required')
    const offer = await f.owner.get()
    expect(f.owner.isCurrent(offer)).toBe(true)
    f.setStatus({ blockedBy: ['agent'] })
    expect(f.owner.isCurrent(offer)).toBe(false)
  })
  it('keeps the normal ready flow free of fallback and only reveals a verified failed install', async () => {
    const f = await fixture()
    expect(f.owner.entry()).toBeUndefined()
    expect(await f.owner.get()).toMatchObject({ kind: 'blocked' })
    f.owner.failed('install')
    expect(await f.owner.get()).toMatchObject({
      kind: 'local',
      version: '2.0.0',
      fileName: expect.any(String)
    })
    expect(f.signature).toHaveBeenCalledTimes(1)
    expect(f.reveal).not.toHaveBeenCalled()
    await f.owner.revealInstaller()
    expect(f.signature).toHaveBeenCalledTimes(2)
    expect(f.reveal).toHaveBeenCalledExactlyOnceWith(f.path)
  })
  it.each(['delete', 'replace', 'corrupt', 'symlink'] as const)(
    'rechecks %s before reveal and returns the website',
    async (change) => {
      const f = await fixture()
      f.owner.failed('install')
      expect((await f.owner.get()).kind).toBe('local')
      if (change === 'delete') await rm(f.path)
      if (change === 'replace') {
        const replacement = `${f.path}.new`
        await writeFile(replacement, f.bytes)
        await rename(replacement, f.path)
      }
      if (change === 'corrupt') await writeFile(f.path, Buffer.alloc(f.bytes.length, 42))
      if (change === 'symlink') {
        const replacement = `${f.path}.new`
        await writeFile(replacement, f.bytes)
        await rm(f.path)
        await symlink(replacement, f.path)
      }
      expect(await f.owner.revealInstaller()).toMatchObject({
        kind: 'website',
        reason: 'unavailable'
      })
      expect(f.reveal).not.toHaveBeenCalled()
    }
  )
  it('keeps a valid local package and retryable feedback when file manager reveal fails', async () => {
    const f = await fixture({
      revealManualInstallerFile: async () => {
        throw new Error('file manager unavailable')
      }
    })
    f.owner.failed('install')
    expect(await f.owner.revealInstaller()).toMatchObject({ kind: 'local', revealError: true })
    expect((await f.owner.get()).kind).toBe('local')
  })
  it('coalesces checks and reveals and discards a stale signature result after a new release', async () => {
    let release!: () => void
    const verify = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const f = await fixture({ verifyManualInstallerSignature: verify })
    f.owner.failed('install')
    const first = f.owner.get(),
      duplicate = f.owner.get()
    expect(duplicate).toBe(first)
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1))
    f.setStatus({ latest: '3.0.0' })
    f.owner.supersede('3.0.0')
    release()
    expect((await first).kind).toBe('blocked')
    expect(f.publish.mock.calls.at(-1)?.[0]).toBeUndefined()
    const second = await fixture()
    second.owner.failed('install')
    const reveal = second.owner.revealInstaller()
    expect(second.owner.revealInstaller()).toBe(reveal)
    await reveal
    expect(second.reveal).toHaveBeenCalledTimes(1)
  })
  it.each([
    { blockedBy: ['agent'] },
    { reason: 'runtime-stop-timeout' },
    { recovery: { phase: 'stopping', runtime: 'unknown', installation: 'unchanged' } },
    { recovery: { phase: 'handoff', runtime: 'stopped-clean', installation: 'pending' } },
    {
      recovery: {
        phase: 'preparing',
        runtime: 'running',
        installation: 'unchanged',
        detail: 'occupancy-unknown'
      }
    }
  ] as Partial<UpdateStatus>[])(
    'blocks fallback while lifecycle safety is unresolved: %j',
    async (status) => {
      const f = await fixture()
      f.owner.failed('install')
      f.setStatus(status)
      expect(await f.owner.revealInstaller()).toMatchObject({ kind: 'blocked' })
      expect(f.reveal).not.toHaveBeenCalled()
    }
  )
  it('uses live task and occupancy checks for entry and immediately before file reveal', async () => {
    const safety = vi.fn().mockResolvedValue(true)
    const f = await fixture({ inspectManualInstallSafety: safety })
    f.owner.failed('install')
    expect((await f.owner.get()).kind).toBe('local')
    safety.mockResolvedValue(false)
    expect((await f.owner.revealInstaller()).kind).toBe('blocked')
    expect(f.reveal).not.toHaveBeenCalled()
    expect(f.status().manualInstall?.kind).toBe('blocked')
  })
  it('offers the full download for transfer errors and updater-dependent artifacts', async () => {
    const f = await fixture()
    f.owner.failed('download')
    expect(await f.owner.get()).toMatchObject({ kind: 'website', reason: 'download-failed' })
    await f.owner.capture({ ...f.input, standalone: false, format: undefined })
    f.owner.failed('install')
    expect(await f.owner.get()).toMatchObject({ kind: 'website', reason: 'not-standalone' })
    expect(f.signature).not.toHaveBeenCalled()
  })
  it('rechecks publisher signatures and refuses a now-invalid channel signature', async () => {
    const signature = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('publisher changed'))
    const f = await fixture({ verifyManualInstallerSignature: signature })
    f.owner.failed('install')
    expect((await f.owner.get()).kind).toBe('local')
    expect(await f.owner.revealInstaller()).toMatchObject({
      kind: 'website',
      reason: 'unavailable'
    })
    expect(f.reveal).not.toHaveBeenCalled()
  })
  it('durably binds handoff to artifact identity and never treats unchanged version or recovery clicks as failure proof', async () => {
    const observe = vi.fn(async () => {})
    const f = await fixture({ observeManualInstallHandoff: observe })
    await f.owner.beforeHandoff()
    const persisted = JSON.parse(await readFile(f.store, 'utf8'))
    expect(persisted.attempt).toMatchObject({
      state: 'pending',
      identity: persisted.artifact.identity
    })
    expect(observe).toHaveBeenCalledTimes(1)
    const restarted = f.create()
    f.setStatus(restarted.restoredStatus()!)
    restarted.recovered()
    expect(await restarted.confirmAttemptSettled()).toBe(false)
    expect(await restarted.get()).toMatchObject({ kind: 'blocked' })
    expect(f.status().recovery?.installation).toBe('pending')
  })
  it('restores the retained package after explicit completed native failure evidence', async () => {
    const recovery = vi.fn().mockResolvedValue('pending')
    const f = await fixture({ manualInstallRecovery: recovery })
    await f.owner.beforeHandoff()
    const restarted = f.create()
    f.setStatus(restarted.restoredStatus()!)
    expect(await restarted.confirmAttemptSettled()).toBe(false)
    recovery.mockResolvedValue('failed')
    expect(await restarted.confirmAttemptSettled()).toBe(true)
    expect(f.status().recovery).toBeUndefined()
    expect(await restarted.get()).toMatchObject({ kind: 'local' })
    expect(JSON.parse(await readFile(f.store, 'utf8')).attempt.state).toBe('failed')
  })
  it('drops the stale artifact attempt once the target version is running', async () => {
    const f = await fixture()
    await f.owner.beforeHandoff()
    const current = new ManualInstallerFallback(
      'linux',
      'x64',
      '2.0.0',
      { manualInstallStorePath: f.store },
      f.status,
      f.publish
    )
    expect(current.restoredStatus()).toBeUndefined()
    expect(JSON.parse(await readFile(f.store, 'utf8')).artifact).toBeUndefined()
  })
})

describe('first-party independently installable channel contract', () => {
  it('accepts a reconstructed complete NSIS setup but refuses private web-installer packages', () => {
    const source = 'aipoch-open-science-2.0.0-win-x64-setup.exe'
    expect(manualInstallerFormat(source, 'win32', 'x64', '2.0.0', 'electron')).toBe('nsis')
    expect(manualInstallerFormat(source, 'win32', 'x64', '2.0.0', 'electron', true)).toBeUndefined()
    expect(manualInstallerFormat('patch.exe', 'win32', 'x64', '2.0.0', 'electron')).toBeUndefined()
    expect(manualInstallerFormat(source, 'win32', 'arm64', '2.0.0', 'electron')).toBeUndefined()
  })
  it('uses the actual first-party ZIP, DMG, AppImage and DEB naming contracts', () => {
    expect(
      manualInstallerFormat(
        'aipoch-open-science-2.0.0-mac-arm64.zip',
        'darwin',
        'arm64',
        '2.0.0',
        'electron'
      )
    ).toBe('zip')
    expect(
      manualInstallerFormat(
        'aipoch-open-science-2.0.0-mac-arm64.dmg',
        'darwin',
        'arm64',
        '2.0.0',
        'manifest'
      )
    ).toBe('dmg')
    expect(
      manualInstallerFormat(
        'aipoch-open-science-2.0.0-linux-x64.AppImage',
        'linux',
        'x64',
        '2.0.0',
        'electron'
      )
    ).toBe('appimage')
    expect(
      manualInstallerFormat(
        'aipoch-open-science_2.0.0_amd64.deb',
        'linux',
        'x64',
        '2.0.0',
        'electron'
      )
    ).toBe('deb')
    expect(
      manualInstallerFormat(
        'aipoch-open-science-2.0.0-mac-arm64-updater-only.zip',
        'darwin',
        'arm64',
        '2.0.0',
        'electron'
      )
    ).toBeUndefined()
  })
})

it('does not return a stale verified artifact when a file-manager action settles after a new release', async () => {
  let finish!: () => void
  const reveal = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  const f = await fixture({ revealManualInstallerFile: reveal })
  f.owner.failed('install')
  const pending = f.owner.revealInstaller()
  await vi.waitFor(() => expect(reveal).toHaveBeenCalledOnce())
  f.setStatus({ latest: '3.0.0' })
  f.owner.supersede('3.0.0')
  finish()
  expect((await pending).kind).toBe('blocked')
})

it('refuses artifact supersession and recapture while the exact native handoff is unresolved', async () => {
  const f = await fixture()
  await f.owner.beforeHandoff()
  const receipt = await readFile(f.store, 'utf8')
  f.owner.supersede('3.0.0')
  await expect(f.owner.capture({ ...f.input, version: '3.0.0' })).rejects.toThrow('unresolved')
  expect(await readFile(f.store, 'utf8')).toBe(receipt)
  expect(f.owner.hasPendingAttempt()).toBe(true)
})

it('retires an unresolved older target when a newer version was installed separately', async () => {
  const f = await fixture()
  await f.owner.beforeHandoff()
  const current = new ManualInstallerFallback(
    'linux',
    'x64',
    '2.1.0',
    { manualInstallStorePath: f.store },
    f.status,
    f.publish
  )
  expect(current.restoredStatus()).toBeUndefined()
  expect(current.hasPendingAttempt()).toBe(false)
  expect(JSON.parse(await readFile(f.store, 'utf8')).artifact).toBeUndefined()
})
