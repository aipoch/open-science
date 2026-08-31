import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  deleteNotebookProjectInputs,
  deleteNotebookSessionInputs,
  ensureNotebookInputRoot,
  getNotebookInputRoot,
  resolveNotebookStagedInputPath
} from './input-staging'

let storageRoot: string | undefined

afterEach(async () => {
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

describe('Notebook immutable input staging paths', () => {
  it('cleans only the exact Session or Project cache it owns', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-notebook-inputs-'))
    const first = getNotebookInputRoot(storageRoot, 'project-a', 'session-a')
    const second = getNotebookInputRoot(storageRoot, 'project-a', 'session-b')
    const otherProject = getNotebookInputRoot(storageRoot, 'project-b', 'session-a')
    await Promise.all([
      ensureNotebookInputRoot(storageRoot, 'project-a', 'session-a'),
      ensureNotebookInputRoot(storageRoot, 'project-a', 'session-b'),
      ensureNotebookInputRoot(storageRoot, 'project-b', 'session-a')
    ])
    await Promise.all([
      writeFile(join(first, 'first'), 'first'),
      writeFile(join(second, 'second'), 'second'),
      writeFile(join(otherProject, 'other'), 'other')
    ])

    await deleteNotebookSessionInputs(storageRoot, 'project-a', 'session-a')
    await expect(readFile(join(first, 'first'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(second, 'second'), 'utf8')).resolves.toBe('second')

    await deleteNotebookProjectInputs(storageRoot, 'project-a')
    await expect(readFile(join(second, 'second'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(otherProject, 'other'), 'utf8')).resolves.toBe('other')
  })

  it('rejects path traversal before composing a cache path', () => {
    expect(() => getNotebookInputRoot('/storage', '../project', 'session')).toThrow(
      'Invalid Notebook input Project id'
    )
    expect(() => getNotebookInputRoot('/storage', 'project', '../session')).toThrow(
      'Invalid Notebook input Session id'
    )
  })

  it('resolves only an exact staged file owned by the current Project and Session', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-notebook-inputs-'))
    const currentRoot = getNotebookInputRoot(storageRoot, 'project-a', 'session-a')
    const staged = join(currentRoot, 'artifact-version', 'a'.repeat(64), 'content')
    await mkdir(join(staged, '..'), { recursive: true })
    await writeFile(staged, 'immutable input')

    await expect(
      resolveNotebookStagedInputPath(storageRoot, 'project-a', 'session-a', staged)
    ).resolves.toBe(await realpath(staged))
    await expect(
      resolveNotebookStagedInputPath(storageRoot, 'project-a', 'session-b', staged)
    ).resolves.toBeUndefined()
    await expect(
      resolveNotebookStagedInputPath(
        storageRoot,
        'project-a',
        'session-a',
        join(currentRoot, 'artifact-version', 'a'.repeat(64))
      )
    ).rejects.toThrow('exact staged Notebook input file')
  })

  it('rejects a staged-path symlink that escapes the Session input root', async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-notebook-inputs-'))
    const currentRoot = getNotebookInputRoot(storageRoot, 'project-a', 'session-a')
    const outside = join(storageRoot, 'outside.txt')
    const staged = join(currentRoot, 'upload-version', 'b'.repeat(64), 'content')
    await mkdir(join(staged, '..'), { recursive: true })
    await writeFile(outside, 'outside')
    await symlink(outside, staged)

    await expect(
      resolveNotebookStagedInputPath(storageRoot, 'project-a', 'session-a', staged)
    ).rejects.toThrow('escapes the current Notebook Session input root')
  })
})
