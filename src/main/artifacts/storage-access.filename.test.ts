import { beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const filesystem = vi.hoisted(() => ({ readdir: vi.fn(), lstat: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readdir: filesystem.readdir,
  lstat: filesystem.lstat
}))
import { ArtifactStorageAccess } from './storage-access'

const directory = join('storage', 'pending')
const access = new ArtifactStorageAccess('storage', {
  syncFile: async () => undefined,
  syncDirectory: async () => undefined
})
const filename = '研'.repeat(30) + '.MD'
beforeEach(() => vi.resetAllMocks())

it('keeps both physical names on a case-sensitive volume', async () => {
  filesystem.readdir.mockResolvedValue([filename, filename.toLowerCase()])
  filesystem.lstat.mockImplementation(async (path: string) => {
    if (path === join(directory, filename)) return { isFile: () => true }
    throw Object.assign(new Error('not found'), { code: 'ENOENT' })
  })
  expect(await access.resolveArtifactFilename(directory, filename)).toBe(filename)
  expect(await access.resolveArtifactFilename(directory, filename.toLowerCase())).toBe(
    filename.toLowerCase()
  )
})

it('does not alias a new case-distinct file merely because its name folds equally', async () => {
  filesystem.readdir.mockResolvedValue([filename])
  filesystem.lstat.mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }))
  expect(await access.resolveArtifactFilename(directory, filename.toLowerCase())).toBe(
    filename.toLowerCase()
  )
})

it('uses exact bigint inode identity to disambiguate folded directory entries', async () => {
  const first = '研'.repeat(30) + 'Straße.MD'
  const second = '研'.repeat(30) + 'STRASSE.md'
  const requested = '研'.repeat(30) + 'strasse.md'
  filesystem.readdir.mockResolvedValue([first, second])
  // Adjacent inode numbers beyond Number precision must not be considered equal.
  filesystem.lstat.mockImplementation(async (path: string) => ({
    isFile: () => true,
    dev: 1n,
    ino: path === join(directory, first) ? 9007199254740992n : 9007199254740993n
  }))
  expect(await access.resolveArtifactFilename(directory, requested)).toBe(second)
})

it('does not follow a symlink alias to its target filename', async () => {
  filesystem.readdir.mockResolvedValue([filename])
  filesystem.lstat.mockResolvedValue({ isFile: () => false })
  expect(await access.resolveArtifactFilename(directory, filename.toLowerCase())).toBe(
    filename.toLowerCase()
  )
})

it('rejects an exact symlink entry instead of accepting it as an artifact file', async () => {
  filesystem.readdir.mockResolvedValue([filename])
  filesystem.lstat.mockResolvedValue({ isFile: () => false })
  await expect(access.resolveArtifactFilename(directory, filename)).rejects.toThrow(
    'Artifact filename alias is unsupported.'
  )
})

it('propagates permission errors instead of creating a different metadata identity', async () => {
  const error = Object.assign(new Error('access denied'), { code: 'EACCES' })
  filesystem.readdir.mockRejectedValue(error)
  await expect(access.resolveArtifactFilename(directory, filename)).rejects.toBe(error)
})

it('rejects an existing native alias that cannot share the folded filename identity', async () => {
  filesystem.readdir.mockResolvedValue(['Long report filename.md'])
  filesystem.lstat.mockResolvedValue({ isFile: () => true, dev: 1n, ino: 2n })
  await expect(access.resolveArtifactFilename(directory, 'LONGRE~1.MD')).rejects.toThrow(
    'Artifact filename alias is unsupported.'
  )
})
