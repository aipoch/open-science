import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { bindStorageRoot, StorageRootChangedError } from './root-binding'

const roots: string[] = []
const fixture = async (
  parent = tmpdir()
): Promise<{ root: string; physical: string; alias: string }> => {
  const root = await realpath(await mkdtemp(join(parent, 'storage-root-binding-')))
  roots.push(root)
  const physical = join(root, 'physical')
  const alias = join(root, 'selected')
  await mkdir(physical)
  await symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir')
  return { root, physical, alias }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each(['absolute', 'relative'])('preserves native link/.. meaning in a %s root', async (kind) => {
  const { root, physical, alias } = await fixture(kind === 'relative' ? process.cwd() : tmpdir())
  await mkdir(join(physical, 'child'))
  await mkdir(join(physical, 'research'))
  await mkdir(join(root, 'research'))
  await unlink(alias)
  await symlink(join(physical, 'child'), alias, process.platform === 'win32' ? 'junction' : 'dir')
  // Joining these segments would erase the POSIX meaning of following the link before "..".
  const input = `${kind === 'relative' ? relative(process.cwd(), alias) : alias}/../research`
  const binding = bindStorageRoot(input)
  expect(binding.path).toBe(await realpath(input))
  await expect(binding.verify()).resolves.toBeUndefined()
})

it('creates a missing root under a bound ancestor and never recreates it after removal', async () => {
  const { root, physical, alias } = await fixture()
  const binding = bindStorageRoot(join(alias, 'new', 'data'))
  expect(binding.path).toBe(join(physical, 'new', 'data'))
  await expect(binding.verify()).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(physical)).toEqual([])
  await binding.prepare((path) => mkdir(path))
  await writeFile(join(binding.path, 'content.txt'), 'ordinary child changes are allowed')
  await expect(binding.verify()).resolves.toBeUndefined()

  await rename(binding.path, join(root, 'previous'))
  await expect(binding.prepare((path) => mkdir(path))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readdir(binding.path)).rejects.toMatchObject({ code: 'ENOENT' })
  await mkdir(binding.path)
  await expect(binding.verify()).rejects.toBeInstanceOf(StorageRootChangedError)
})

it.each(['retarget', 'replace', 'insert-link'])(
  'rejects %s before creating a missing root',
  async (change) => {
    const { root, physical, alias } = await fixture()
    const other = join(root, 'other')
    await mkdir(other)
    const binding = bindStorageRoot(join(alias, 'new', 'data'))
    if (change === 'retarget') {
      await unlink(alias)
      await symlink(other, alias, process.platform === 'win32' ? 'junction' : 'dir')
    } else if (change === 'replace') {
      await rename(physical, join(root, 'previous'))
      await mkdir(physical)
    } else {
      await symlink(other, join(physical, 'new'), process.platform === 'win32' ? 'junction' : 'dir')
    }
    await expect(binding.prepare((path) => mkdir(path))).rejects.toBeInstanceOf(
      StorageRootChangedError
    )
    expect(await readdir(other)).toEqual([])
    await expect(readdir(join(physical, 'new', 'data'))).rejects.toMatchObject({ code: 'ENOENT' })
  }
)
