import { createHash } from 'node:crypto'
import {
  appendFile,
  cp,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { configureTestElectronHost } from '../../../test/runtime-host'
import { prepareOfficialScienceSeed } from '../../../scripts/performance/official-science-seed'
import { createOfficialScienceContinuation } from '../../../scripts/performance/official-science-continuation'
import {
  createSessionFile,
  decodeSessionFile,
  type PersistedChatSession
} from '../../shared/session-persistence'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false }
}))

import { createProjectDbClient } from '../projects/prisma-client'
import { initDataRoot } from '../storage-root'
import { SessionProjectionRepository } from './projection'
import { SessionRepository } from './repository'
import { encodeSessionDataPaths } from './session-data-paths'

const phase = process.env.OPEN_SCIENCE_OFFICIAL_PHASE
const env = (key: string): string => {
  const value = process.env[`OPEN_SCIENCE_OFFICIAL_${key}`]
  if (!value) throw new Error(`Missing benchmark ${key}`)
  return value
}
type Identity = { projectId: string; sessionId: string }
type Seed = Awaited<ReturnType<typeof prepareOfficialScienceSeed>> & {
  hashes: { imported: string; fork: string }
}
type WriteSample = {
  kind: string
  saveMs: number
  runtimeProjectionMs: number
  bytes: number
  checkpoints: number
  backups: number
  byteKinds: Record<string, number>
}
type Endpoint = {
  identity: Identity
  digest: string
  canonicalBytes: number
  messages: number
  activities: number
  revision: number | undefined
}
type StorageSummary = {
  format: 'json' | 'journal'
  version: number
  journalVersion?: number
  checkpointVersion?: number
  records?: number
  recordVersions?: number[]
  recordEnvelopeKeys?: string[]
}
type Written = {
  id: string
  root: string
  imported: Endpoint & {
    sample: WriteSample
    sqliteRows: Seed['imported']['sqliteRows']
    sqliteDigest: string
    storage: StorageSummary
  }
  fork: Endpoint & {
    samples: WriteSample[]
    metadata: unknown
    sqliteRows: Seed['fork']['sqliteRows']
    sqliteDigest: string
    storage: StorageSummary
  }
  sessionFiles: Array<{ name: string; bytes: number }>
}

const digest = (value: unknown): string =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item
      )
    )
    .digest('hex')
const canonical = (
  session: PersistedChatSession,
  root: string
): ReturnType<typeof createSessionFile> => {
  // Data-root relocation changes readable absolute paths, not logical research history.
  // Use the public portable codec rather than erasing path-bearing evidence from comparison.
  const decoded = decodeSessionFile(
    JSON.parse(JSON.stringify(createSessionFile(encodeSessionDataPaths(session, root)))),
    {
      preserveRuntimeState: true
    }
  )
  if (decoded.status !== 'ok') throw new Error('Invalid benchmark Session')
  return createSessionFile(decoded.session)
}
const load = async (
  repository: SessionRepository,
  identity: Identity
): Promise<PersistedChatSession> => {
  const result = await repository.loadSessionWithDiagnostics(
    identity.projectId,
    identity.sessionId,
    {
      preserveRuntimeState: true,
      mode: 'read-only'
    }
  )
  if (result.status !== 'found') throw new Error(`History is unavailable: ${result.status}`)
  return result.session
}
const endpoint = (session: PersistedChatSession, root: string): Endpoint => ({
  identity: { projectId: session.projectId, sessionId: session.id },
  digest: digest(canonical(session, root)),
  canonicalBytes: Buffer.byteLength(JSON.stringify(canonical(session, root))),
  messages: session.conversationGraph!.messages.length,
  activities: session.conversationGraph!.activities.length,
  revision: session.revision
})
const sqliteDigest = async (client: PrismaClient, identity: Identity): Promise<string> => {
  const where = { sessionId: identity.sessionId }
  const [summary, turns, modelCalls, auxiliary, runs, artifacts] = await Promise.all([
    client.session.findUniqueOrThrow({ where: { id: identity.sessionId } }),
    client.sessionTurnUsage.findMany({ where, orderBy: { messageId: 'asc' } }),
    client.sessionModelCallUsage.findMany({ where, orderBy: { callId: 'asc' } }),
    client.sessionAuxiliaryTurnUsage.findMany({ where, orderBy: { eventId: 'asc' } }),
    client.sessionRun.findMany({ where, orderBy: { messageId: 'asc' } }),
    client.sessionArtifactRef.findMany({ where, orderBy: { artifactId: 'asc' } })
  ])
  // Physical-file hints necessarily differ between JSON snapshots and journal formats.
  // Keep every business field, including token values, attribution, revision and timestamps.
  const value = {
    summary: Object.fromEntries(
      Object.entries(summary).filter(
        ([key]) => key !== 'sourceByteLength' && key !== 'sourceMtimeMs'
      )
    ),
    turns,
    modelCalls,
    auxiliary,
    runs,
    artifacts
  }
  return digest(
    JSON.parse(
      JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? String(item) : item))
    )
  )
}
const storageSummary = async (root: string, identity: Identity): Promise<StorageSummary> => {
  const directory = join(root, 'sessions', identity.projectId)
  const primary = JSON.parse(await readFile(join(directory, `${identity.sessionId}.json`), 'utf8'))
  if (primary.version === 2) return { format: 'json', version: primary.version }
  expect(primary.version).toBe(3)
  for (const file of [primary.checkpointFile, primary.logFile]) {
    expect(typeof file).toBe('string')
    expect(basename(file)).toBe(file)
  }
  const checkpoint = JSON.parse(await readFile(join(directory, primary.checkpointFile), 'utf8'))
  const lines = (await readFile(join(directory, primary.logFile), 'utf8')).split('\n')
  expect(lines.pop()).toBe('')
  const records = lines.filter(Boolean).map((line) => JSON.parse(line))
  return {
    format: 'journal',
    version: primary.version,
    journalVersion: primary.journalVersion,
    checkpointVersion: checkpoint.version,
    records: records.length,
    recordVersions: [...new Set<number>(records.map((record) => record.version))].sort(),
    recordEnvelopeKeys: [...new Set(records.flatMap((record) => Object.keys(record)))].sort()
  }
}
const inventory = async (directory: string): Promise<Array<{ name: string; bytes: number }>> => {
  const items: Array<{ name: string; bytes: number }> = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      for (const child of await inventory(path))
        items.push({ name: `${entry.name}/${child.name}`, bytes: child.bytes })
    } else if (entry.isFile()) items.push({ name: entry.name, bytes: (await stat(path)).size })
    else throw new Error('Unexpected special file in isolated benchmark')
  }
  return items.sort((a, b) => a.name.localeCompare(b.name))
}
const writeReport = async (report: unknown): Promise<void> => {
  await writeFile(env('REPORT'), JSON.stringify(report, null, 2) + '\n')
}

it.skipIf(phase !== 'prepare')(
  'validates, imports and forks official archives into identical legacy seeds',
  async () => {
    const sources = JSON.parse(await readFile(env('SOURCES'), 'utf8')) as {
      cases: Array<{
        id: string
        path: string
        sha256: string
        bytes: number
        url: string
        page: string
      }>
    }
    const roots: string[] = []
    try {
      const seeds: Seed[] = []
      for (const source of sources.cases) {
        const root = await mkdtemp(join(tmpdir(), 'open-science-official-seed-'))
        roots.push(root)
        const seed = await prepareOfficialScienceSeed(source, root)
        initDataRoot(root)
        const repository = new SessionRepository(root)
        const imported = await load(repository, seed.imported.identity)
        const fork = await load(repository, seed.fork.identity)
        expect(imported.packageOrigin).toBeDefined()
        expect(fork.packageOrigin).toBeUndefined()
        // Preparation runs only in the untouched baseline: both sides clone these exact IDs/files.
        for (const session of [imported, fork]) {
          const primary = JSON.parse(
            await readFile(join(root, 'sessions', session.projectId, `${session.id}.json`), 'utf8')
          )
          expect(primary.version).toBe(2)
        }
        seeds.push({
          ...seed,
          hashes: {
            imported: digest(canonical(imported, root)),
            fork: digest(canonical(fork, root))
          }
        })
      }
      await writeReport({ phase, seeds })
      roots.length = 0
    } finally {
      for (const root of roots) await rm(root, { recursive: true, force: true })
    }
  },
  180_000
)

it.skipIf(phase !== 'write')(
  'measures migration and controlled continuation over real exported history',
  async () => {
    const input = JSON.parse(await readFile(env('INPUT'), 'utf8')) as { seeds: Seed[] }
    const roots: string[] = []
    const results: Written[] = []
    try {
      for (const seed of input.seeds) {
        const root = await mkdtemp(join(tmpdir(), 'open-science-official-run-'))
        roots.push(root)
        await cp(seed.root, root, { recursive: true, force: false })
        initDataRoot(root)
        const client = createProjectDbClient(root)
        try {
          await client.$connect()
          const projection = new SessionProjectionRepository(async () => client)
          let bytes = 0
          let checkpoints = 0
          let backups = 0
          let byteKinds: Record<string, number> = {}
          const account = (kind: string, size: number): void => {
            bytes += size
            byteKinds[kind] = (byteKinds[kind] ?? 0) + size
          }
          const dependencies = {
            journalDependencies: {
              appendFile: async (path: string, contents: string) => {
                await appendFile(path, contents, 'utf8')
                account('log', Buffer.byteLength(contents))
              }
            },
            renameFile: async (source: string, target: string) => {
              const size = (await stat(source)).size
              await rename(source, target)
              if (target.endsWith('.checkpoint')) {
                checkpoints++
                account('checkpoint', size)
              } else if (target.endsWith('.backup')) {
                backups++
                account('backup', size)
              } else account('snapshotOrManifest', size)
            }
          }
          const repository = new SessionRepository(root, dependencies, projection)
          // Verify projection correctness outside the timed save. Historical imported/fork usage
          // is inherited; only the new synthetic turn should become current local consumption.
          const sqliteRows = async (identity: Identity): Promise<Seed['fork']['sqliteRows']> => {
            const where = { sessionId: identity.sessionId }
            const [turns, modelCalls, runs, artifacts] = await Promise.all([
              client.sessionTurnUsage.count({ where }),
              client.sessionModelCallUsage.count({ where }),
              client.sessionRun.count({ where }),
              client.sessionArtifactRef.count({ where })
            ])
            return { turns, modelCalls, runs, artifacts }
          }
          const measure = async (
            session: PersistedChatSession,
            changed: PersistedChatSession,
            kind: string,
            runtimeProjectionMs = 0
          ): Promise<{ session: PersistedChatSession; sample: WriteSample }> => {
            bytes = 0
            checkpoints = 0
            backups = 0
            byteKinds = {}
            const start = performance.now()
            const saved = await repository.saveSession(changed, session.revision)
            const saveMs = performance.now() - start
            return {
              session: saved,
              sample: { kind, saveMs, runtimeProjectionMs, bytes, checkpoints, backups, byteKinds }
            }
          }
          const original = await load(repository, seed.imported.identity)
          expect(digest(canonical(original, root))).toBe(seed.hashes.imported)
          const renamedTitle = `${original.title} [storage benchmark]`
          const renamed = await measure(
            original,
            {
              ...original,
              title: renamedTitle,
              updatedAt: original.updatedAt + 1
            },
            'imported-title-first-save'
          )
          const before = canonical(original, root).session
          const after = canonical(renamed.session, root).session
          expect(after.title).toBe(renamedTitle)
          expect(after.updatedAt).toBe(before.updatedAt + 1)
          expect(after.revision).toBe((before.revision ?? 0) + 1)
          // Public normalization also advances the active branch timestamp with updatedAt.
          // Compare the entire intended document, including that existing derived behavior.
          expect(after).toEqual(
            canonical(
              {
                ...original,
                title: renamedTitle,
                updatedAt: original.updatedAt + 1,
                revision: (original.revision ?? 0) + 1
              },
              root
            ).session
          )
          const importedSqliteRows = await sqliteRows(seed.imported.identity)
          expect(importedSqliteRows).toEqual(seed.imported.sqliteRows)
          const importedSqliteDigest = await sqliteDigest(client, seed.imported.identity)

          let session = await load(repository, seed.fork.identity)
          expect(digest(canonical(session, root))).toBe(seed.hashes.fork)
          const originalSession = canonical(session, root).session
          const originalMessages = originalSession.conversationGraph!.messages
          const originalActivities = originalSession.conversationGraph!.activities
          const continuation = createOfficialScienceContinuation(session)
          const samples: WriteSample[] = []
          for (const batch of continuation.batches) {
            const start = performance.now()
            const changed = batch.apply(session)
            const runtimeProjectionMs = performance.now() - start
            const saved = await measure(session, changed, batch.kind, runtimeProjectionMs)
            session = saved.session
            samples.push(saved.sample)
          }
          expect(samples).toHaveLength(194)
          const completedSession = canonical(session, root).session
          const completed = completedSession.conversationGraph!
          expect(completedSession.artifacts).toEqual(originalSession.artifacts)
          expect(completed.activityGroups).toEqual(
            originalSession.conversationGraph!.activityGroups
          )
          expect(completedSession.forkOrigin).toEqual(originalSession.forkOrigin)
          expect(completed.messages).toHaveLength(originalMessages.length + 2)
          expect(completed.activities).toEqual(originalActivities)
          for (const message of originalMessages)
            expect(completed.messages.find(({ id }) => id === message.id)).toEqual(message)
          expect(await projection.pending()).toEqual([])
          const forkSqliteRows = await sqliteRows(seed.fork.identity)
          expect(forkSqliteRows).toEqual({
            turns: seed.fork.sqliteRows.turns + 1,
            modelCalls:
              seed.fork.sqliteRows.modelCalls + continuation.metadata.expectedAddedModelCalls,
            runs: seed.fork.sqliteRows.runs + 1,
            artifacts: seed.fork.sqliteRows.artifacts
          })
          results.push({
            id: seed.source.id,
            root,
            imported: {
              ...endpoint(renamed.session, root),
              sample: renamed.sample,
              sqliteRows: importedSqliteRows,
              sqliteDigest: importedSqliteDigest,
              storage: await storageSummary(root, seed.imported.identity)
            },
            fork: {
              ...endpoint(session, root),
              samples,
              metadata: continuation.metadata,
              sqliteRows: forkSqliteRows,
              sqliteDigest: await sqliteDigest(client, seed.fork.identity),
              storage: await storageSummary(root, seed.fork.identity)
            },
            sessionFiles: await inventory(join(root, 'sessions'))
          })
        } finally {
          await client.$disconnect()
        }
      }
      await writeReport({ phase, results })
      roots.length = 0
    } finally {
      for (const root of roots) await rm(root, { recursive: true, force: true })
    }
  },
  180_000
)

it.skipIf(phase !== 'read')(
  'verifies complete official history in a new process',
  async () => {
    const id = env('CASE')
    const stage = env('STAGE')
    const input = JSON.parse(await readFile(env('INPUT'), 'utf8')) as {
      seeds?: Seed[]
      results?: Written[]
    }
    let root: string
    let identity: Identity
    let expected: string
    let expectedSqliteDigest: string | undefined
    if (stage === 'legacy') {
      const seed = input.seeds!.find((item) => item.source.id === id)!
      root = seed.root
      identity = seed.imported.identity
      expected = seed.hashes.imported
    } else {
      const written = input.results!.find((item) => item.id === id)!
      const selected = stage === 'imported' ? written.imported : written.fork
      root = written.root
      identity = selected.identity
      expected = selected.digest
      expectedSqliteDigest = selected.sqliteDigest
    }
    initDataRoot(root)
    const start = performance.now()
    const session = await load(new SessionRepository(root), identity)
    const restoreMs = performance.now() - start
    const actual = endpoint(session, root)
    expect(actual.digest).toBe(expected)
    let actualSqliteDigest: string | undefined
    if (expectedSqliteDigest !== undefined) {
      const client = createProjectDbClient(root)
      try {
        await client.$connect()
        actualSqliteDigest = await sqliteDigest(client, identity)
        expect(actualSqliteDigest).toBe(expectedSqliteDigest)
      } finally {
        await client.$disconnect()
      }
    }
    await writeReport({
      phase,
      id,
      stage,
      restoreMs,
      ...actual,
      sqliteDigest: actualSqliteDigest,
      storage: await storageSummary(root, identity)
    })
  },
  60_000
)

it.skipIf(phase !== 'refuse-new')(
  'refuses a newer journal without changing any retained session file',
  async () => {
    const input = JSON.parse(await readFile(env('INPUT'), 'utf8')) as { results: Written[] }
    const scenario = input.results.find((item) => item.id === env('CASE'))!
    const identity = scenario.fork.identity
    expect(await storageSummary(scenario.root, identity)).toMatchObject({ journalVersion: 2 })
    const directory = join(scenario.root, 'sessions')
    const hashFiles = async (): Promise<Record<string, string>> =>
      Object.fromEntries(
        await Promise.all(
          (await inventory(directory)).map(async ({ name }) => [
            name,
            createHash('sha256')
              .update(await readFile(join(directory, name)))
              .digest('hex')
          ])
        )
      )
    const before = await hashFiles()
    initDataRoot(scenario.root)
    const loaded = await new SessionRepository(scenario.root).loadSessionWithDiagnostics(
      identity.projectId,
      identity.sessionId,
      { mode: 'read-only', preserveRuntimeState: true }
    )
    expect(loaded.status).toBe('unreadable')
    expect(await hashFiles()).toEqual(before)
    await writeReport({ phase, id: scenario.id, status: loaded.status, unchanged: true })
  },
  60_000
)

await configureTestElectronHost(await import('electron'))
