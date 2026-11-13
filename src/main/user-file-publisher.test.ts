import { constants } from 'node:fs'
import {
  chmod,
  link,
  copyFile,
  mkdir,
  mkdtemp,
  open,
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

import { createFileDurability } from '@aipoch/durable-files'

import {
  configureUserFileRecoveryRoot,
  publishUserFile,
  recoverUserFilePublications
} from './user-file-publisher'
import { snapshotFileTarget } from './file-save-target'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'open-science-user-file-publisher-'))
})

afterEach(async () => {
  configureUserFileRecoveryRoot(undefined)
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

  it('preserves the destination when cancellation occurs between replacement retries', async () => {
    const destinationPath = join(root, 'report.txt')
    await writeFile(destinationPath, 'existing bytes')
    const controller = new AbortController()
    const replace = vi.fn(async () => {
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    })
    await expect(
      publishUserFile(destinationPath, (path) => writeFile(path, 'new bytes'), {
        signal: controller.signal,
        replace,
        wait: async () => {
          controller.abort(new Error('cancelled'))
        }
      })
    ).rejects.toThrow('cancelled')
    expect(replace).toHaveBeenCalledTimes(1)
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

  it.each([true, false])(
    'handles denied parent access with user-selected destination %s',
    async (userSelectedDestination) => {
      const destination = join(root, 'report.txt')
      const error = Object.assign(new Error('directory read denied'), { code: 'EACCES' })
      const durability = createFileDurability({
        openHandle: async (path, flags) => {
          if (path === root) {
            await expect(readFile(destination, 'utf8')).resolves.toBe('complete bytes')
            throw error
          }
          return open(path, flags)
        }
      })
      const result = publishUserFile(destination, (path) => writeFile(path, 'complete bytes'), {
        userSelectedDestination,
        durability
      })
      if (userSelectedDestination) await expect(result).resolves.toBeUndefined()
      else await expect(result).rejects.toBe(error)
      await expect(readdir(root)).resolves.toEqual(['report.txt'])
    }
  )

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

describe('file publication recovery', () => {
  it('restores a displaced file from a persisted receipt and removes stale staging bytes', async () => {
    const destinationPath = join(root, 'report.txt')
    const temporaryDirectory = join(root, '.open-science-save-stale')
    const recoveryRoot = join(root, 'file-recovery')
    await mkdir(recoveryRoot)
    const recoveryDirectory = await mkdtemp(join(recoveryRoot, '.open-science-file-recovery-'))
    await mkdir(temporaryDirectory)
    await writeFile(join(temporaryDirectory, 'report.txt'), 'partial replacement')
    await writeFile(join(recoveryDirectory, 'previous'), 'existing bytes')
    await writeFile(
      join(recoveryDirectory, 'recovery.json'),
      JSON.stringify({
        destinationPath,
        previous: 'previous',
        temporaryDirectory
      })
    )

    await expect(recoverUserFilePublications(recoveryRoot)).resolves.toEqual({
      restored: 1,
      retained: 0,
      removed: 0
    })
    await expect(readFile(destinationPath, 'utf8')).resolves.toBe('existing bytes')
    await expect(stat(temporaryDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(recoveryRoot)).resolves.toEqual([])
  })
})

it.each(['private-file', 'fallback-copy', 'fallback-file'] as const)(
  'does not commit an exclusive file cancelled at the %s barrier',
  async (barrier) => {
    const controller = new AbortController()
    const destination = join(root, 'cancelled.txt')
    const publishNoReplace = vi.fn(rename)
    await expect(
      publishUserFile(destination, (temporary) => writeFile(temporary, 'complete bytes'), {
        exclusive: true,
        signal: controller.signal,
        linkFile: async () => {
          throw Object.assign(new Error('no hard links'), { code: 'ENOTSUP' })
        },
        copyFileExclusive: async (source, target) => {
          await copyFile(source, target, constants.COPYFILE_EXCL)
          if (barrier === 'fallback-copy') controller.abort(new Error('cancel publication'))
        },
        durability: {
          syncFile: async (path) => {
            const fallback = path.includes('.open-science-publish-')
            if (
              (barrier === 'private-file' && !fallback) ||
              (barrier === 'fallback-file' && fallback)
            )
              controller.abort(new Error('cancel publication'))
          },
          syncDirectory: vi.fn()
        },
        publishNoReplace
      })
    ).rejects.toThrow('cancel publication')
    expect(publishNoReplace).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual([])
    await publishUserFile(destination, (temporary) => writeFile(temporary, 'retry bytes'), {
      exclusive: true
    })
    expect(await readFile(destination, 'utf8')).toBe('retry bytes')
  }
)

it('restores the captured original when the caller expires before publication', async () => {
  const destination = join(root, 'confirmed.txt')
  await writeFile(destination, 'original')
  const target = await snapshotFileTarget(destination)
  const controller = new AbortController()
  await expect(
    publishUserFile(destination, (p) => writeFile(p, 'export'), {
      target,
      signal: controller.signal,
      validateDestination: async () => {
        if (!(await stat(destination).catch(() => null)))
          controller.abort(new Error('caller expired'))
      }
    })
  ).rejects.toThrow('caller expired')
  expect(await readFile(destination, 'utf8')).toBe('original')
  expect(await readdir(root)).toEqual(['confirmed.txt'])
})

it('preserves both files and a receipt if a competitor prevents restoration', async () => {
  const destination = join(root, 'confirmed.txt')
  await writeFile(destination, 'original')
  const target = await snapshotFileTarget(destination)
  await expect(
    publishUserFile(destination, (p) => writeFile(p, 'export'), {
      target,
      linkFile: async (source, dest) => {
        await writeFile(dest, 'competitor', { flag: 'wx' })
        await link(source, dest)
      }
    })
  ).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(destination, 'utf8')).toBe('competitor')
  const recovery = (await readdir(root)).find((name) => name.startsWith('.open-science-save-'))!
  const files = await readdir(join(root, recovery), { recursive: true })
  const previous = files.find((name) => name.endsWith('previous'))!
  const receipt = files.find((name) => name.endsWith('recovery.json'))!
  expect(await readFile(join(root, recovery, previous), 'utf8')).toBe('original')
  expect(JSON.parse(await readFile(join(root, recovery, receipt), 'utf8')).target).toEqual(target)
})

it('rechecks caller validity after a fallback copy and before its atomic publication', async () => {
  const destination = join(root, 'fresh.txt')
  let current = true
  await expect(
    publishUserFile(destination, (p) => writeFile(p, 'export'), {
      target: await snapshotFileTarget(destination),
      validateDestination: async () => {
        if (!current) throw new Error('caller expired')
      },
      linkFile: async () => {
        throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' })
      },
      copyFileExclusive: async (source, dest) => {
        await copyFile(source, dest, constants.COPYFILE_EXCL)
        current = false
      }
    })
  ).rejects.toThrow('caller expired')
  expect(await readdir(root)).toEqual([])
})
