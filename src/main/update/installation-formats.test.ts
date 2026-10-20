import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  prepareSupervisedAppImageInstallation,
  discardPreparedInstallation
} from './installation-executor'
import { tmpdir } from 'node:os'
const command = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('./verification-process', () => ({
  runVerificationProcess: command.run,
  verificationDirectoryIsSettled: () => true
}))
import { inspectDebUpdateArtifact, inspectAppImageUpdateArtifact } from './installation-artifact'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
beforeEach(() => {
  command.run.mockReset()
})
async function application(root: string): Promise<void> {
  await mkdir(join(root, 'resources/app'), { recursive: true })
  await writeFile(join(root, 'resources/app/package.json'), JSON.stringify({ version: '2.0.0' }))
  await writeFile(join(root, 'open-science.exe'), 'application payload')
}
describe('format extraction contracts', () => {
  it('hashes Debian application payload only after package and embedded version agree', async () => {
    command.run.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === '--field') return { stdout: '2.0.0\n', stderr: '' }
      await application(join(args[2], 'opt/Open-Science'))
      return { stdout: '', stderr: '' }
    })
    const manifest = await inspectDebUpdateArtifact(
      '/verified/update.deb',
      '2.0.0',
      '/opt/Open-Science'
    )
    expect(manifest.files['open-science.exe']).toMatch(/^[a-f\d]{64}$/)
    expect(command.run.mock.calls[0][0]).toBe('dpkg-deb')
    command.run.mockResolvedValueOnce({ stdout: '1.0.0', stderr: '' })
    await expect(
      inspectDebUpdateArtifact('/verified/update.deb', '2.0.0', '/opt/Open-Science')
    ).rejects.toThrow('package version')
  })
  it('hashes the entire stable-name AppImage and rejects unsafe identity renaming', async () => {
    const root = await mkdtemp(join(tmpdir(), 'appimage-fixture-'))
    roots.push(root)
    const installed = join(root, 'Open-Science.AppImage'),
      archive = join(root, 'new.AppImage')
    await writeFile(installed, 'old image')
    await writeFile(archive, 'verified new image')
    command.run.mockImplementation(
      async (_command: string, _args: string[], options: { cwd: string }) => {
        await application(join(options.cwd, 'squashfs-root'))
        return { stdout: '', stderr: '' }
      }
    )
    const manifest = await inspectAppImageUpdateArtifact(archive, '2.0.0', installed)
    expect(Object.keys(manifest.files)).toEqual(['@image'])
    const versioned = join(root, 'Open-Science-1.0.0.AppImage')
    await writeFile(versioned, 'old')
    await expect(inspectAppImageUpdateArtifact(archive, '2.0.0', versioned)).rejects.toThrow(
      'stable application filename'
    )
  })
})

it('prepares a stable AppImage outside replacement and cleans only unaccepted staging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'appimage-prepare-'))
  roots.push(root)
  const installed = join(root, 'Open-Science.AppImage'),
    archive = join(root, 'new.AppImage')
  await writeFile(installed, 'old')
  await writeFile(archive, 'downloaded image')
  command.run.mockImplementation(
    async (_command: string, args: string[], options: { cwd: string }) => {
      if (args.includes('--appimage-extract')) await application(join(options.cwd, 'squashfs-root'))
      return { stdout: '', stderr: '' }
    }
  )
  const prepared = await prepareSupervisedAppImageInstallation({
    installationRoot: installed,
    stateRoot: join(root, 'state'),
    archive,
    targetVersion: '2.0.0',
    sha512: createHash('sha512').update('downloaded image').digest('base64'),
    runtimeNode: process.execPath
  })
  expect(await readFile(prepared.stagedBundle, 'utf8')).toBe('downloaded image')
  expect(prepared.channel).toBe('supervised-appimage')
  await writeFile(join(prepared.directory, 'request.json'), 'accepted')
  await expect(discardPreparedInstallation(prepared)).rejects.toThrow('cannot be discarded')
  await access(prepared.stagedBundle)
  await rm(join(prepared.directory, 'request.json'))
  await discardPreparedInstallation(prepared)
  await expect(access(prepared.stagedBundle)).rejects.toThrow()
  expect(await readFile(installed, 'utf8')).toBe('old')
})
