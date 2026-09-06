import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fileReadProbe = vi.hoisted(() => ({ path: '', bytes: 0, closed: Promise.resolve() }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    readFile: async (...args: Parameters<typeof original.readFile>) => {
      const contents = await original.readFile(...args)
      if (args[0] === fileReadProbe.path) fileReadProbe.bytes += Buffer.byteLength(contents)
      return contents
    }
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return {
    ...original,
    createReadStream: (...args: Parameters<typeof original.createReadStream>) => {
      const stream = original.createReadStream(...args)
      if (args[0] === fileReadProbe.path) {
        fileReadProbe.closed = new Promise<void>((resolve) => {
          stream.once('close', resolve)
        })
        stream.on('data', (chunk) => {
          fileReadProbe.bytes += Buffer.byteLength(chunk)
        })
      }
      return stream
    }
  }
})

import { readWorkspaceTextFile, writeWorkspaceTextFile } from './filesystem'

let workspaceRoot: string | undefined

// Removes the temporary workspace created by each filesystem test.
afterEach(async () => {
  if (workspaceRoot) {
    await rm(workspaceRoot, { recursive: true, force: true })
    workspaceRoot = undefined
  }
})

describe('ACP workspace filesystem adapter', () => {
  it('reads requested line ranges from files inside the workspace', async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'open-science-acp-'))
    const filePath = join(workspaceRoot, 'notes.txt')
    await writeFile(filePath, 'one\ntwo\nthree\n', 'utf8')

    await expect(
      readWorkspaceTextFile(workspaceRoot, {
        sessionId: 'session-1',
        path: filePath,
        line: 2,
        limit: 1
      })
    ).resolves.toEqual({ content: 'two' })
  })

  it('returns a short line window without reading the distant file tail', async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'open-science-acp-'))
    const filePath = join(workspaceRoot, 'large-log.txt')
    await writeFile(filePath, 'one\ntwo\n' + 'unrelated history\n'.repeat(32768), 'utf8')
    fileReadProbe.path = filePath
    fileReadProbe.bytes = 0
    try {
      await expect(
        readWorkspaceTextFile(workspaceRoot, {
          sessionId: 'session-1',
          path: filePath,
          line: 2,
          limit: 1
        })
      ).resolves.toEqual({ content: 'two' })
      await fileReadProbe.closed
      expect(
        fileReadProbe.bytes,
        'a two-line request consumes the complete log'
      ).toBeLessThanOrEqual(64 * 1024)
    } finally {
      fileReadProbe.path = ''
    }
  })

  it.each([
    ['CRLF', 'one\r\ntwo\r\nthree', 2, 1, 'two'],
    ['bare CR', 'one\rtwo\nthree', 1, 1, 'one\rtwo'],
    ['trailing LF', 'one\ntwo\n', 2, 3, 'two\n'],
    ['trailing CR', 'one\ntwo\r', 2, 1, 'two\r'],
    ['empty file', '', 1, 2, ''],
    ['past EOF', 'one\ntwo', 9, 2, ''],
    ['unlimited suffix', 'one\ntwo\nthree', 2, 0, 'two\nthree'],
    ['default start', 'one\ntwo', undefined, 1, 'one'],
    ['full read', 'one\r\ntwo\n', undefined, undefined, 'one\r\ntwo\n']
  ] as const)('preserves %s text semantics', async (_label, content, line, limit, expected) => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'open-science-acp-'))
    const path = join(workspaceRoot, 'text.txt')
    await writeFile(path, content, 'utf8')
    await expect(
      readWorkspaceTextFile(workspaceRoot, { sessionId: 'session-1', path, line, limit })
    ).resolves.toEqual({ content: expected })
  })

  it('preserves Unicode and CRLF across read chunks', async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'open-science-acp-'))
    const path = join(workspaceRoot, 'unicode.txt')
    const first = 'x'.repeat(16 * 1024 - 1) + '中文😀'
    await writeFile(path, first + '\r\nsecond\n', 'utf8')
    await expect(
      readWorkspaceTextFile(workspaceRoot, { sessionId: 'session-1', path, limit: 2 })
    ).resolves.toEqual({ content: first + '\nsecond' })
  })

  it('preserves CRLF split between chunks', async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'open-science-acp-'))
    const path = join(workspaceRoot, 'crlf.txt')
    const first = 'x'.repeat(16 * 1024 - 1)
    await writeFile(path, first + '\r\nsecond\n', 'utf8')
    await expect(
      readWorkspaceTextFile(workspaceRoot, { sessionId: 'session-1', path, limit: 2 })
    ).resolves.toEqual({ content: first + '\nsecond' })
  })

  it('closes a failed window read and preserves the filesystem error', async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'open-science-acp-'))
    const path = join(workspaceRoot, 'missing.txt')
    fileReadProbe.path = path
    try {
      await expect(
        readWorkspaceTextFile(workspaceRoot, { sessionId: 'session-1', path, limit: 1 })
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await fileReadProbe.closed
    } finally {
      fileReadProbe.path = ''
    }
  })

  it('writes only inside the workspace', async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'open-science-acp-'))
    const filePath = join(workspaceRoot, 'created.txt')

    await writeWorkspaceTextFile(workspaceRoot, {
      sessionId: 'session-1',
      path: filePath,
      content: 'saved'
    })

    await expect(readFile(filePath, 'utf8')).resolves.toBe('saved')
  })

  it('rejects reads inside a protected directory even when within the workspace', async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'open-science-acp-'))
    const protectedRoot = join(workspaceRoot, 'claude')
    const skillFile = join(protectedRoot, 'skills', 'os-demo', 'SKILL.md')
    await mkdir(dirname(skillFile), { recursive: true })
    await writeFile(skillFile, 'secret skill body', 'utf8')

    // The protected root is inside the workspace, so containment passes; the protected guard blocks it.
    await expect(
      readWorkspaceTextFile(workspaceRoot, { sessionId: 'session-1', path: skillFile }, [
        protectedRoot
      ])
    ).rejects.toThrow(/protected application directory/)

    // A file outside the protected root still reads.
    const ok = join(workspaceRoot, 'notes.txt')
    await writeFile(ok, 'hello', 'utf8')
    await expect(
      readWorkspaceTextFile(workspaceRoot, { sessionId: 'session-1', path: ok }, [protectedRoot])
    ).resolves.toEqual({ content: 'hello' })
  })

  it('rejects writes outside the workspace', async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'open-science-acp-'))

    await expect(
      writeWorkspaceTextFile(workspaceRoot, {
        sessionId: 'session-1',
        path: join(tmpdir(), 'outside-open-science-acp.txt'),
        content: 'nope'
      })
    ).rejects.toThrow(/outside the active ACP workspace/)
  })
})
