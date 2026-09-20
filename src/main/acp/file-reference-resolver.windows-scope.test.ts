import { describe, expect, it, vi } from 'vitest'

// Exercise the public resolver with Windows canonical paths on every CI host. The real native
// filesystem cases remain in file-reference-resolver.test.ts; only OS boundaries are substituted.
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>()
  return { ...actual, ...actual.win32 }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    realpath: vi.fn(async (path: string) => path),
    stat: vi.fn(async () => ({ isFile: () => true, size: 20 }))
  }
})
import { realpath } from 'node:fs/promises'
import { createManagedFileReferenceResolver } from './file-reference-resolver'

describe('Windows linked-folder canonical scope', () => {
  it.each([
    ['C:\\data', 'C:\\data\\audit.txt', true],
    ['C:\\data\\', 'c:\\DATA\\audit.txt', true],
    ['C:\\data', 'C:\\data\\..notes.txt', true],
    ['C:\\data', 'C:\\data2\\audit.txt', false],
    ['C:\\data', 'C:\\audit.txt', false],
    ['C:\\data', 'D:\\data\\audit.txt', false],
    ['\\server\\share\\data', '\\server\\share\\data\\audit.txt', true],
    ['\\server\\share\\data', '\\server\\share\\data2\\audit.txt', false],
    ['\\server\\share', '\\server\\other\\audit.txt', false],
    ['\\server\\share', '\\other\\share\\audit.txt', false]
  ])('checks %s against canonical target %s (allowed=%s)', async (root, candidate, allowed) => {
    vi.mocked(realpath).mockResolvedValueOnce(root).mockResolvedValueOnce(candidate)
    const resolver = createManagedFileReferenceResolver({
      grantedRoots: { resolveRoot: async () => ({ path: root, access: 'rw' }) }
    })
    const result = resolver.resolve(
      { projectId: 'test', sessionId: 'test' },
      {
        id: 'file',
        name: 'audit.txt',
        source: 'linked-folder',
        rootId: 'root',
        relativePath: 'audit.txt'
      }
    )
    if (allowed) await expect(result).resolves.toMatchObject({ absolutePath: candidate })
    else await expect(result).rejects.toThrow(/escapes the granted folder/)
    resolver.clear()
  })
})
