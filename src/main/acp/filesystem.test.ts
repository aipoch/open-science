import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

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
