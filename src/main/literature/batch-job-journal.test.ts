import { randomUUID } from 'node:crypto'
import { discoveryCheckpoints } from './discovery-adapters'

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { literatureItemInputSchema } from '@aipoch/literature-library/item'

import type { LiteratureJob } from '@aipoch/literature-discovery/jobs'

import { LiteratureBatchJobJournal } from '@aipoch/literature-discovery/checkpoints'

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

it('recovers a durable temporary row checkpoint before reading task controls', async () => {
  const { path, job } = await fixture()
  const journal = new LiteratureBatchJobJournal(path, discoveryCheckpoints)
  await journal.save(job)
  await journal.saveIndex([job])
  const header = JSON.parse(await readFile(join(`${path}.d`, job.id, 'task.json'), 'utf8'))
  const directory = join(`${path}.d`, job.id, header.epoch)
  await mkdir(directory)
  await writeFile(
    join(directory, '0.json.123.tmp'),
    JSON.stringify({ updatedAt: 2, row: { ...header.rows[0], status: 'ready' } })
  )
  const [restored] = await new LiteratureBatchJobJournal(path, discoveryCheckpoints).load()
  expect(restored.rows[0].status).toBe('ready')
  expect(restored.updatedAt).toBe(2)
  expect(JSON.parse(await readFile(join(directory, '0.json'), 'utf8')).row.status).toBe('ready')
})
