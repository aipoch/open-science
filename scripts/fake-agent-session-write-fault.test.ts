import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sessionJournalPath, SessionJournalStore } from '../src/main/session-persistence/journal'
import { readRawOutcomeSession } from '../e2e/fixtures/session-outcome-fault'

let root: string
let directory: string
let restore: (() => Promise<void>) | undefined
const mode = async (path: string): Promise<number> => (await lstat(path)).mode & 0o7777

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'open-science-electron-e2e-write-fault-'))
  directory = join(root, 'sessions', 'project')
  await mkdir(directory, { recursive: true })
})
afterEach(async () => {
  await restore?.()
  restore = undefined
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

const fault = async (
  changeMode: typeof chmod = chmod,
  environment = { OPEN_SCIENCE_STORAGE_ROOT: root, OPEN_SCIENCE_E2E_STORAGE_ROOT: root }
): Promise<() => Promise<() => Promise<void>>> => {
  const source = await readFile('e2e/fixtures/fake-opencode.mjs', 'utf8')
  const start = source.indexOf('const suspendSessionWrites =')
  const end = source.indexOf('\nconst stringEnvironment', start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  // Exercise the real fixture function without starting the fake agent's ACP stdio listener.
  return runInNewContext(`${source.slice(start, end)}\nsuspendSessionWrites`, {
    process: { env: environment },
    join,
    chmod: changeMode,
    lstat,
    readdir
  }) as () => Promise<() => Promise<void>>
}

it('blocks existing journal appends and restores every original mode exactly', async () => {
  const paths = ['session.json', 'session.jsonl', 'session.legacy-json.backup'].map((name) =>
    join(directory, name)
  )
  await chmod(directory, 0o750)
  for (const [index, path] of paths.entries()) {
    await writeFile(path, 'original')
    await chmod(path, index % 2 ? 0o640 : 0o600)
  }
  const originals = await Promise.all([directory, ...paths].map(mode))
  restore = await (await fault())()
  for (const path of paths) expect((await mode(path)) & 0o222).toBe(0)
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    await expect(appendFile(paths[1], 'append')).rejects.toMatchObject({ code: 'EACCES' })
    await expect(writeFile(join(directory, 'new-session.jsonl'), 'new')).rejects.toMatchObject({
      code: 'EACCES'
    })
  }
  await restore()
  await restore()
  expect(await Promise.all([directory, ...paths].map(mode))).toEqual(originals)
  await appendFile(paths[1], ' restored')
  expect(await readFile(paths[1], 'utf8')).toBe('original restored')
})

it('restores already changed directories and files when fault installation fails', async () => {
  const file = join(directory, 'session.json')
  await writeFile(file, 'original', { mode: 0o640 })
  const originals = await Promise.all([directory, file].map(mode))
  const changeMode = vi.fn<typeof chmod>(async (path, permissions) => {
    if (String(path) === file && (Number(permissions) & 0o222) === 0)
      throw new Error('injected chmod failure')
    await chmod(path, permissions)
  })
  await expect((await fault(changeMode))()).rejects.toThrow('injected chmod failure')
  expect(await Promise.all([directory, file].map(mode))).toEqual(originals)
})

it('refuses a fault outside the matching isolated E2E root before changing permissions', async () => {
  const changeMode = vi.fn<typeof chmod>()
  await expect(
    (
      await fault(changeMode, {
        OPEN_SCIENCE_STORAGE_ROOT: root,
        OPEN_SCIENCE_E2E_STORAGE_ROOT: `${root}-other`
      })
    )()
  ).rejects.toThrow('isolated E2E storage')
  expect(changeMode).not.toHaveBeenCalled()
})

it('reads the latest logical outcome Session after a journal append', async () => {
  vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', root)
  vi.stubEnv('OPEN_SCIENCE_CONFIG_ROOT', root)
  const journal = new SessionJournalStore({ maxBytes: 1024 * 1024 })
  const path = join(directory, 'session.json')
  await journal.write(path, {
    document: {
      version: 2,
      session: { id: 'session', projectId: 'project', revision: 1, title: 'Before' }
    },
    expectedRevision: 0
  })
  const initial = await readFile(sessionJournalPath(path), 'utf8')
  await journal.write(path, {
    document: {
      version: 2,
      session: { id: 'session', projectId: 'project', revision: 2, title: 'After' }
    },
    expectedRevision: 1
  })
  const app = {
    application: { evaluate: async (callback: () => unknown) => callback() }
  } as unknown as Parameters<typeof readRawOutcomeSession>[0]
  expect((await readFile(sessionJournalPath(path), 'utf8')).startsWith(initial)).toBe(true)
  await expect(
    readRawOutcomeSession(app, { projectId: 'project', sessionId: 'session' })
  ).resolves.toMatchObject({ title: 'After', revision: 2 })
})
