import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as tar from 'tar'
import { ResourceLogStore } from '../resource-diagnostics/store'
import { ResourceRecorder } from '../resource-diagnostics/recorder'
import { exportResourceJournal, inspectResourceJournal } from './resources'
import { runSessionDiagnosticWorker } from './collector'
import { exportDiagnosticFiles } from '../diagnostics/integration-test-helpers'

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>())
}))
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(): Promise<{
  root: string
  configRoot: string
  journal: string
  directory: string
  dataRoot: string
  appVersion: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'resource-export-'))
  roots.push(root)
  const configRoot = join(root, 'config')
  const journal = join(configRoot, 'logs/resources')
  const directory = join(root, 'output')
  await mkdir(journal, { recursive: true })
  await mkdir(directory)
  return { root, configRoot, journal, directory, dataRoot: join(root, 'data'), appVersion: 'test' }
}
const record = (data: object = { pid: 42, birth: '123', privateBytes: 1234 }): string =>
  JSON.stringify({
    schema: 1,
    runId: 'previous-run',
    sequence: 1,
    time: 1700000000000,
    elapsedMs: 30,
    event: 'process-sample',
    data
  }) + '\n'

it('copies real pre-failure and current recorder evidence through the desktop worker without changing sources', async () => {
  const f = await fixture()
  const makeRecorder = (runId: string): ResourceRecorder =>
    new ResourceRecorder({
      runId,
      timers: false,
      store: new ResourceLogStore({ directory: f.journal }),
      native: { readWindowsResourceBirth: () => '123', sampleWindowsResources: vi.fn() }
    })
  const before = makeRecorder('before-failure')
  before.event('process-born', { pid: 42, birth: '123', sessionId: 'session-a' })
  await before.close(false)
  const current = makeRecorder('after-restart')
  current.event('activity-snapshot', { sessionId: 'session-b', activePrompts: 1 })
  await current.close(true)
  const names = await readdir(f.journal)
  expect(names.some((name) => name.startsWith('incident-'))).toBe(true)
  expect(names.some((name) => name.startsWith('live-'))).toBe(true)
  const original = await Promise.all(names.map((name) => readFile(join(f.journal, name), 'utf8')))
  const files = await exportDiagnosticFiles(f, {
    scope: 'application',
    selectedItems: ['resource-logs']
  })
  expect(Object.keys(files).some((name) => name.startsWith('logs/resources/incident-'))).toBe(true)
  expect(Object.values(files).join('\n')).toContain('before-failure')
  expect(Object.values(files).join('\n')).toContain('after-restart')
  expect(Object.values(files).join('\n')).toContain('segment-checkpoint')
  expect(
    JSON.parse(files['manifest.json']).items.find(
      (item: { id: string }) => item.id === 'resource-logs'
    )
  ).toMatchObject({ status: 'exported', scope: 'global', selected: true })
  expect(await readdir(f.journal)).toEqual(names)
  expect(await Promise.all(names.map((name) => readFile(join(f.journal, name), 'utf8')))).toEqual(
    original
  )
})

it('never includes resource data without selection and never discovers session sources in application scope', async () => {
  const f = await fixture()
  await writeFile(join(f.journal, 'incident-00000000.jsonl'), record())
  await mkdir(join(f.configRoot, 'sessions/project'), { recursive: true })
  await writeFile(join(f.configRoot, 'sessions/project/session.json'), '{"secret":"not-selected"}')
  const inspect = await runSessionDiagnosticWorker({
    ...f,
    scope: 'application',
    action: 'inspect'
  })
  expect(inspect.kind).toBe('inspection')
  if (inspect.kind !== 'inspection') throw Error('inspection failed')
  expect(inspect.inspection.items.find((item) => item.id === 'resource-logs')).toMatchObject({
    available: true
  })
  expect(
    inspect.inspection.items.some((item) =>
      ['session', 'database', 'notebook', 'sensitive-file'].includes(item.kind)
    )
  ).toBe(false)
  const exported = await runSessionDiagnosticWorker({
    ...f,
    scope: 'application',
    action: 'export',
    selectedItems: ['session', 'database']
  })
  expect(exported).toMatchObject({ kind: 'archive', partial: true })
  const entries: string[] = []
  await tar.list({
    file: join(f.directory, 'archive.tar.gz'),
    onReadEntry: (entry) => {
      entries.push(entry.path)
    }
  })
  expect(entries).not.toContain('session.json')
  expect(entries.some((name) => name.startsWith('logs/resources/'))).toBe(false)
})

it('preserves checkpoints with more than 256 identities and omits unknown payloads and broken trailing records', async () => {
  const f = await fixture()
  const checkpoint =
    JSON.stringify({
      schema: 1,
      runId: 'run',
      event: 'segment-checkpoint',
      time: 1,
      throughSequence: 500,
      data: { processes: Array.from({ length: 300 }, (_, pid) => ({ pid, birth: '123' })) }
    }) + '\n'
  await writeFile(
    join(f.journal, 'incident-00000000.jsonl'),
    checkpoint +
      record({ pid: 42, prompt: 'private prompt', path: 'C:/private' }) +
      'broken\n{"unfinished":'
  )
  const result = await exportResourceJournal(f.configRoot, f.directory)
  expect(result.partial).toBe(true)
  const text = await readFile(join(f.directory, result.files[0]), 'utf8')
  expect(JSON.parse(text.split('\n')[0]).data.processes).toHaveLength(300)
  expect(text).not.toMatch(/private|prompt|unfinished/)
  expect(result.metadata.segments[0].omittedRecords).toBe(1)
  expect(result.metadata.segments[0].omittedBytes).toBeGreaterThan(0)
})

it('retains opened incident bytes across a concurrent rename and excludes later appends', async () => {
  const f = await fixture()
  const path = join(f.journal, 'incident-00000000.jsonl')
  await writeFile(path, record())
  const originalOpen = fs.open
  const originalMkdir = fs.mkdir
  // Mutation after all source handles have been pinned, before the first read.
  vi.spyOn(fs, 'mkdir').mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
    if (String(args[0]) === join(f.directory, 'logs/resources')) {
      await fs.appendFile(path, record({ pid: 999 }))
      await rename(path, join(f.journal, 'incident-00000001.jsonl'))
    }
    return originalMkdir(...args)
  })
  const opened = vi.spyOn(fs, 'open').mockImplementation(originalOpen)
  const result = await exportResourceJournal(f.configRoot, f.directory)
  expect(result.partial).toBe(true)
  expect(opened).toHaveBeenCalled()
  expect(await readFile(join(f.directory, result.files[0]), 'utf8')).toBe(record())
})

it('rejects a linked journal directory without reading or altering its target', async () => {
  const f = await fixture()
  const outside = join(f.root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'incident-00000000.jsonl'), record())
  await rm(f.journal, { recursive: true })
  await symlink(outside, f.journal, process.platform === 'win32' ? 'junction' : 'dir')
  expect(await inspectResourceJournal(f.configRoot)).toMatchObject({ available: false })
  await expect(exportResourceJournal(f.configRoot, f.directory)).rejects.toThrow()
  expect(await readFile(join(outside, 'incident-00000000.jsonl'), 'utf8')).toBe(record())
})

it('uses exact file identities to reject replacement before reading a segment', async () => {
  const f = await fixture()
  const path = join(f.journal, 'incident-00000000.jsonl')
  await writeFile(path, record())
  const info = await fs.lstat(path, { bigint: true })
  const originalLstat = fs.lstat
  vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
    const result = await originalLstat(...args)
    if (String(args[0]) === path && typeof result.ino === 'bigint') {
      // Adjacent identities can compare equal after conversion to a double.
      Object.defineProperty(result, 'ino', { value: info.ino + 1n })
    }
    return result
  })
  const result = await exportResourceJournal(f.configRoot, f.directory)
  expect(result.partial).toBe(true)
  expect(result.files).toEqual([])
  expect(result.metadata.segments[0].status).toBe('failed')
  expect(result.metadata.readBytes).toBe(0)
})

it('exports more than the general 32 MiB budget while enforcing the independent 64 MiB limit with incidents first', async () => {
  const f = await fixture()
  const line = record()
  const segment = line.repeat(Math.floor((4 * 1024 * 1024) / Buffer.byteLength(line)))
  for (let i = 0; i < 17; i++) {
    const name = `${i < 8 ? 'incident' : 'live'}-${String(i).padStart(8, '0')}.jsonl`
    await writeFile(join(f.journal, name), segment)
  }
  const result = await runSessionDiagnosticWorker({
    ...f,
    scope: 'application',
    action: 'export',
    selectedItems: ['resource-logs']
  })
  expect(result).toMatchObject({ kind: 'archive', partial: true })
  const metadata = JSON.parse(
    await readFile(join(f.directory, 'content/logs/resources/metadata.json'), 'utf8')
  )
  expect(metadata.outputBytes).toBeGreaterThan(32 * 1024 * 1024)
  expect(metadata.outputBytes).toBeLessThanOrEqual(64 * 1024 * 1024)
  expect(metadata.readBytes).toBeLessThanOrEqual(64 * 1024 * 1024)
  expect(
    metadata.segments.slice(0, 8).every((item: { status: string }) => item.status === 'exported')
  ).toBe(true)
  expect(metadata.segments.at(-1).status).toBe('failed')
}, 30_000)
