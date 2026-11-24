import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'

import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import { isLocalPathRoot } from '../../shared/local-fs'
import { canonicalizeDirectory } from '../local-fs/directory-validation'
import type { ManagedWorkspacePath, ProjectFolderPath } from '../storage/workspace-location'
import {
  validateProjectFolder,
  type ProjectFolderValidationOptions
} from './project-folder-validation'

let root: string
let options: ProjectFolderValidationOptions
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'project-folder-validation-')))
  options = {
    homePath: join(root, 'home'),
    dataRoot: join(root, 'app', 'data'),
    configRoot: join(root, 'settings', 'config'),
    preflight: vi.fn().mockResolvedValue(undefined)
  }
  await Promise.all([
    mkdir(options.homePath!, { recursive: true }),
    mkdir(join(options.dataRoot!, 'child'), { recursive: true }),
    mkdir(join(options.configRoot!, 'child'), { recursive: true })
  ])
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('Project folder validation', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'requires permission to traverse a readable and writable project directory',
    async () => {
      const folder = join(root, 'unsearchable')
      await mkdir(folder, { mode: 0o600 })
      try {
        await expect(validateProjectFolder(folder, options)).rejects.toMatchObject({
          code: 'EACCES'
        })
      } finally {
        await chmod(folder, 0o700)
      }
    }
  )

  it('accepts canonical directories containing spaces and CJK characters', async () => {
    const folder = join(root, '研究 결과 データ with spaces ')
    await mkdir(folder)
    await expect(validateProjectFolder(folder, options)).resolves.toBe(await realpath(folder))
    expect(options.preflight).toHaveBeenCalledWith(await realpath(folder), 'rw', folder, 'tree')
    expectTypeOf<ProjectFolderPath>().not.toExtend<ManagedWorkspacePath>()
    expectTypeOf<ManagedWorkspacePath>().not.toExtend<ProjectFolderPath>()
  })

  it('rejects relative, missing and non-directory paths', async () => {
    await expect(validateProjectFolder('relative/path', options)).rejects.toMatchObject({
      reason: 'not-absolute'
    })
    await expect(validateProjectFolder(join(root, 'missing'), options)).rejects.toMatchObject({
      reason: 'not-found'
    })
    const file = join(root, 'file.csv')
    await writeFile(file, 'a,b\n1,2\n')
    await expect(validateProjectFolder(file, options)).rejects.toMatchObject({
      reason: 'not-directory'
    })
    expect(options.preflight).not.toHaveBeenCalled()
  })

  it('rejects root, home, and both application roots and their ancestors and descendants', async () => {
    await expect(validateProjectFolder(parse(root).root, options)).rejects.toMatchObject({
      reason: 'is-root'
    })
    await expect(validateProjectFolder(options.homePath!, options)).rejects.toMatchObject({
      reason: 'is-home'
    })
    for (const path of [
      root,
      options.dataRoot!,
      dirname(options.dataRoot!),
      join(options.dataRoot!, 'child'),
      options.configRoot!,
      dirname(options.configRoot!),
      join(options.configRoot!, 'child')
    ]) {
      await expect(validateProjectFolder(path, options)).rejects.toMatchObject({
        reason: 'app-storage-overlap'
      })
    }
    expect(options.preflight).not.toHaveBeenCalled()
  })

  it('resolves symlink/junction aliases before checking forbidden locations', async () => {
    const alias = join(root, 'alias')
    await symlink(options.dataRoot!, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(validateProjectFolder(alias, options)).rejects.toMatchObject({
      reason: 'app-storage-overlap'
    })
    const homeAlias = join(root, 'home-alias')
    await symlink(options.homePath!, homeAlias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(validateProjectFolder(homeAlias, options)).rejects.toMatchObject({
      reason: 'is-home'
    })
  })

  it('uses actual filesystem case semantics rather than lowercasing names', async () => {
    const distinct = join(root, 'app', 'DATA')
    await mkdir(distinct, { recursive: true })
    const same =
      (await realpath(distinct)) === (await realpath(options.dataRoot!)) ||
      (process.platform !== 'win32' &&
        (await stat(distinct)).ino === (await stat(options.dataRoot!)).ino)
    if (same) {
      await expect(validateProjectFolder(distinct, options)).rejects.toMatchObject({
        reason: 'app-storage-overlap'
      })
    } else {
      await expect(validateProjectFolder(distinct, options)).resolves.toBe(await realpath(distinct))
    }
  })

  it('does not confuse a similarly prefixed sibling with an application directory', async () => {
    const folder = `${options.dataRoot}-research`
    await mkdir(folder)
    await expect(validateProjectFolder(folder, options)).resolves.toBe(await realpath(folder))
  })

  it('protects application roots before they have been created', async () => {
    options.dataRoot = join(root, 'future', 'data')
    options.configRoot = join(root, 'future-config', 'config')
    await expect(validateProjectFolder(root, options)).rejects.toMatchObject({
      reason: 'app-storage-overlap'
    })
    const folder = join(root, 'research')
    await mkdir(folder)
    await expect(validateProjectFolder(folder, options)).resolves.toBe(await realpath(folder))
  })

  it('runs the Folder access execution preflight and propagates capability rejection', async () => {
    const folder = join(root, 'research')
    await mkdir(folder)
    const failure = new Error('Execution mode does not support this volume')
    options.preflight = vi.fn().mockRejectedValue(failure)
    await expect(validateProjectFolder(folder, options)).rejects.toBe(failure)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'rejects directories without read/write access',
    async () => {
      const folder = join(root, 'read-only')
      await mkdir(folder)
      await chmod(folder, 0o500)
      try {
        await expect(canonicalizeDirectory(folder)).rejects.toMatchObject({
          reason: 'not-writable'
        })
      } finally {
        await chmod(folder, 0o700)
      }
    }
  )

  it.each([
    ['/', 'linux'],
    ['C:\\', 'win32'],
    ['c:/', 'win32'],
    ['\\\\server\\share', 'win32'],
    ['\\\\SERVER\\share\\', 'win32']
  ])('shares Folder access root recognition for %s on %s', (path, platform) => {
    expect(isLocalPathRoot(path, platform)).toBe(true)
  })
})
