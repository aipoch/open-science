import { createHash } from 'node:crypto'
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createRealisticSessionWorkload } from '../../../scripts/performance/realistic-session-workload'
import {
  createSessionFile,
  decodeSessionFile,
  type PersistedChatSession
} from '../../shared/session-persistence'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { initDataRoot } from '../storage-root'
import { SessionProjectionRepository } from './projection'
import { SessionRepository } from './repository'

// Opt-in: the driver runs identical source in independent baseline/candidate processes. Each
// process owns isolated synthetic data. No fsync, checkpoint or database operation is mocked.
const phase = process.env.OPEN_SCIENCE_REALISTIC_BENCHMARK_PHASE
const digest = (value: unknown): string =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([left], [right]) => left.localeCompare(right))
            )
          : item
      )
    )
    .digest('hex')
const canonicalHistory = (session: PersistedChatSession): ReturnType<typeof createSessionFile> => {
  // Recovery adds documented defaults and fixes object insertion order. Compare the complete
  // logical history under that same public codec, without silently dropping fields ad hoc.
  const decoded = decodeSessionFile(JSON.parse(JSON.stringify(createSessionFile(session))), {
    preserveRuntimeState: true
  })
  if (decoded.status !== 'ok') throw new Error('Synthetic history failed its public codec')
  return createSessionFile(decoded.session)
}
const scenarios = [
  { name: 'long-replies', replyBytes: 8 * 1024, toolOutputBytes: 8 * 1024 },
  { name: 'large-tool-results', replyBytes: 32 * 1024, toolOutputBytes: 64 * 1024 }
] as const

const fileInventory = async (
  directory: string
): Promise<Array<{ name: string; bytes: number }>> => {
  const files: Array<{ name: string; bytes: number }> = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      for (const child of await fileInventory(path)) {
        files.push({ name: `${entry.name}/${child.name}`, bytes: child.bytes })
      }
    } else if (entry.isFile()) {
      files.push({ name: entry.name, bytes: (await stat(path)).size })
    } else throw new Error('Unexpected non-regular benchmark data file')
  }
  return files.sort((left, right) => left.name.localeCompare(right.name))
}

type SaveSample = {
  batch: number
  round: number
  kind: string
  runtimeProjectionMs: number
  saveMs: number
  applicationWriteBytes: number
  checkpoint: boolean
}
type ScenarioResult = {
  name: string
  root: string
  projectId: string
  sessionId: string
  metadata: unknown
  initialSaveMs: number
  initialApplicationWriteBytes: number
  cumulativeApplicationWriteBytes: number
  checkpointPublications: number
  saveSamples: SaveSample[]
  finalCanonicalDigest: string
  finalCanonicalBytes: number
  finalRevision: number | undefined
  messageCount: number
  activityCount: number
  sqlRows: { turns: number; modelCalls: number; runs: number }
  sessionFiles: Array<{ name: string; bytes: number }>
  databaseFiles: Array<{ name: string; bytes: number }>
}

const reportPath = (): string => {
  const path = process.env.OPEN_SCIENCE_REALISTIC_BENCHMARK_REPORT
  if (!path) throw new Error('Benchmark report path is required')
  return path
}

it.skipIf(phase !== 'write')(
  'measures realistic session saves with SQLite',
  async () => {
    const results: ScenarioResult[] = []
    const retainedRoots: string[] = []
    try {
      for (const scenario of scenarios) {
        const workload = createRealisticSessionWorkload({ ...scenario, rounds: 15 })
        const root = await mkdtemp(join(tmpdir(), 'open-science-realistic-data-'))
        retainedRoots.push(root)
        initDataRoot(root)
        const client = createProjectDbClient(root)
        try {
          // Initialization is deliberately outside save timing; each run gets the same fresh DB.
          await migrateApplicationDatabase(client)
          await client.project.create({
            data: { id: workload.initialSession.projectId, name: 'Synthetic benchmark project' }
          })
          const projection = new SessionProjectionRepository(async () => client)
          let writtenBytes = 0
          let checkpointPublications = 0
          const dependencies = {
            journalDependencies: {
              appendFile: async (path: string, contents: string) => {
                await appendFile(path, contents, 'utf8')
                writtenBytes += Buffer.byteLength(contents)
              }
            },
            renameFile: async (source: string, target: string) => {
              writtenBytes += (await stat(source)).size
              await rename(source, target)
              if (target.endsWith('.checkpoint')) checkpointPublications++
            }
          }
          const repository = new SessionRepository(root, dependencies, projection)
          const initialStart = performance.now()
          let session = await repository.saveSession(workload.initialSession)
          const initialSaveMs = performance.now() - initialStart
          const initialApplicationWriteBytes = writtenBytes
          writtenBytes = 0
          checkpointPublications = 0
          const saveSamples: SaveSample[] = []
          for (const [index, batch] of workload.batches.entries()) {
            const projectionStart = performance.now()
            const changed = batch.apply(session)
            const runtimeProjectionMs = performance.now() - projectionStart
            const beforeBytes = writtenBytes
            const beforeCheckpoints = checkpointPublications
            const start = performance.now()
            session = await repository.saveSession(changed, session.revision)
            const saveMs = performance.now() - start
            saveSamples.push({
              batch: index + 1,
              round: batch.round,
              kind: batch.kind,
              runtimeProjectionMs,
              saveMs,
              applicationWriteBytes: writtenBytes - beforeBytes,
              checkpoint: checkpointPublications > beforeCheckpoints
            })
          }
          expect(await projection.pending()).toEqual([])
          const sqlRows = {
            turns: await client.sessionTurnUsage.count(),
            modelCalls: await client.sessionModelCallUsage.count(),
            runs: await client.sessionRun.count()
          }
          expect(sqlRows).toEqual({ turns: 15, modelCalls: 105, runs: 15 })
          expect(session.messages.filter((message) => message.role === 'user')).toHaveLength(15)
          expect(session.messages.filter((message) => message.role === 'agent')).toHaveLength(45)
          expect(session.conversationGraph?.activities).toHaveLength(90)
          expect(saveSamples).toHaveLength(495)
          const canonical = createSessionFile(session)
          // The driver reads this exact final state in fresh processes, then compares old/new hashes.
          const result: ScenarioResult = {
            name: scenario.name,
            root,
            projectId: session.projectId,
            sessionId: session.id,
            metadata: workload.metadata,
            initialSaveMs,
            initialApplicationWriteBytes,
            cumulativeApplicationWriteBytes: writtenBytes,
            checkpointPublications,
            saveSamples,
            finalCanonicalDigest: digest(canonicalHistory(session)),
            finalCanonicalBytes: Buffer.byteLength(JSON.stringify(canonical)),
            finalRevision: session.revision,
            messageCount: session.messages.length,
            activityCount: session.conversationGraph!.activities.length,
            sqlRows,
            sessionFiles: await fileInventory(join(root, 'sessions')),
            databaseFiles: (await fileInventory(root)).filter((file) =>
              file.name.startsWith('open-science.db')
            )
          }
          results.push(result)
        } finally {
          await client.$disconnect()
        }
      }
      await writeFile(reportPath(), JSON.stringify({ phase, results }, null, 2) + '\n')
      // Successful runs retain only synthetic roots for the driver's separate read processes.
      retainedRoots.length = 0
    } finally {
      await Promise.all(retainedRoots.map((root) => rm(root, { recursive: true, force: true })))
    }
  },
  180_000
)

it.skipIf(phase !== 'read')(
  'loads complete history in a fresh process and checks all contents',
  async () => {
    const inputPath = process.env.OPEN_SCIENCE_REALISTIC_BENCHMARK_INPUT
    if (!inputPath) throw new Error('Read phase needs the write phase report')
    const input = JSON.parse(await readFile(inputPath, 'utf8')) as { results: ScenarioResult[] }
    const results: Array<{
      name: string
      restoreMs: number
      finalCanonicalDigest: string
      summaryMs: number
    }> = []
    const selected = process.env.OPEN_SCIENCE_REALISTIC_BENCHMARK_SCENARIO
    for (const scenario of input.results.filter(
      (result) => !selected || result.name === selected
    )) {
      initDataRoot(scenario.root)
      const client = createProjectDbClient(scenario.root)
      try {
        // Establish the DB connection outside timings, as after application startup. Do not migrate.
        await client.$connect()
        const projection = new SessionProjectionRepository(async () => client)
        const repository = new SessionRepository(scenario.root, {}, projection)
        const start = performance.now()
        const restored = await repository.loadSessionWithDiagnostics(
          scenario.projectId,
          scenario.sessionId,
          { preserveRuntimeState: true }
        )
        const restoreMs = performance.now() - start
        expect(restored.status).toBe('found')
        if (restored.status !== 'found') throw new Error('Synthetic history could not be restored')
        const session: PersistedChatSession = restored.session
        const finalCanonicalDigest = digest(canonicalHistory(session))
        expect(finalCanonicalDigest).toBe(scenario.finalCanonicalDigest)
        expect(session.revision).toBe(scenario.finalRevision)
        expect(session.messages).toHaveLength(scenario.messageCount)
        expect(session.conversationGraph?.activities).toHaveLength(scenario.activityCount)
        const summaryStart = performance.now()
        const summaries = await projection.list()
        const summaryMs = performance.now() - summaryStart
        expect(summaries).toHaveLength(1)
        expect(summaries[0].id).toBe(scenario.sessionId)
        expect(summaries[0].revision).toBe(scenario.finalRevision)
        expect(await projection.pending()).toEqual([])
        results.push({ name: scenario.name, restoreMs, finalCanonicalDigest, summaryMs })
      } finally {
        await client.$disconnect()
      }
    }
    await writeFile(reportPath(), JSON.stringify({ phase, results }, null, 2) + '\n')
  },
  60_000
)
