import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { UpdateStatus } from '../../shared/update'
import {
  confirmInstaller,
  inspectConfirmedInstaller,
  inspectInstallerFile,
  installerFormat,
  withoutMissingInstaller
} from './current-installer'

const directories: string[] = []
const makeDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'current-update-installer-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('current completed installer identity', () => {
  it.each([
    ['darwin', 'app.zip', 'zip'],
    ['darwin', 'app.dmg', 'dmg'],
    ['win32', 'setup.EXE', 'exe'],
    ['linux', 'app.deb', 'deb'],
    ['linux', 'app.AppImage', 'appimage'],
    ['linux', 'app.zip', 'unknown'],
    ['darwin', 'app.deb', 'unknown'],
    ['win32', 'app.dmg', 'unknown'],
    ['linux', 'app.tar.gz', 'unknown']
  ] as const)('describes %s %s as %s', (platform, fileName, format) => {
    expect(installerFormat(fileName, platform)).toBe(format)
  })

  it('never accepts a relative path, directory, or symlink as a completed file', async () => {
    const directory = await makeDirectory()
    const file = join(directory, 'app.deb')
    const link = join(directory, 'linked.deb')
    await writeFile(file, 'complete')
    await symlink(file, link)
    expect(await inspectInstallerFile('app.deb')).toBeNull()
    expect(await inspectInstallerFile(directory)).toBeNull()
    expect(await inspectInstallerFile(link)).toBeNull()
    expect(await inspectInstallerFile(file)).toMatchObject({ size: 8 })
  })

  it.each(['deleted', 'replaced', 'symlink', 'parent-symlink'])(
    'rejects a confirmed file that is later %s',
    async (change) => {
      const directory = await makeDirectory()
      const folder = join(directory, 'pending')
      await mkdir(folder)
      const path = join(folder, 'app.deb')
      await writeFile(path, 'complete')
      const status: UpdateStatus = {
        current: '1.0.0',
        latest: '1.1.0',
        state: 'ready',
        localPath: path
      }
      const artifact = confirmInstaller(status, 'linux', inspectInstallerFile)!
      await artifact.file
      if (change === 'parent-symlink') {
        const moved = join(directory, 'old-pending')
        const replacement = join(directory, 'new-pending')
        await rename(folder, moved)
        await mkdir(replacement)
        await writeFile(join(replacement, 'app.deb'), 'complete')
        await symlink(replacement, folder)
      } else {
        await rm(path)
        if (change === 'replaced') await writeFile(path, 'complete')
        if (change === 'symlink') {
          const other = join(directory, 'other.deb')
          await writeFile(other, 'complete')
          await symlink(other, path)
        }
      }
      expect(await inspectConfirmedInstaller(artifact, inspectInstallerFile, () => true)).toEqual({
        kind: 'missing'
      })
    }
  )

  it('drops an asynchronous missing-file result after the artifact is superseded', async () => {
    const directory = await makeDirectory()
    const path = join(directory, 'app.deb')
    await writeFile(path, 'complete')
    const status: UpdateStatus = {
      current: '1.0.0',
      latest: '1.1.0',
      state: 'ready',
      localPath: path
    }
    const artifact = confirmInstaller(status, 'linux', inspectInstallerFile)!
    await artifact.file
    let finish!: () => void
    const pending = new Promise<null>((resolve) => {
      finish = () => resolve(null)
    })
    let current = true
    const inspection = inspectConfirmedInstaller(
      artifact,
      () => pending,
      () => current
    )
    current = false
    finish()
    expect(await inspection).toEqual({ kind: 'unavailable' })
  })

  it('removes missing-file installation facts while preserving recovery restrictions', () => {
    const status: UpdateStatus = {
      current: '1.0.0',
      latest: '1.1.0',
      state: 'ready',
      localPath: '/cache/app.deb',
      artifactSha512: 'hash',
      recovery: {
        phase: 'handoff',
        runtime: 'unknown',
        installation: 'unknown',
        canCancel: false,
        canRetryInstall: true,
        canRecover: false
      }
    }
    const missing = withoutMissingInstaller(status)
    expect(missing).not.toHaveProperty('localPath')
    expect(missing).not.toHaveProperty('artifactSha512')
    expect(missing).toMatchObject({
      state: 'ready',
      recovery: { ...status.recovery, canRetryInstall: false }
    })
    expect(withoutMissingInstaller({ ...status, recovery: undefined })).toMatchObject({
      state: 'available'
    })
  })

  it('offers redownload after safe preflight refusal while retaining the original error', () => {
    const status: UpdateStatus = {
      current: '1.0.0',
      latest: '1.1.0',
      state: 'ready',
      localPath: '/cache/app.deb',
      reason: 'install-failed',
      error: 'Saving work failed',
      recovery: {
        phase: 'preparing',
        runtime: 'running',
        installation: 'unchanged',
        canCancel: true,
        canRecover: false,
        canRetryInstall: true
      }
    }
    const missing = withoutMissingInstaller(status)
    expect(missing).toMatchObject({
      state: 'available',
      installerMissing: true,
      error: 'Saving work failed'
    })
    expect(missing).not.toHaveProperty('recovery')
    expect(missing).not.toHaveProperty('reason')
    for (const restricted of [
      { ...status.recovery!, operationId: 'pending-operation' },
      { ...status.recovery!, detail: 'operation-pending' as const },
      { ...status.recovery!, canRecover: true },
      { ...status.recovery!, phase: 'recovering' as const }
    ])
      expect(withoutMissingInstaller({ ...status, recovery: restricted })).toMatchObject({
        state: 'ready',
        installerMissing: true,
        recovery: { ...restricted, canRetryInstall: false },
        error: 'Saving work failed'
      })
  })
})
