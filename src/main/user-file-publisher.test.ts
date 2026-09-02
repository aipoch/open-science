import { chmod, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
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
