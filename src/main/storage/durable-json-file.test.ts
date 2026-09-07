import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat as statFile,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DurableJsonRecoveryBarrierError,
  readDurableJsonFile,
  writeDurableJsonFile,
  type DurableJsonFileDependencies
} from './durable-json-file'

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

describe('durable JSON file recovery', () => {
  it('rejects an oversized primary before reading it', async () => {
    const filePath = join('config', 'settings.json')
    const dependencies = createDependencies({
      stat: vi.fn().mockResolvedValue({ mtimeMs: 1, size: 11 }),
      readFile: vi.fn().mockResolvedValue('{"ok":true}')
    })

    await expect(
      readDurableJsonFile(filePath, JSON.parse, dependencies, { maxBytes: 10 })
    ).rejects.toThrow('settings.json exceeds the 10 byte read limit.')
    expect(dependencies.readFile).not.toHaveBeenCalled()
  })

  it('rejects a primary replaced with oversized contents after the path stat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durable-json-read-race-'))
    roots.push(root)
    const filePath = join(root, 'settings.json')
    const initialContents = '{}\n'
    const oversizedContents = '{"replacement":"larger than the admitted file"}\n'
    await writeFile(filePath, initialContents, 'utf8')
    let replaced = false

    await expect(
      readDurableJsonFile(
        filePath,
        JSON.parse,
        {
          stat: async (path) => {
            const metadata = await statFile(path)
            if (!replaced && path === filePath) {
              replaced = true
              await writeFile(filePath, oversizedContents, 'utf8')
            }
            return metadata
          }
        },
        { maxBytes: Buffer.byteLength(initialContents) }
      )
    ).rejects.toThrow(
      `settings.json exceeds the ${Buffer.byteLength(initialContents)} byte read limit.`
    )
  })

  it('keeps a valid primary authoritative and removes recognized temps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durable-json-primary-'))
    roots.push(root)
    const filePath = join(root, 'settings.json')
    const temporaryPath = `${filePath}.1700000000000-1.tmp`
    await writeFile(filePath, '{"source":"primary"}\n', 'utf8')
    await writeFile(temporaryPath, '{"source":"temp"}\n', 'utf8')

    await expect(readDurableJsonFile(filePath, JSON.parse)).resolves.toEqual({
      status: 'found',
      value: { source: 'primary' }
    })
    await expect(readdir(root)).resolves.toEqual(['settings.json'])
  })

  it('preserves a recovery-barrier temp when a valid primary exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durable-json-primary-barrier-'))
    roots.push(root)
    const filePath = join(root, 'settings.json')
    const temporaryPath = `${filePath}.1700000000000-1.tmp`
    const primaryContents = '{"version":2}\n'
    const futureContents = '{"version":3}\n'
    await writeFile(filePath, primaryContents, 'utf8')
    await writeFile(temporaryPath, futureContents, 'utf8')

    const decode = (contents: string): { version: number } => {
      const value = JSON.parse(contents) as { version: number }
      if (value.version > 2) throw new DurableJsonRecoveryBarrierError('future version')
      return value
    }

    await expect(readDurableJsonFile(filePath, decode)).rejects.toThrow('future version')
    await expect(readFile(filePath, 'utf8')).resolves.toBe(primaryContents)
    await expect(readFile(temporaryPath, 'utf8')).resolves.toBe(futureContents)
  })

  it('preserves an oversized recovery temp when a valid primary exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durable-json-primary-oversized-temp-'))
    roots.push(root)
    const filePath = join(root, 'settings.json')
    const temporaryPath = `${filePath}.1700000000000-1.tmp`
    const primaryContents = '{"ok":true}\n'
    const oversizedContents = '{"future":"settings that exceed the current limit"}\n'
    await writeFile(filePath, primaryContents, 'utf8')
    await writeFile(temporaryPath, oversizedContents, 'utf8')

    await expect(
      readDurableJsonFile(
        filePath,
        JSON.parse,
        {},
        { maxBytes: Buffer.byteLength(primaryContents) }
      )
    ).rejects.toThrow('settings.json.1700000000000-1.tmp exceeds')
    await expect(readFile(filePath, 'utf8')).resolves.toBe(primaryContents)
    await expect(readFile(temporaryPath, 'utf8')).resolves.toBe(oversizedContents)
  })

  it('does not treat an unrelated tmp file as publication residue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durable-json-unrelated-temp-'))
    roots.push(root)
    const filePath = join(root, 'settings.json')
    const unrelatedPath = `${filePath}.manual-backup.tmp`
    await writeFile(filePath, '{"source":"primary"}\n', 'utf8')
    await writeFile(unrelatedPath, '{"source":"manual"}\n', 'utf8')

    await expect(readDurableJsonFile(filePath, JSON.parse)).resolves.toEqual({
      status: 'found',
      value: { source: 'primary' }
    })
    await expect(readdir(root)).resolves.toEqual([
      'settings.json',
      'settings.json.manual-backup.tmp'
    ])
  })

  it('promotes the newest valid temp only when the primary is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durable-json-recovery-'))
    roots.push(root)
    const filePath = join(root, 'settings.json')
    const validTemporaryPath = `${filePath}.1700000000000-1.tmp`
    const invalidTemporaryPath = `${filePath}.1700000001000-2.tmp`
    await writeFile(validTemporaryPath, '{"source":"recovered"}\n', 'utf8')
    await writeFile(invalidTemporaryPath, '{', 'utf8')
    const now = new Date()
    await utimes(
      validTemporaryPath,
      new Date(now.getTime() - 2_000),
      new Date(now.getTime() - 2_000)
    )
    await utimes(
      invalidTemporaryPath,
      new Date(now.getTime() - 1_000),
      new Date(now.getTime() - 1_000)
    )

    await expect(readDurableJsonFile(filePath, JSON.parse)).resolves.toEqual({
      status: 'found',
      value: { source: 'recovered' }
    })
    await expect(readFile(filePath, 'utf8')).resolves.toBe('{"source":"recovered"}\n')
    await expect(readdir(root)).resolves.toEqual(['settings.json'])
  })

  it('preserves a recovery-barrier temp before promoting another candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durable-json-mixed-barrier-'))
    roots.push(root)
    const filePath = join(root, 'settings.json')
    const currentTemporaryPath = `${filePath}.1700000001000-2.tmp`
    const futureTemporaryPath = `${filePath}.1700000000000-1.tmp`
    const currentContents = '{"version":2}\n'
    const futureContents = '{"version":3}\n'
    await writeFile(currentTemporaryPath, currentContents, 'utf8')
    await writeFile(futureTemporaryPath, futureContents, 'utf8')
    const now = new Date()
    await utimes(
      futureTemporaryPath,
      new Date(now.getTime() - 2_000),
      new Date(now.getTime() - 2_000)
    )
    await utimes(
      currentTemporaryPath,
      new Date(now.getTime() - 1_000),
      new Date(now.getTime() - 1_000)
    )

    const decode = (contents: string): { version: number } => {
      const value = JSON.parse(contents) as { version: number }
      if (value.version > 2) throw new DurableJsonRecoveryBarrierError('future version')
      return value
    }

    await expect(readDurableJsonFile(filePath, decode)).rejects.toThrow('future version')
    await expect(readFile(currentTemporaryPath, 'utf8')).resolves.toBe(currentContents)
    await expect(readFile(futureTemporaryPath, 'utf8')).resolves.toBe(futureContents)
    await expect(readdir(root)).resolves.toEqual([
      'settings.json.1700000000000-1.tmp',
      'settings.json.1700000001000-2.tmp'
    ])
  })

  it('does not mask a corrupt committed primary with a valid temp', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durable-json-corrupt-primary-'))
    roots.push(root)
    const filePath = join(root, 'settings.json')
    const temporaryPath = `${filePath}.1700000000000-1.tmp`
    await writeFile(filePath, '{', 'utf8')
    await writeFile(temporaryPath, '{"source":"temp"}\n', 'utf8')

    await expect(readDurableJsonFile(filePath, JSON.parse)).rejects.toBeInstanceOf(SyntaxError)
    await expect(readdir(root)).resolves.toEqual([
      'settings.json',
      'settings.json.1700000000000-1.tmp'
    ])
  })

  it('preserves invalid temps when no primary or valid recovery candidate exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durable-json-invalid-temp-'))
    roots.push(root)
    const filePath = join(root, 'settings.json')
    const temporaryPath = `${filePath}.1700000000000-1.tmp`
    await writeFile(temporaryPath, '{', 'utf8')

    await expect(readDurableJsonFile(filePath, JSON.parse)).resolves.toEqual({ status: 'missing' })
    await expect(readdir(root)).resolves.toEqual(['settings.json.1700000000000-1.tmp'])
  })

  it('does not promote or remove a temp owned by a live process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durable-json-live-writer-'))
    roots.push(root)
    const filePath = join(root, 'settings.json')
    const temporaryPath = `${filePath}.${process.pid}-12345678-1234-1234-1234-123456789abc.tmp`
    await writeFile(temporaryPath, '{"source":"in-flight"}\n', 'utf8')

    await expect(readDurableJsonFile(filePath, JSON.parse)).resolves.toEqual({ status: 'missing' })
    await expect(readdir(root)).resolves.toEqual([
      `settings.json.${process.pid}-12345678-1234-1234-1234-123456789abc.tmp`
    ])
  })

  it('recovers a legacy PID-only temp even when that PID has been reused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'durable-json-legacy-pid-'))
    roots.push(root)
    const filePath = join(root, 'settings.json')
    await writeFile(`${filePath}.${process.pid}.tmp`, '{"source":"legacy"}\n', 'utf8')

    await expect(readDurableJsonFile(filePath, JSON.parse)).resolves.toEqual({
      status: 'found',
      value: { source: 'legacy' }
    })
    await expect(readdir(root)).resolves.toEqual(['settings.json'])
  })
})
