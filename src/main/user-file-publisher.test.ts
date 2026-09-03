import { constants } from 'node:fs'
import {
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { publishUserFile } from './user-file-publisher'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'open-science-user-file-publisher-'))
})

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

describe('publishUserFile', () => {
  it('preserves an existing destination when the writer fails after partial output', async () => {
    const destinationPath = join(root, 'report.txt')
    await writeFile(destinationPath, 'existing bytes')

    await expect(
      publishUserFile(destinationPath, async (temporaryPath) => {
        await writeFile(temporaryPath, 'partial replacement')
        throw new Error('disk full')
      })
    ).rejects.toThrow('disk full')

    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('existing bytes')
    await expect(readdir(root)).resolves.toEqual(['report.txt'])
  })

  it('flushes complete bytes before atomically replacing the destination', async () => {
    const destinationPath = join(root, 'report.txt')
    await writeFile(destinationPath, 'old bytes')
    const events: string[] = []

    await publishUserFile(
      destinationPath,
      async (temporaryPath) => {
        events.push('write')
        await writeFile(temporaryPath, 'new bytes')
      },
      {
        durability: {
          syncFile: vi.fn(async () => {
            events.push('sync-file')
            await expect(readFile(destinationPath, 'utf8')).resolves.toBe('old bytes')
          }),
          syncDirectory: vi.fn(async () => {
            events.push('sync-directory')
            await expect(readFile(destinationPath, 'utf8')).resolves.toBe('new bytes')
          })
        }
      }
    )

    expect(events).toEqual(['write', 'sync-file', 'sync-directory'])
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('new bytes')
  })

  it('does not replace an existing destination during exclusive publication', async () => {
    const destinationPath = join(root, 'report.txt')
    await writeFile(destinationPath, 'existing bytes')

    await expect(
      publishUserFile(destinationPath, (temporaryPath) => writeFile(temporaryPath, 'new bytes'), {
        exclusive: true
      })
    ).rejects.toMatchObject({ code: 'EEXIST' })

    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('existing bytes')
    await expect(readdir(root)).resolves.toEqual(['report.txt'])
  })

  it('publishes exclusively when the destination file system does not support hard links', async () => {
    const destinationPath = join(root, 'report.txt')
    const syncFile = vi.fn().mockResolvedValue(undefined)

    await publishUserFile(
      destinationPath,
      (temporaryPath) => writeFile(temporaryPath, 'new bytes'),
      {
        exclusive: true,
        linkFile: async () => {
          throw Object.assign(new Error('hard links are unsupported'), { code: 'EOPNOTSUPP' })
        },
        publishNoReplace: rename,
        durability: { syncFile, syncDirectory: vi.fn().mockResolvedValue(undefined) }
      }
    )

    expect(syncFile).toHaveBeenCalledTimes(2)
    expect(syncFile.mock.calls[1]?.[0]).toMatch(/\.open-science-publish-/)
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('new bytes')
    await expect(readdir(root)).resolves.toEqual(['report.txt'])
  })

  it('does not replace a destination that appears before the hard-link fallback', async () => {
    const destinationPath = join(root, 'report.txt')

    await expect(
      publishUserFile(destinationPath, (temporaryPath) => writeFile(temporaryPath, 'new bytes'), {
        exclusive: true,
        linkFile: async () => {
          await writeFile(destinationPath, 'racing bytes')
          throw Object.assign(new Error('hard links are unsupported'), { code: 'EOPNOTSUPP' })
        },
        publishNoReplace: async (sourcePath, targetPath) => {
          await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL)
          await rm(sourcePath)
        }
      })
    ).rejects.toMatchObject({ code: 'EEXIST' })

    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('racing bytes')
    await expect(readdir(root)).resolves.toEqual(['report.txt'])
  })

  it('does not expose partial output when the no-hard-link fallback copy fails', async () => {
    const destinationPath = join(root, 'report.txt')

    await expect(
      publishUserFile(destinationPath, (temporaryPath) => writeFile(temporaryPath, 'new bytes'), {
        exclusive: true,
        linkFile: async () => {
          throw Object.assign(new Error('hard links are unsupported'), { code: 'EOPNOTSUPP' })
        },
        copyFileExclusive: async (_sourcePath, targetPath) => {
          await writeFile(targetPath, 'partial bytes')
          throw new Error('disk full')
        }
      })
    ).rejects.toThrow('disk full')

    await expect(readFile(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(root)).resolves.toEqual([])
  })

  it.runIf(process.platform !== 'win32')(
    'preserves existing destination permissions when replacing its bytes',
    async () => {
      const destinationPath = join(root, 'report.txt')
      await writeFile(destinationPath, 'existing bytes')
      await chmod(destinationPath, 0o600)

      await publishUserFile(destinationPath, async (temporaryPath) => {
        await writeFile(temporaryPath, 'new bytes')
        await chmod(temporaryPath, 0o644)
      })

      expect((await stat(destinationPath)).mode & 0o777).toBe(0o600)
    }
  )

  it.runIf(process.platform !== 'win32')(
    'replaces a read-only destination while preserving its permissions',
    async () => {
      const destinationPath = join(root, 'report.txt')
      await writeFile(destinationPath, 'existing bytes')
      await chmod(destinationPath, 0o444)

      await publishUserFile(destinationPath, (temporaryPath) =>
        writeFile(temporaryPath, 'new bytes')
      )

      await expect(readFile(destinationPath, 'utf8')).resolves.toBe('new bytes')
      expect((await stat(destinationPath)).mode & 0o777).toBe(0o444)
    }
  )

  it('retries a transient replacement denial before publishing', async () => {
    const destinationPath = join(root, 'report.txt')
    await writeFile(destinationPath, 'existing bytes')
    const wait = vi.fn().mockResolvedValue(undefined)
    const replace = vi.fn(async (sourcePath: string, targetPath: string) => {
      if (replace.mock.calls.length === 1) {
        throw Object.assign(new Error('replacement denied'), { code: 'EPERM' })
      }
      await rename(sourcePath, targetPath)
    })

    await publishUserFile(
      destinationPath,
      (temporaryPath) => writeFile(temporaryPath, 'new bytes'),
      { replace, wait }
    )

    expect(replace).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledWith(25)
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('new bytes')
  })
})
