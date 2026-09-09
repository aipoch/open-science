import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { literatureItemInputSchema } from '../../shared/literature'
import type { LiteratureJob } from '../../shared/literature-jobs'
import * as durable from '../storage/durable-json-file'
import { LiteratureBatchJobJournal } from './batch-job-journal'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
async function fixture(): Promise<{ path: string; job: LiteratureJob }> {
  const directory = await mkdtemp(join(tmpdir(), 'literature-row-checkpoints-'))
  directories.push(directory)
  return {
    path: join(directory, 'jobs.json'),
    job: {
      id: randomUUID(),
      createdAt: 1,
      updatedAt: 1,
      mode: 'metadata',
      phase: 'search',
      state: 'running',
      rows: [
        {
          id: 'reference',
          checked: true,
          status: 'pending',
          item: {
            id: 'reference',
            metadataRevision: 1,
            createdAt: 1,
            updatedAt: 1,
            attachments: [],
            projectIds: [],
            collectionIds: [],
            item: literatureItemInputSchema.parse({
              itemType: 'journalArticle',
              title: 'A reference',
              abstract: 'a'.repeat(8000)
            })
          }
        }
      ]
    }
  }
}
it.each([1, 2] as const)(
  'retries an interrupted legacy journal migration without losing the version %s task',
  async (version) => {
    const { path, job } = await fixture()
    const legacy = version === 1 ? { version, jobs: [job] } : { version, jobIds: [job.id] }
    await writeFile(path, JSON.stringify(legacy))
    if (version === 2) {
      await mkdir(`${path}.d`)
      await writeFile(join(`${path}.d`, `${job.id}.json`), JSON.stringify(job))
    }
    const write = durable.writeDurableJsonFile
    const spy = vi
      .spyOn(durable, 'writeDurableJsonFile')
      .mockImplementation(async (target, ...args) => {
        if (target === path) throw new Error('index unavailable')
        return write(target, ...args)
      })
    await expect(new LiteratureBatchJobJournal(path).load()).rejects.toThrow('index unavailable')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(legacy)
    spy.mockRestore()
    await expect(new LiteratureBatchJobJournal(path).load()).resolves.toEqual([job])
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(3)
    const reopened = new LiteratureBatchJobJournal(path)
    const [restored] = await reopened.load()
    expect(restored.rows[0].item).toBeUndefined()
    await reopened.hydrate(restored)
    expect(restored).toEqual(job)
  }
)
it('recovers a committed row before the final task checkpoint, including its review choice', async () => {
  const { path, job } = await fixture()
  const journal = new LiteratureBatchJobJournal(path)
  await journal.save(job)
  await journal.saveIndex([job])
  job.rows[0].status = 'ready'
  job.rows[0].checked = false
  job.updatedAt = 2
  await journal.saveRow(job, job.rows[0])
  const reopened = new LiteratureBatchJobJournal(path)
  const [restored] = await reopened.load()
  expect(restored).toMatchObject({ updatedAt: 2, rows: [{ status: 'ready', checked: false }] })
  await reopened.hydrate(restored)
  expect(restored).toEqual(job)
})
it('does not publish part of a failed review command and keeps the last committed row', async () => {
  const { path, job } = await fixture()
  const journal = new LiteratureBatchJobJournal(path)
  await journal.save(job)
  await journal.saveIndex([job])
  job.rows[0].status = 'ready'
  job.updatedAt = 2
  await journal.saveRow(job, job.rows[0])
  const draft = structuredClone(job)
  draft.rows[0].checked = false
  draft.updatedAt = 3
  const write = durable.writeDurableJsonFile
  vi.spyOn(durable, 'writeDurableJsonFile').mockImplementation(async (target, ...args) => {
    if (target.endsWith('task.json')) throw new Error('header unavailable')
    return write(target, ...args)
  })
  await expect(journal.save(draft, false)).rejects.toThrow('header unavailable')
  const reopened = new LiteratureBatchJobJournal(path)
  const [restored] = await reopened.load()
  await reopened.hydrate(restored)
  expect(restored).toEqual(job)
})
it('reads summary controls without loading payloads and rejects a missing payload on detail access', async () => {
  const { path, job } = await fixture()
  const journal = new LiteratureBatchJobJournal(path)
  await journal.save(job)
  await journal.saveIndex([job])
  await rm(join(`${path}.d`, job.id, 'payloads'), { recursive: true })
  const reopened = new LiteratureBatchJobJournal(path)
  const [restored] = await reopened.load()
  expect(restored.rows[0]).toEqual({ id: 'reference', status: 'pending', checked: true })
  await expect(reopened.hydrate(restored)).rejects.toThrow('checkpoint is missing or invalid')
})

it('recovers a durable temporary row checkpoint before reading task controls', async () => {
  const { path, job } = await fixture()
  const journal = new LiteratureBatchJobJournal(path)
  await journal.save(job)
  await journal.saveIndex([job])
  const header = JSON.parse(await readFile(join(`${path}.d`, job.id, 'task.json'), 'utf8'))
  const directory = join(`${path}.d`, job.id, header.epoch)
  await mkdir(directory)
  await writeFile(
    join(directory, '0.json.123.tmp'),
    JSON.stringify({ updatedAt: 2, row: { ...header.rows[0], status: 'ready' } })
  )
  const [restored] = await new LiteratureBatchJobJournal(path).load()
  expect(restored.rows[0].status).toBe('ready')
  expect(restored.updatedAt).toBe(2)
  expect(JSON.parse(await readFile(join(directory, '0.json'), 'utf8')).row.status).toBe('ready')
})
it('prunes obsolete payloads only after publishing a replacement checkpoint', async () => {
  const { path, job } = await fixture()
  const journal = new LiteratureBatchJobJournal(path)
  await journal.save(job)
  await journal.saveIndex([job])
  const headerPath = join(`${path}.d`, job.id, 'task.json')
  const before = JSON.parse(await readFile(headerPath, 'utf8'))
  job.rows[0].item!.item.abstract = 'Replacement abstract'
  await journal.save(job)
  const after = JSON.parse(await readFile(headerPath, 'utf8'))
  expect(after.rows[0].payload).not.toBe(before.rows[0].payload)
  await expect(
    readFile(join(`${path}.d`, job.id, 'payloads', `${before.rows[0].payload}.json`))
  ).rejects.toMatchObject({ code: 'ENOENT' })
  const reopened = new LiteratureBatchJobJournal(path)
  const [restored] = await reopened.load()
  await reopened.hydrate(restored)
  expect(restored.rows[0].item!.item.abstract).toBe('Replacement abstract')
})

it('retries reviews atomically while retaining completed payloads and item snapshots', async () => {
  const { path, job } = await fixture()
  job.rows[0].status = 'ready'
  job.rows[0].metadata = {
    mode: 'preview',
    reviewVersion: 1,
    provider: 'crossref',
    sourceUrl: 'https://crossref.org',
    item: job.rows[0].item!,
    filled: [{ field: 'title', value: 'new title' }],
    conflicts: []
  }
  job.rows.push({ ...structuredClone(job.rows[0]), id: 'done', status: 'done' })
  const journal = new LiteratureBatchJobJournal(path)
  await journal.save(job)
  await journal.saveIndex([job])
  const headerPath = join(`${path}.d`, job.id, 'task.json')
  const before = JSON.parse(await readFile(headerPath, 'utf8'))
  const reopened = new LiteratureBatchJobJournal(path)
  const [draft] = await reopened.load()
  draft.rows[0].status = 'pending'
  const write = durable.writeDurableJsonFile
  const spy = vi
    .spyOn(durable, 'writeDurableJsonFile')
    .mockImplementation(async (target, ...args) => {
      if (target === headerPath) throw new Error('header unavailable')
      return write(target, ...args)
    })
  await expect(reopened.save(draft, false, true)).rejects.toThrow('header unavailable')
  expect(JSON.parse(await readFile(headerPath, 'utf8'))).toEqual(before)
  spy.mockRestore()
  await reopened.save(draft, false, true)
  const after = JSON.parse(await readFile(headerPath, 'utf8'))
  expect(after.rows[1].payload).toBe(before.rows[1].payload)
  const finalJournal = new LiteratureBatchJobJournal(path)
  const [restored] = await finalJournal.load()
  await finalJournal.hydrate(restored)
  expect(restored.rows[0].item).toEqual(job.rows[0].item)
  expect(restored.rows[0].metadata).toBeUndefined()
  expect(restored.rows[1]).toEqual(job.rows[1])
})
