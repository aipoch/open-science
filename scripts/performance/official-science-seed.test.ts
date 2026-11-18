import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { configureTestElectronHost } from '../../test/runtime-host'
import {
  prepareOfficialScienceSeed,
  summarizeOfficialSession,
  type OfficialScienceSource
} from './official-science-seed'
import { createRealisticSessionWorkload } from './realistic-session-workload'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))
await configureTestElectronHost(await import('electron'))

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('summarizes complete logical history without returning transcript content', () => {
  const workload = createRealisticSessionWorkload({ rounds: 1, toolOutputBytes: 65536 })
  const session = workload.batches.reduce(
    (current, batch) => batch.apply(current),
    workload.initialSession
  )
  const before = structuredClone(session)
  const summary = summarizeOfficialSession(session, '/tmp/official-science-summary')
  expect(summary).toMatchObject({
    messages: 4,
    messagesByRole: { user: 1, agent: 3 },
    toolActivities: 6,
    turnUsageOwners: 1,
    modelCalls: 7,
    currentUsageRuns: 1,
    frames: 1,
    branches: 1
  })
  expect(summary.canonicalBytes).toBeGreaterThan(summary.messageTextBytes)
  expect(summary.canonicalDigest).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(summary)).not.toContain(session.messages[0].content)
  expect(session).toEqual(before)
  expect(summarizeOfficialSession(before, '/tmp/official-science-summary')).toEqual(summary)
})

it('refuses an occupied data root before initializing any database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-official-seed-test-'))
  roots.push(root)
  await writeFile(join(root, 'keep.txt'), 'existing data')
  await expect(
    prepareOfficialScienceSeed({ id: 'invalid', path: '/missing.science' }, root)
  ).rejects.toThrow('empty regular directory')
  expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('existing data')
})

// Explicit local fixture only; CI never downloads public archives and does not require them.
// The optional report contains only the helper's metadata. A caller-provided root is retained
// for the benchmark driver to clone, and all actual application storage stays within that root.
it.skipIf(!process.env.OPEN_SCIENCE_OFFICIAL_SEED_SOURCE)(
  'prepares an official archive through inspect, import, fork and durable readback',
  async () => {
    const source = JSON.parse(
      process.env.OPEN_SCIENCE_OFFICIAL_SEED_SOURCE!
    ) as OfficialScienceSource
    const root =
      process.env.OPEN_SCIENCE_OFFICIAL_SEED_ROOT ??
      (await mkdtemp(join(tmpdir(), 'open-science-official-seed-')))
    if (!process.env.OPEN_SCIENCE_OFFICIAL_SEED_ROOT) roots.push(root)
    const result = await prepareOfficialScienceSeed(source, root)
    expect(result.archive.validation).toBe('passed')
    expect(result.imported.summary.messages).toBe(result.archive.preview.messageCount)
    expect(result.fork.summary.messages).toBe(result.imported.summary.messages)
    expect(result.fork.identity.sessionId).not.toBe(result.imported.identity.sessionId)
    expect(result.fork.summary.canonicalDigest).not.toBe(result.imported.summary.canonicalDigest)
    if (process.env.OPEN_SCIENCE_OFFICIAL_SEED_REPORT)
      await writeFile(
        process.env.OPEN_SCIENCE_OFFICIAL_SEED_REPORT,
        JSON.stringify(result, null, 2)
      )
  },
  120000
)
