import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManualInstallerArtifact } from './manual-install'

const mocks = vi.hoisted(() => ({
  boot: vi.fn(),
  capture: vi.fn(),
  verify: vi.fn()
}))
vi.mock('../system-boot-identity', async (original) => ({
  ...(await original<typeof import('../system-boot-identity')>()),
  prefetchSystemBootIdentity: mocks.boot
}))
vi.mock('./installation-protection', () => ({
  captureInstallationManifestAsync: mocks.capture,
  verifyInstallationManifestAsync: mocks.verify
}))
import {
  createNativeInstallObservation,
  nativeInstallSettled,
  WINDOWS_INSTALL_OBSERVER
} from './native-install-observation'

const boot = 'darwin-boot:11111111-1111-4111-8111-111111111111'
const reboot = 'darwin-boot:22222222-2222-4222-8222-222222222222'
const artifact: ManualInstallerArtifact = {
  identity: 'artifact-identity',
  platform: 'darwin',
  arch: 'arm64',
  version: '2.0.0',
  path: '/owned/update.zip',
  source: 'https://example.test/update.zip',
  size: 42,
  algorithm: 'sha512',
  checksum: 'checksum',
  format: 'zip',
  standalone: true,
  device: 1,
  inode: 2,
  modified: 3
}

describe('native installation observation', () => {
  let directory: string
  let path: string
  const inspectOccupancy = vi.fn(async () => undefined)
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'native-update-observation-'))
    path = join(directory, 'receipt.json')
    mocks.boot.mockReset().mockResolvedValue(boot)
    mocks.capture
      .mockReset()
      .mockResolvedValue({ version: '1.0.0', files: { app: 'original-hash' } })
    mocks.verify.mockReset().mockResolvedValue(true)
    inspectOccupancy.mockReset().mockResolvedValue(undefined)
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  const owner = (): ReturnType<typeof createNativeInstallObservation> =>
    createNativeInstallObservation({
      path,
      installationRoot: '/owned/application',
      currentVersion: '1.0.0',
      inspectOccupancy
    })
  const read = async (): Promise<Parameters<typeof nativeInstallSettled>[0]> =>
    JSON.parse(await readFile(path, 'utf8'))
  const update = async (patch: object): Promise<void> =>
    writeFile(path, JSON.stringify({ ...(await read()), ...patch }))

  it.skipIf(process.platform !== 'win32')(
    'publishes readiness and a real process exit through Windows PowerShell',
    async () => {
      const operation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      await owner().observeManualInstallHandoff!(artifact, operation)
      const observer = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(WINDOWS_INSTALL_OBSERVER, 'utf16le').toString('base64')
        ],
        {
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
          env: {
            ...process.env,
            OPEN_SCIENCE_INSTALL_OBSERVATION: path,
            OPEN_SCIENCE_INSTALL_OBSERVATION_ID: operation,
            OPEN_SCIENCE_INSTALL_OBSERVATION_TARGET: process.execPath
          }
        }
      )
      let stderr = ''
      let launchError: Error | undefined
      observer.stderr?.on('data', (bytes) => {
        stderr += String(bytes)
      })
      observer.on('error', (error) => {
        launchError = error
      })
      let helper: ReturnType<typeof spawn> | undefined
      const waitForState = async (state: string): Promise<Awaited<ReturnType<typeof read>>> => {
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const record = await read()
          if (record.state === state) return record
          if (launchError) throw launchError
          if (observer.exitCode !== null)
            throw new Error(`Observer exited before ${state}: ${stderr}`)
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        throw new Error(`Observer did not publish ${state}: ${stderr}`)
      }
      try {
        await waitForState('watching')
        helper = spawn(
          process.execPath,
          [
            '-e',
            'setTimeout(() => process.exit(17), 1500)',
            '--',
            `--open-science-update-operation=${operation}`
          ],
          { windowsHide: true, stdio: 'ignore' }
        )
        const record = await waitForState('exited')
        expect(record).toMatchObject({ attempt: operation, installerPid: helper.pid, exitCode: 17 })
      } finally {
        // Only exact child handles owned by this test; no installed application is touched.
        helper?.kill()
        observer.kill()
      }
    },
    25_000
  )

  it('persists the bound original installation before handoff without claiming success', async () => {
    await owner().observeManualInstallHandoff!(artifact)
    expect(await read()).toMatchObject({
      schema: 1,
      boot,
      state: 'prepared',
      installationRoot: '/owned/application',
      original: { version: '1.0.0', files: { app: 'original-hash' } }
    })
    expect(await owner().manualInstallRecovery!(artifact)).toBe('pending')
    expect(mocks.verify).not.toHaveBeenCalled()
  })
  it('binds settlement to the same Windows handoff operation', async () => {
    const operation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    await owner().observeManualInstallHandoff!(artifact, operation)
    expect((await read()).attempt).toBe(operation)
    await update({ state: 'exited', installerPid: 123, exitCode: 1603 })
    expect(
      await owner().manualInstallRecovery!(artifact, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
    ).toBe('pending')
    expect(inspectOccupancy).not.toHaveBeenCalled()
    expect(await owner().manualInstallRecovery!(artifact, operation)).toBe('failed')
  })
  it.each(['prepared', 'watching', 'unknown'])(
    'does not mistake %s or unchanged version for failure',
    async (state) => {
      await owner().observeManualInstallHandoff!(artifact)
      await update({ state, installerPid: 123, exitCode: 1 })
      expect(await owner().manualInstallRecovery!(artifact)).toBe('pending')
    }
  )
  it('requires actual nonzero process exit, verified original bytes and two occupancy checks', async () => {
    await owner().observeManualInstallHandoff!(artifact)
    await update({ state: 'exited', installerPid: 123, exitCode: 1603 })
    expect(await owner().manualInstallRecovery!(artifact)).toBe('failed')
    expect(inspectOccupancy).toHaveBeenCalledTimes(2)
    expect(mocks.verify).toHaveBeenCalledWith('/owned/application', {
      version: '1.0.0',
      files: { app: 'original-hash' }
    })
  })
  it('keeps zero exit, partial replacement, occupied installation and missing receipt unknown', async () => {
    await owner().observeManualInstallHandoff!(artifact)
    await update({ state: 'exited', installerPid: 123, exitCode: 0 })
    expect(await owner().manualInstallRecovery!(artifact)).toBe('pending')
    await update({ exitCode: 1 })
    mocks.verify.mockResolvedValue(false)
    expect(await owner().manualInstallRecovery!(artifact)).toBe('pending')
    mocks.verify.mockResolvedValue(true)
    inspectOccupancy.mockRejectedValue(new Error('occupied'))
    expect(await owner().manualInstallRecovery!(artifact)).toBe('pending')
    await rm(path)
    expect(await owner().manualInstallRecovery!(artifact)).toBe('pending')
  })
  it('can recover unknown native outcomes only after kernel reboot and full original-byte verification', async () => {
    await owner().observeManualInstallHandoff!(artifact)
    mocks.boot.mockResolvedValue(reboot)
    expect(await owner().manualInstallRecovery!(artifact)).toBe('failed')
    mocks.verify.mockResolvedValue(false)
    expect(await owner().manualInstallRecovery!(artifact)).toBe('pending')
  })
  it('rejects another artifact and a receipt superseded during verification', async () => {
    await owner().observeManualInstallHandoff!(artifact)
    mocks.boot.mockResolvedValue(reboot)
    expect(await owner().manualInstallRecovery!({ ...artifact, identity: 'new-artifact' })).toBe(
      'pending'
    )
    mocks.verify.mockImplementationOnce(async () => {
      await update({ attempt: 'new-attempt' })
      return true
    })
    expect(await owner().manualInstallRecovery!(artifact)).toBe('pending')
  })
  it('never accepts a malformed boot or exit identity as settled', async () => {
    await owner().observeManualInstallHandoff!(artifact)
    const record = await read()
    expect(nativeInstallSettled({ ...record, boot: 'unknown' }, reboot)).toBe(false)
    expect(
      nativeInstallSettled({ ...record, state: 'exited', installerPid: 0, exitCode: 1 }, boot)
    ).toBe(false)
    expect(
      nativeInstallSettled({ ...record, state: 'exited', installerPid: 123, exitCode: -1 }, boot)
    ).toBe(false)
  })
})
