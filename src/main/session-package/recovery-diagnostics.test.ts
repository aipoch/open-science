import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SessionPackageService } from './service'
import { SessionPackageDeletion } from './deletion'
import { initLogger, flushLogs } from '../logger'

const roots: string[] = []
afterEach(async () => {
  await flushLogs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const setup = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'package-recovery-diagnostics-'))
  roots.push(root)
  initLogger({ logDir: join(root, 'logs'), mirrorToConsole: false })
  return root
}
const log = async (root: string): Promise<{ data: Record<string, unknown> }[]> => {
  await flushLogs()
  return (await readFile(join(root, 'logs', 'main.log'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

it('summarizes recovered and retained import stages without logging their names', async () => {
  const root = await setup()
  const stages = join(root, 'session-package-imports')
  const healthy = join(stages, randomUUID())
  const invalid = join(stages, 'private-study')
  await mkdir(healthy, { recursive: true })
  await mkdir(invalid)
  const getClient = vi.fn(async () => {
    throw new Error('Unexpected database query')
  })
  const owner = new SessionPackageService({ storageRoot: root, getClient })
  await owner.recover()
  await expect(stat(healthy)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await stat(invalid)).isDirectory()).toBe(true)
  const records = await log(root)
  expect(records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        data: expect.objectContaining({
          operation: 'session-package.import-recovery',
          outcome: 'completed',
          inspected: 2,
          recovered: 1,
          retained: 1,
          failed: 1
        })
      })
    ])
  )
  expect(getClient).not.toHaveBeenCalled()
  expect(JSON.stringify(records)).not.toContain('private-study')
})

it('distinguishes conservative deletion retention from an unreadable journal', async () => {
  const root = await setup()
  const journals = join(root, 'session-package-cleanup')
  await mkdir(journals)
  const id = randomUUID()
  await writeFile(
    join(journals, `${id}.json`),
    JSON.stringify({
      schemaVersion: 1,
      importId: id,
      projectId: 'project',
      sessionId: 'session',
      identities: [],
      directories: [],
      retainOnly: true
    })
  )
  await writeFile(join(journals, 'private-study.json'), 'invalid-json')
  const getClient = vi.fn(async () => {
    throw new Error('Unexpected database query')
  })
  const owner = new SessionPackageDeletion({ configRoot: root, storageRoot: root, getClient })
  await owner.recover(new AbortController().signal)
  expect((await stat(join(journals, `${id}.json`))).isFile()).toBe(true)
  const records = await log(root)
  expect(records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        data: expect.objectContaining({
          operation: 'session-package.deletion-recovery',
          outcome: 'completed',
          inspected: 2,
          recovered: 0,
          retained: 2,
          failed: 1,
          unverifiedOwnership: 1
        })
      })
    ])
  )
  expect(getClient).not.toHaveBeenCalled()
  expect(JSON.stringify(records)).not.toContain('private-study')
})

it('records cancellation during the last deletion journal without changing best-effort recovery', async () => {
  const root = await setup()
  const journals = join(root, 'session-package-cleanup')
  await mkdir(journals)
  const id = randomUUID()
  const sessionId = `import-${randomUUID()}`
  await writeFile(
    join(journals, `${id}.json`),
    JSON.stringify({
      schemaVersion: 1,
      importId: id,
      projectId: 'project',
      sessionId,
      identities: [sessionId],
      directories: []
    })
  )
  const controller = new AbortController()
  const getClient = vi.fn(async () => {
    controller.abort(new Error('private-cancellation-cause'))
    throw controller.signal.reason
  })
  const owner = new SessionPackageDeletion({ configRoot: root, storageRoot: root, getClient })
  await expect(owner.recover(controller.signal)).resolves.toBeUndefined()
  expect(getClient).toHaveBeenCalledOnce()
  const records = await log(root)
  expect(records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        data: expect.objectContaining({
          operation: 'session-package.deletion-recovery',
          outcome: 'cancelled',
          inspected: 1,
          retained: 1
        })
      })
    ])
  )
  expect(records.some((record) => record.data?.outcome === 'completed')).toBe(false)
  expect(JSON.stringify(records)).not.toContain('private-cancellation-cause')
})
