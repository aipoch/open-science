import { existsSync, readFileSync } from 'node:fs'
import { link, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  findExistingTargets,
  resolveTargets,
  saveIpynbAll,
  writeNotebooksWithCleanup,
  type ElectronSurface,
  type FsDeps,
  type SaveIpynbAllTarget
} from './save-ipynb-all'

const FILES = [
  { kernel: 'python' as const, name: 'session-abc-python.ipynb', data: '{"kernelspec":"python3"}' },
  { kernel: 'r' as const, name: 'session-abc-r.ipynb', data: '{"kernelspec":"ir"}' }
]

const fakeElectron = (options: {
  canceled?: boolean
  filePaths?: string[]
  overwriteResponse?: number
}): ElectronSurface => ({
  app: { getPath: () => '/downloads' },
  dialog: {
    showOpenDialog: vi.fn().mockResolvedValue({
      canceled: options.canceled ?? false,
      filePaths: options.filePaths ?? []
    }),
    showMessageBox: vi.fn().mockResolvedValue({ response: options.overwriteResponse ?? 0 })
  }
})

const realFsOps: FsDeps = {
  writeFile: (filePath, data) => writeFile(filePath, data, 'utf8'),
  publishNoReplace: async (src, dest) => {
    await link(src, dest)
  },
  publishReplace: async (src, dest) => {
    await rename(src, dest)
  },
  readFileOrNull: async (filePath) => {
    try {
      return readFileSync(filePath, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  },
  rmRmdir: (p) => rm(p, { recursive: true, force: true }),
  mkdtemp
}

const realFsCheck = (path: string): boolean => existsSync(path)

let root = ''
let directory = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'open-science-save-ipynb-all-'))
  directory = join(root, 'out')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(directory, { recursive: true })
})

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = ''
  }
})

describe('findExistingTargets', () => {
  it('returns only the paths that already exist on disk', async () => {
    const existing = join(root, 'exists.ipynb')
    await writeFile(existing, '{}', 'utf8')
    expect(findExistingTargets([existing, join(root, 'missing.ipynb')])).toEqual([existing])
  })
})

describe('resolveTargets', () => {
  it('joins every file name to the directory', () => {
    const targets = resolveTargets('/tmp/out', [
      { kernel: 'python', name: 'a.ipynb', data: 'py' },
      { kernel: 'r', name: 'b.ipynb', data: 'r' }
    ])
    expect(targets.map((t) => t.filePath)).toEqual(['/tmp/out/a.ipynb', '/tmp/out/b.ipynb'])
  })
})

describe('writeNotebooksWithCleanup', () => {
  it('writes and publishes every file', async () => {
    const targets: SaveIpynbAllTarget[] = [
      { kernel: 'python', name: 'a.ipynb', data: 'py', filePath: join(directory, 'a.ipynb') },
      { kernel: 'r', name: 'b.ipynb', data: 'r', filePath: join(directory, 'b.ipynb') }
    ]
    const result = await writeNotebooksWithCleanup(targets, realFsOps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.published).toHaveLength(2)
    expect(readFileSync(result.published[0]!, 'utf8')).toBe('py')
  })

  it('returns partial failure when a later publish fails', async () => {
    const firstPath = join(directory, 'first.ipynb')
    const secondPath = join(directory, 'second.ipynb')
    const targets: SaveIpynbAllTarget[] = [
      { kernel: 'python', name: 'first.ipynb', data: 'one', filePath: firstPath },
      { kernel: 'r', name: 'second.ipynb', data: 'two', filePath: secondPath }
    ]
    let call = 0
    const failFs: FsDeps = {
      ...realFsOps,
      publishNoReplace: async (src, dest): Promise<void> => {
        call += 1
        if (call === 2) {
          await writeFile(dest, '"interloper"', 'utf8')
          throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
        }
        await link(src, dest)
      }
    }
    const result = await writeNotebooksWithCleanup(targets, failFs)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.published).toEqual([firstPath])
    expect(result.failedTarget).toBe('second.ipynb')
    expect(readFileSync(firstPath, 'utf8')).toBe('one')
    expect(readFileSync(secondPath, 'utf8')).toBe('"interloper"')
  })

  it('returns failure with empty published when staging write fails', async () => {
    const targets: SaveIpynbAllTarget[] = [
      { kernel: 'python', name: 'a.ipynb', data: 'py', filePath: join(directory, 'a.ipynb') }
    ]
    const failFs: FsDeps = {
      ...realFsOps,
      writeFile: async (): Promise<void> => {
        throw new Error('disk full')
      }
    }
    const result = await writeNotebooksWithCleanup(targets, failFs)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.published).toEqual([])
    expect(result.error.message).toBe('disk full')
  })

  it('reports the correct failedTarget when staging write fails on the second file', async () => {
    const targets: SaveIpynbAllTarget[] = [
      { kernel: 'python', name: 'first.ipynb', data: 'one', filePath: join(directory, 'first.ipynb') },
      { kernel: 'r', name: 'second.ipynb', data: 'two', filePath: join(directory, 'second.ipynb') }
    ]
    let call = 0
    const failFs: FsDeps = {
      ...realFsOps,
      writeFile: async (filePath, data): Promise<void> => {
        call += 1
        if (call === 2) throw new Error('disk full')
        await writeFile(filePath, data, 'utf8')
      }
    }
    const result = await writeNotebooksWithCleanup(targets, failFs)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.published).toEqual([])
    expect(result.failedTarget).toBe('second.ipynb')
  })

  it('atomically overwrites a confirmed pre-existing file', async () => {
    const targetPath = join(directory, 'existing.ipynb')
    await writeFile(targetPath, '"old content"', 'utf8')
    const targets: SaveIpynbAllTarget[] = [
      { kernel: 'python', name: 'existing.ipynb', data: '"new content"', filePath: targetPath }
    ]
    const result = await writeNotebooksWithCleanup(targets, realFsOps, new Set([targetPath]))
    expect(result.ok).toBe(true)
    expect(readFileSync(targetPath, 'utf8')).toBe('"new content"')
  })
})

describe('saveIpynbAll', () => {
  it('returns { saved: false } when cancelled', async () => {
    const electron = fakeElectron({ canceled: true })
    const result = await saveIpynbAll(FILES, { electron, fsCheck: realFsCheck, fsOps: realFsOps })
    expect(result).toEqual({ saved: false })
  })

  it('writes all files when nothing conflicts', async () => {
    const electron = fakeElectron({ filePaths: [directory] })
    const result = await saveIpynbAll(FILES, { electron, fsCheck: realFsCheck, fsOps: realFsOps })
    expect(result.saved).toBe(true)
    if (!result.saved) return
    expect(result.files).toHaveLength(2)
    expect(readFileSync(result.files[0]!.filePath, 'utf8')).toBe('{"kernelspec":"python3"}')
  })

  it('prompts for overwrite and cancels when declined', async () => {
    const firstPath = join(directory, FILES[0]!.name)
    const secondPath = join(directory, FILES[1]!.name)
    await writeFile(firstPath, '"old python"', 'utf8')
    await writeFile(secondPath, '"old r"', 'utf8')
    const electron = fakeElectron({ filePaths: [directory], overwriteResponse: 1 })
    const result = await saveIpynbAll(FILES, { electron, fsCheck: realFsCheck, fsOps: realFsOps })
    expect(result).toEqual({ saved: false })
    expect(readFileSync(firstPath, 'utf8')).toBe('"old python"')
  })

  it('overwrites when user confirms', async () => {
    const firstPath = join(directory, FILES[0]!.name)
    const secondPath = join(directory, FILES[1]!.name)
    await writeFile(firstPath, '"old python"', 'utf8')
    await writeFile(secondPath, '"old r"', 'utf8')
    const electron = fakeElectron({ filePaths: [directory], overwriteResponse: 0 })
    const result = await saveIpynbAll(FILES, { electron, fsCheck: realFsCheck, fsOps: realFsOps })
    expect(result.saved).toBe(true)
    if (!result.saved) return
    expect(readFileSync(firstPath, 'utf8')).toBe('{"kernelspec":"python3"}')
    expect(readFileSync(secondPath, 'utf8')).toBe('{"kernelspec":"ir"}')
  })

  it('throws partial-failure error when a later publish fails', async () => {
    const firstPath = join(directory, FILES[0]!.name)
    let call = 0
    const failFs: FsDeps = {
      ...realFsOps,
      publishNoReplace: async (src, dest): Promise<void> => {
        call += 1
        if (call === 2) {
          await writeFile(dest, '"interloper"', 'utf8')
          throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
        }
        await link(src, dest)
      }
    }
    const electron = fakeElectron({ filePaths: [directory] })
    await expect(
      saveIpynbAll(FILES, { electron, fsCheck: realFsCheck, fsOps: failFs })
    ).rejects.toThrow(/Export incomplete: 1 of 2/)
    expect(readFileSync(firstPath, 'utf8')).toBe('{"kernelspec":"python3"}')
  })

  it('preserves pre-existing files when staging write fails', async () => {
    const firstPath = join(directory, FILES[0]!.name)
    await writeFile(firstPath, '"old python"', 'utf8')
    const electron = fakeElectron({ filePaths: [directory], overwriteResponse: 0 })
    let writeCall = 0
    const failFs: FsDeps = {
      ...realFsOps,
      writeFile: async (filePath, data): Promise<void> => {
        writeCall += 1
        if (writeCall === 2) throw new Error('disk full')
        await writeFile(filePath, data, 'utf8')
      }
    }
    await expect(
      saveIpynbAll(FILES, { electron, fsCheck: realFsCheck, fsOps: failFs })
    ).rejects.toThrow(/Export incomplete/)
    expect(readFileSync(firstPath, 'utf8')).toBe('"old python"')
  })

  it('returns { saved: false } for empty input', async () => {
    const electron = fakeElectron({})
    const result = await saveIpynbAll([], { electron, fsCheck: realFsCheck, fsOps: realFsOps })
    expect(result).toEqual({ saved: false })
  })
})
