import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  promoteWindowsInstallerBasis,
  selectWindowsDesktopVersion
} from './windows-desktop-version'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'desktop-update-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('keeps the original launch until a complete version can be selected and reuses it offline', async () => {
  const versions = join(root, 'resources', '.desktop-updates')
  const candidate = join(versions, '1.1.0')
  const exe = 'open-science.exe'
  await mkdir(join(versions, 'prepare-interrupted', 'payload'), { recursive: true })
  const options = {
    current: '1.0.0',
    executable: join(root, exe),
    mayActivate: vi.fn(async () => true),
    checkOccupancy: vi.fn(async () => {})
  }
  expect(await selectWindowsDesktopVersion(options)).toBeUndefined()
  expect(options.checkOccupancy).not.toHaveBeenCalled()
  await mkdir(join(candidate, 'resources'), { recursive: true })
  await writeFile(join(candidate, exe), 'desktop')
  await writeFile(join(candidate, 'resources', 'app.asar'), 'app')
  await writeFile(
    join(candidate, 'prepared.sha512'),
    createHash('sha512').update('setup').digest('base64')
  )
  options.checkOccupancy.mockRejectedValueOnce(new Error('other profile'))
  expect(await selectWindowsDesktopVersion(options)).toBeUndefined()
  expect(await selectWindowsDesktopVersion(options)).toBe(join(candidate, exe))
  options.mayActivate.mockResolvedValue(false)
  expect(await selectWindowsDesktopVersion(options)).toBe(join(candidate, exe))
  expect(options.checkOccupancy).toHaveBeenCalledTimes(2)
})

it('keeps the installed delta basis until the complete pending installer matches the prepared digest', async () => {
  const pending = join(root, 'pending')
  const basis = join(root, 'installer.exe')
  const expected = createHash('sha512').update('release C').digest('base64')
  await mkdir(pending)
  await writeFile(basis, 'release B')
  await writeFile(
    join(pending, 'update-info.json'),
    JSON.stringify({ sha512: expected, fileName: 'setup.exe' })
  )
  await writeFile(join(pending, 'setup.exe'), 'incomplete')
  await expect(promoteWindowsInstallerBasis(root, expected)).rejects.toThrow('checksum')
  expect(await readFile(basis, 'utf8')).toBe('release B')
  await writeFile(join(pending, 'setup.exe'), 'release C')
  await promoteWindowsInstallerBasis(root, expected)
  expect(await readFile(basis, 'utf8')).toBe('release C')
})
