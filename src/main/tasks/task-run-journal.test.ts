import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FileTaskRunJournal, type TaskRunJournalEntry } from './task-run-journal'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const fixture = (): TaskRunJournalEntry => ({
  id: 'run-1',
  sessionId: 'session-1',
  projectId: 'project-1',
  cwd: tmpdir(),
  status: 'completed',
  startedAt: 1,
  completedAt: 2,
  artifacts: [],
  preferredComputeHostIds: []
})
const setup = async (): Promise<{ journal: FileTaskRunJournal; path: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'task-journal-'))
  roots.push(root)
  return { journal: new FileTaskRunJournal(root), path: join(root, 'task-runs.json') }
}

describe('Task Run journal validation', () => {
  it('roundtrips a valid run', async () => {
    const { journal } = await setup()
    await journal.replace([fixture()])
    await expect(journal.load()).resolves.toEqual([fixture()])
  })

  it.each([
    ['null artifact', { artifacts: [null] }],
    [
      'invalid artifact size',
      {
        artifacts: [
          {
            id: 'artifact-1',
            projectId: 'project-1',
            sessionId: 'session-1',
            name: 'result.txt',
            path: join(tmpdir(), 'result.txt'),
            fileUrl: 'file:///result.txt',
            size: -1,
            mtimeMs: 1
          }
        ]
      }
    ],
    ['missing approval plan', { attention: { kind: 'plan-approval' } }],
    ['invalid review flag', { review: { started: 'yes' } }],
    ['empty run identity', { id: '' }],
    ['empty session identity', { sessionId: ' ' }],
    ['empty project identity', { projectId: '' }],
    ['commit without prompt identity', { sessionCommitStatus: 'completed' }],
    ['invalid review outcome', { review: { started: true, outcome: 'unknown' } }]
  ])('rejects %s without replacing the original journal', async (_name, patch) => {
    const { journal, path } = await setup()
    const bytes = JSON.stringify({ version: 1, runs: [{ ...fixture(), ...patch }] })
    await writeFile(path, bytes)
    await expect.soft(journal.load()).rejects.toThrow(/journal/i)
    expect(await readFile(path, 'utf8')).toBe(bytes)
  })

  it('rejects duplicate run identities across sessions without replacing the journal', async () => {
    const { journal, path } = await setup()
    const bytes = JSON.stringify({
      version: 1,
      runs: [fixture(), { ...fixture(), sessionId: 'session-2', projectId: 'project-2' }]
    })
    await writeFile(path, bytes)
    await expect.soft(journal.load()).rejects.toThrow(/journal/i)
    expect(await readFile(path, 'utf8')).toBe(bytes)
  })

  it('roundtrips nested data and legacy optional fields without stripping compatible extensions', async () => {
    const { journal } = await setup()
    const run: TaskRunJournalEntry = {
      ...fixture(),
      artifacts: [
        {
          id: 'artifact',
          projectId: 'project-1',
          sessionId: 'session-1',
          name: 'result.txt',
          path: join(tmpdir(), 'result.txt'),
          fileUrl: 'file:///result.txt',
          size: 1,
          mtimeMs: 1
        }
      ],
      review: { started: true, id: 'review', lifecycle: 'complete', outcome: 'pass' },
      attention: {
        kind: 'plan-approval',
        plan: {
          artifactId: 'plan',
          artifactVersionId: 'version',
          artifactChecksum: 'checksum',
          revision: 0,
          approval: 'pending',
          lifecycle: 'awaiting_approval',
          document: {
            schema_version: 1,
            task_summary: 'Task',
            phases: [],
            desired_outputs: [],
            feasibility: { confidence: 'high', rationale: 'Ready' }
          },
          stepStatuses: { step: { status: 'completed', updatedAt: 1 } },
          stepStates: { step: { status: 'completed' } },
          counts: { phases: 0, delegations: 0, steps: 1, completed: 1, inProgress: 0 }
        }
      }
    }
    const extended = { ...run, compatibleExtension: 'keep' }
    await journal.replace([extended])
    await expect(journal.load()).resolves.toEqual([extended])
  })

  it.each(['nested corruption', 'future version'])(
    'blocks recovery of older temporary data when a candidate contains %s',
    async (kind) => {
      const { journal, path } = await setup()
      const older = `${path}.111.tmp`
      const newer = `${path}.222.tmp`
      const oldBytes = JSON.stringify({ version: 1, runs: [fixture()] })
      const badBytes = JSON.stringify({
        version: kind === 'future version' ? 2 : 1,
        runs: [{ ...fixture(), artifacts: [null] }]
      })
      await writeFile(older, oldBytes)
      await writeFile(newer, badBytes)
      await expect(journal.load()).rejects.toThrow(/journal/i)
      expect(await readFile(older, 'utf8')).toBe(oldBytes)
      expect(await readFile(newer, 'utf8')).toBe(badBytes)
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('rejects a future version and preserves its bytes', async () => {
    const { journal, path } = await setup()
    const bytes = JSON.stringify({ version: 2, runs: [fixture()] })
    await writeFile(path, bytes)
    await expect(journal.load()).rejects.toThrow(/Unsupported Task Run journal version/)
    expect(await readFile(path, 'utf8')).toBe(bytes)
  })
})
