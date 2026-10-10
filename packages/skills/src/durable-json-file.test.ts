import { mkdtemp, readFile, readdir, writeFile, rm, stat as statFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { writeDurableJsonFile, type DurableJsonFileDependencies } from './durable-json-file'

const replacementDenied = (): NodeJS.ErrnoException =>
  Object.assign(new Error('replacement denied'), { code: 'EPERM' })

const createDependencies = (
  overrides: Partial<DurableJsonFileDependencies> = {}
): DurableJsonFileDependencies => ({
  createTemporarySuffix: () => '1234-test',
  mkdir: vi.fn().mockResolvedValue(undefined),
  readDirectoryEntries: vi.fn().mockResolvedValue([]),
  readFile: vi.fn(),
  readFileWithinLimit: vi.fn(),
  remove: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn(),
  syncDirectory: vi.fn().mockResolvedValue(undefined),
  syncFile: vi.fn().mockResolvedValue(undefined),
  wait: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  ...overrides
})

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe('durable JSON file publication', () => {
  it.skipIf(process.platform === 'win32')('publishes an owner-only file mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durable-json-mode-'))
    roots.push(root)
    const filePath = join(root, 'settings.json')

    await writeDurableJsonFile(filePath, '{}\n')

    expect((await statFile(filePath)).mode & 0o777).toBe(0o600)
  })

  it('syncs a private unique temp and retries a transient Windows replacement denial', async () => {
    const filePath = join('config', 'settings.json')
    const events: string[] = []
    let renameAttempts = 0
    const dependencies = createDependencies({
      writeFile: vi.fn(async (_path, _contents, options) => {
        expect(options).toEqual({ encoding: 'utf8', flag: 'wx', mode: 0o600 })
        events.push('write')
      }),
      syncFile: vi.fn(async () => {
        events.push('sync-file')
      }),
      rename: vi.fn(async () => {
        renameAttempts += 1
        if (renameAttempts === 1) {
          events.push('rename-denied')
          throw replacementDenied()
        }
        events.push('rename')
      }),
      syncDirectory: vi.fn(async () => {
        events.push('sync-directory')
      })
    })

    await writeDurableJsonFile(filePath, '{"version":2}\n', dependencies)

    expect(events).toEqual(['write', 'sync-file', 'rename-denied', 'rename', 'sync-directory'])
    expect(dependencies.writeFile).toHaveBeenCalledWith(
      `${filePath}.1234-test.tmp`,
      '{"version":2}\n',
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    )
    expect(dependencies.wait).toHaveBeenCalledWith(25)
    expect(dependencies.remove).not.toHaveBeenCalled()
  })

  it('removes its temp after persistent replacement denial', async () => {
    const filePath = join('config', 'settings.json')
    const failure = replacementDenied()
    const dependencies = createDependencies({
      rename: vi.fn().mockRejectedValue(failure)
    })

    await expect(writeDurableJsonFile(filePath, '{}\n', dependencies)).rejects.toBe(failure)

    expect(dependencies.rename).toHaveBeenCalledTimes(6)
    expect(dependencies.wait).toHaveBeenCalledTimes(5)
    expect(dependencies.remove).toHaveBeenCalledWith(`${filePath}.1234-test.tmp`, {
      force: true,
      recursive: false
    })
  })

  it('does not remove a pre-existing temp when exclusive creation rejects a suffix collision', async () => {
    const collision = Object.assign(new Error('temp already exists'), { code: 'EEXIST' })
    const dependencies = createDependencies({
      writeFile: vi.fn().mockRejectedValue(collision)
    })

    await expect(
      writeDurableJsonFile(join('config', 'settings.json'), '{}\n', dependencies)
    ).rejects.toBe(collision)

    expect(dependencies.remove).not.toHaveBeenCalled()
  })

  it('serializes independent writers that select the same temporary path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durable-json-writer-collision-'))
    roots.push(root)
    const filePath = join(root, 'settings.json')
    const temporaryPath = `${filePath}.4321-12345678-1234-1234-1234-123456789abc.tmp`
    const writtenPaths: string[] = []
    const write = async (
      path: string,
      contents: string,
      options: { encoding: 'utf8'; flag: 'wx'; mode: number }
    ): Promise<void> => {
      writtenPaths.push(path)
      await writeFile(path, contents, options)
    }
    const dependencies = {
      createTemporarySuffix: () => '4321-12345678-1234-1234-1234-123456789abc',
      writeFile: write
    }

    await expect(
      Promise.all([
        writeDurableJsonFile(filePath, '{"writer":1}\n', dependencies),
        writeDurableJsonFile(filePath, '{"writer":2}\n', dependencies)
      ])
    ).resolves.toEqual([undefined, undefined])

    expect(writtenPaths).toEqual([temporaryPath, temporaryPath])
    await expect(readFile(filePath, 'utf8')).resolves.toBe('{"writer":2}\n')
    await expect(readdir(root)).resolves.toEqual(['settings.json'])
  })
})
