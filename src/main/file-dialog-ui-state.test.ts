import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileDialogUiSession } from './file-dialog-ui-state'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  root: string
  session: FileDialogUiSession
  finish: ReturnType<typeof vi.fn>
}> {
  const root = await mkdtemp(join(tmpdir(), 'file-dialog-state-'))
  roots.push(root)
  const finish = vi.fn()
  const session = new FileDialogUiSession(
    {
      kind: 'save',
      options: {
        defaultPath: join(root, 'output.txt'),
        filters: [{ name: 'Text', extensions: ['txt'] }]
      }
    },
    {
      locale: 'en',
      shortcuts: [{ kind: 'downloads', path: root }]
    },
    finish,
    vi.fn()
  )
  return { root, session, finish }
}

it('rejects malformed and escaping selections at the filesystem boundary', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  const { root, session, finish } = await fixture()
  for (const filename of [
    '../escape.txt',
    'a\\escape.txt',
    'a:stream.txt',
    'CON .txt',
    'COM¹.txt',
    'trailing.txt ',
    1,
    null
  ]) {
    expect(await session.action({ type: 'select', directory: root, filename })).toEqual({
      type: 'error',
      code: 'filename'
    })
  }
  expect(
    await session.action({
      type: 'select',
      directory: '../relative',
      filename: 'output.txt'
    })
  ).toEqual({ type: 'error', code: 'folder' })
  expect(
    await session.action({
      type: 'select',
      directory: root,
      filename: 'output.exe'
    })
  ).toMatchObject({
    type: 'error',
    code: 'extension',
    suggestions: { keep: 'output.exe.txt', replace: 'output.txt' }
  })
  expect(await session.action({ type: 'replace', token: 'unissued' })).toEqual({
    type: 'error',
    code: 'changed'
  })
  expect(finish).not.toHaveBeenCalled()
})

it('invalidates replacement consent after browsing and never follows an output symlink', async () => {
  const { root, session, finish } = await fixture()
  const file = join(root, 'existing.txt')
  await writeFile(file, 'keep')
  const confirmation = await session.action({
    type: 'select',
    directory: root,
    filename: 'existing.txt'
  })
  expect(confirmation.type).toBe('confirm')
  if (confirmation.type !== 'confirm') throw new Error('Missing confirmation')
  await session.action({ type: 'browse', path: root })
  expect(await session.action({ type: 'replace', token: confirmation.token })).toEqual({
    type: 'error',
    code: 'changed'
  })
  // Creating a Windows symlink may require developer mode; POSIX covers this filesystem boundary.
  if (process.platform !== 'win32') {
    await symlink(file, join(root, 'link.txt'))
    expect(
      await session.action({
        type: 'select',
        directory: root,
        filename: 'link.txt'
      })
    ).toEqual({ type: 'error', code: 'destination' })
  }
  expect(await readFile(file, 'utf8')).toBe('keep')
  expect(finish).not.toHaveBeenCalled()
})

it('keeps macOS filenames independent of Windows reserved names', async () => {
  vi.stubGlobal('process', { ...process, platform: 'darwin' })
  const { root, session, finish } = await fixture()
  expect(await session.action({ type: 'select', directory: root, filename: 'CON.txt' })).toEqual({
    type: 'done'
  })
  expect(finish).toHaveBeenCalledWith({ canceled: false, filePath: join(root, 'CON.txt') })
})
