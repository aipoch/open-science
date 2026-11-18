import { createHash } from 'node:crypto'
import { appendFile, cp, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { configureTestElectronHost } from '../../../test/runtime-host'
import type { prepareOfficialScienceSeed } from '../../../scripts/performance/official-science-seed'
import { createOfficialScienceContinuation } from '../../../scripts/performance/official-science-continuation'
import { createOfficialScienceFollowup } from '../../../scripts/performance/official-science-followups'
import type { OfficialScienceContinuationBatch } from '../../../scripts/performance/official-science-continuation'
import { getActiveConversationContext } from '../../shared/conversation-graph'
import * as sessionCodec from '../../shared/session-persistence'
import {
  createSessionFile,
  decodeSessionFile,
  type PersistedChatSession
} from '../../shared/session-persistence'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { initDataRoot } from '../storage-root'
import { SessionProjectionRepository } from './projection'
import { SessionRepository } from './repository'
import { RuntimeSessionOwner } from './runtime-session-owner'
import { SessionPersistenceStateOwner } from './state-owner'
import { encodeSessionDataPaths } from './session-data-paths'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const phase = process.env.OPEN_SCIENCE_RUNTIME_PHASE
const variant = process.env.OPEN_SCIENCE_RUNTIME_VARIANT
const env = (key: string): string => {
  const value = process.env[`OPEN_SCIENCE_RUNTIME_${key}`]
  if (!value) throw new Error(`Missing runtime benchmark ${key}`)
  return value
}
type Identity = { projectId: string; sessionId: string }
type Seed = Awaited<ReturnType<typeof prepareOfficialScienceSeed>> & {
  hashes: { imported: string; fork: string }
}
type WriteSample = {
  kind: string
  absoluteUserTurn?: number
  roundKind?: 'control' | 'template-followup'
  ownerMs: number
  repositorySaveMs: number
  commits: number
  fullCodecCalls?: number
  wireProbe?: {
    version: number
    recordTypes: string[]
    entityCollections: string[]
    textChunks: number
    textBytes: number
  }
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
  businessRecordTypes?: string[]
}
type SavedTurn = {
  absoluteUserTurn: number
  kind: 'control' | 'template-followup'
  sampleStart: number
  sampleEnd: number
  endpoint: Endpoint
  sqliteRows: Seed['fork']['sqliteRows']
  sqliteDigest: string
  metadata: unknown
  saveSummary: {
    commits: number
    ownerMs: number
    repositorySaveMs: number
    bytes: number
  }
  milestoneRoot?: string
}
type SavedFork = Endpoint & {
  samples: WriteSample[]
  metadata: unknown
  sqliteRows: Seed['fork']['sqliteRows']
  sqliteDigest: string
  storage: StorageSummary
  turns?: SavedTurn[]
}
type Written = {
  id: string
  root: string
  seedStorage: { format: 'json' | 'journal'; initializationBytes: number }
  imported: Endpoint & {
    sample: WriteSample
    sqliteRows: Seed['imported']['sqliteRows']
    sqliteDigest: string
    storage: StorageSummary
  }
  control?: SavedFork & { root: string }
  fork: SavedFork
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
  const path = join(root, 'sessions', identity.projectId, `${identity.sessionId}.jsonl`)
  const contents = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (contents === undefined) {
    const primary = JSON.parse(await readFile(path.slice(0, -1), 'utf8'))
    expect(primary.version).toBe(2)
    return { format: 'json', version: 2 }
  }
  const lines = contents.split('\n')
  expect(lines.pop()).toBe('')
  const records = lines.map((line) => JSON.parse(line))
  expect(Object.keys(records[0]).sort()).toEqual(['document', 'type'])
  expect(records[0].type).toBe('session_snapshot')
  for (const row of records.slice(1))
    expect(Object.keys(row).sort()).toEqual(['records', 'revision', 'type'])
  return {
    format: 'journal',
    version: 2,
    records: records.length,
    recordEnvelopeKeys: [...new Set(records.slice(1).flatMap((row) => Object.keys(row)))].sort(),
    businessRecordTypes: [
      ...new Set<string>(
        records.slice(1).flatMap((row) => row.records.map((item: { type: string }) => item.type))
      )
    ].sort()
  }
}

// Only the untimed probe reads each just-written line. Assert the real persisted wire against
// accepted input chunks, without importing a candidate-only codec into the older versions.
const probeBusinessRecord = async (
  root: string,
  identity: Identity,
  responseId: string,
  events: OfficialScienceContinuationBatch['events'],
  firstMessage: boolean
): Promise<WriteSample['wireProbe']> => {
  const directory = join(root, 'sessions', identity.projectId)
  const content = await readFile(join(directory, `${identity.sessionId}.jsonl`), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  )
  if (!content) return undefined
  const record = JSON.parse(content.trimEnd().split('\n').at(-1)!)
  expect(Object.keys(record).sort()).toEqual(['records', 'revision', 'type'])
  expect(record.type).toBe('session_update')
  const entries = (record.records ?? []) as Array<{
    type: string
    collection?: string
    messageId?: string
    upserts?: Array<{ id: string }>
    chunks?: Array<{ eventId: string; text: string; timestamp: number }>
  }>
  const text = entries.filter(({ type }) => type === 'assistant_text_received')
  const entityCollections = entries
    .filter(
      ({ type, upserts }) => type === 'entities' && upserts?.some(({ id }) => id === responseId)
    )
    .map(({ collection }) => collection!)
    .sort()
  if (events[0]?.kind === 'message' && !firstMessage) {
    expect(text).toHaveLength(1)
    expect(text[0].messageId).toBe(responseId)
    expect(text[0].chunks).toEqual(
      events.map(({ id, text, timestamp }) => ({ eventId: id, text, timestamp }))
    )
    expect(entityCollections).not.toContain('messages')
    expect(entityCollections).not.toContain('graphMessages')
  } else {
    expect(text).toHaveLength(0)
    expect(entityCollections).toContain('messages')
    expect(entityCollections).toContain('graphMessages')
  }
  const chunks = text.flatMap(({ chunks }) => chunks ?? [])
  return {
    version: 0,
    recordTypes: entries.map(({ type }) => type),
    entityCollections,
    textChunks: chunks.length,
    textBytes: chunks.reduce((sum, { text }) => sum + Buffer.byteLength(text), 0)
  }
}

const writeReport = async (report: unknown): Promise<void> => {
  await writeFile(env('REPORT'), JSON.stringify(report, null, 2) + '\n')
}

it.skipIf(phase !== 'write' && phase !== 'probe')(
  'measures real RuntimeSessionOwner commits over unchanged official history',
  async () => {
    const input = JSON.parse(await readFile(env('INPUT'), 'utf8')) as { seeds: Seed[] }
    const roots: string[] = []
    const results: Written[] = []
    const probe = phase === 'probe'
    const targetTurnsText = process.env.OPEN_SCIENCE_RUNTIME_TARGET_TURNS
    const targetTurns = targetTurnsText === undefined ? undefined : Number(targetTurnsText)
    if (targetTurns !== undefined && (!Number.isSafeInteger(targetTurns) || targetTurns < 1))
      throw new Error('Invalid runtime benchmark target turn count')
    // Spies exist only in the separate untimed probe process. Timed runs retain real calls
    // without spying on the full codec or the optimized helper.
    const fullCodec = probe ? vi.spyOn(sessionCodec, 'createSessionFile') : undefined
    try {
      for (const seed of input.seeds) {
        const root = await mkdtemp(join(tmpdir(), 'open-science-runtime-run-'))
        roots.push(root)
        await cp(seed.root, root, { recursive: true, force: false })
        // Only benchmark-owned copies change format. Keep every business field and revision
        // identical across variants. This builds a new-format fixture, not a product migration;
        // initial publication/import time and bytes are excluded from the measured continuation.
        let initializationBytes = 0
        if (variant === 'current-jsonl') {
          for (const identity of [seed.imported.identity, seed.fork.identity]) {
            const path = join(root, 'sessions', identity.projectId, `${identity.sessionId}.json`)
            const document: unknown = JSON.parse(await readFile(path, 'utf8'))
            const contents = JSON.stringify({ type: 'session_snapshot', document }) + '\n'
            await writeFile(`${path}l`, contents, { encoding: 'utf8', flag: 'wx' })
            await rm(path)
            initializationBytes += Buffer.byteLength(contents)
            expect((await storageSummary(root, identity)).records).toBe(1)
            for (const absent of [
              path,
              path.replace(/\.json$/, '.legacy-json.backup'),
              `${path}l.checkpoint`
            ])
              await expect(stat(absent)).rejects.toMatchObject({ code: 'ENOENT' })
          }
        }
        initDataRoot(root)
        const client = createProjectDbClient(root)
        try {
          await client.$connect()
          await migrateApplicationDatabase(client)
          const projection = new SessionProjectionRepository(async () => client)
          let bytes = 0
          let checkpoints = 0
          let backups = 0
          let byteKinds: Record<string, number> = {}
          const account = (kind: string, size: number): void => {
            bytes += size
            byteKinds[kind] = (byteKinds[kind] ?? 0) + size
          }
          const repository = new SessionRepository(
            root,
            {
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
            },
            projection
          )
          let repositorySaveMs = 0
          let commits = 0
          const save = repository.saveSession.bind(repository)
          // This common wrapper forwards the old 2-argument and new 3-argument interfaces
          // verbatim. It does not construct runtime hints or replace a version's production owner.
          repository.saveSession = async (...args: Parameters<typeof save>) => {
            const start = performance.now()
            const saved = await save(...args)
            repositorySaveMs += performance.now() - start
            commits++
            return saved
          }
          const measure = async (
            kind: string,
            commit: () => Promise<PersistedChatSession>
          ): Promise<{ session: PersistedChatSession; sample: WriteSample }> => {
            bytes = 0
            checkpoints = 0
            backups = 0
            byteKinds = {}
            repositorySaveMs = 0
            commits = 0
            const calls = fullCodec?.mock.calls.length ?? 0
            const start = performance.now()
            const session = await commit()
            const ownerMs = performance.now() - start
            return {
              session,
              sample: {
                kind,
                ownerMs,
                repositorySaveMs,
                commits,
                bytes,
                checkpoints,
                backups,
                byteKinds,
                ...(fullCodec ? { fullCodecCalls: fullCodec.mock.calls.length - calls } : {})
              }
            }
          }
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
          // Preserve the established imported-title control and its complete history checks.
          const original = await load(repository, seed.imported.identity)
          expect(digest(canonical(original, root))).toBe(seed.hashes.imported)
          const renamedTitle = `${original.title} [storage benchmark]`
          const renamed = await measure('imported-title-first-save', () =>
            repository.saveSession(
              {
                ...original,
                title: renamedTitle,
                updatedAt: original.updatedAt + 1
              },
              original.revision
            )
          )
          expect(canonical(renamed.session, root).session).toEqual(
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

          let session = await load(repository, seed.fork.identity)
          expect(digest(canonical(session, root))).toBe(seed.hashes.fork)
          const originalSession = canonical(session, root).session
          const originalMessages = originalSession.conversationGraph!.messages
          const originalActivities = originalSession.conversationGraph!.activities
          const originalUserTurns = originalMessages.filter(({ role }) => role === 'user').length
          if (targetTurns !== undefined && targetTurns < originalUserTurns + 1)
            throw new Error('Target turns cannot precede the preserved control continuation')
          const continuation = createOfficialScienceContinuation(session)
          const [prompt, ...continuationBatches] = continuation.batches
          const samples: WriteSample[] = []
          const admittedPrompt = await measure('prompt', () =>
            repository.saveSession(prompt.apply(session), session.revision)
          )
          session = admittedPrompt.session
          samples.push(admittedPrompt.sample)
          const scope = {
            ...getActiveConversationContext(
              session.conversationGraph!,
              continuation.metadata.promptMessageId
            ),
            projectId: session.projectId,
            sessionId: session.id,
            executionId: 'official-science-runtime-benchmark:execution'
          }
          const stateOwner = new SessionPersistenceStateOwner({
            repository,
            fileIndex: { syncSession: async () => [] },
            assertMutable: () => {},
            notifyFilesChanged: () => {},
            notifyRuntimeContextSessionUpdated: () => {},
            log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
          })
          let latestCommitted = session
          let runtimeNow = continuation.metadata.startedAt
          const owner = new RuntimeSessionOwner({
            loadSession: async () => load(repository, seed.fork.identity),
            mutateSession: (...args) => stateOwner.mutateRuntimeSession(...args),
            finalizeArtifacts: async () => [],
            onCommitted: (committed) => {
              latestCommitted = committed
            },
            scheduleFlush: () => () => {},
            now: () => runtimeNow
          })
          const admission = await measure('admission', () => owner.begin(scope))
          session = admission.session
          latestCommitted = session
          samples.push(admission.sample)
          // Preserve all input chunks and timestamps. By default four 500ms batches share
          // one flush (the original Main 2s interval). An explicit larger group bounds a smoke
          // run's disk writes; report its interval instead of treating it as production timing.
          const inputMessageBatches = continuationBatches.filter(({ kind }) => kind === 'message')
          const batchesPerFlush = Number(process.env.OPEN_SCIENCE_RUNTIME_BATCHES_PER_FLUSH ?? 4)
          if (
            !Number.isSafeInteger(batchesPerFlush) ||
            batchesPerFlush < 1 ||
            inputMessageBatches.length % batchesPerFlush !== 0
          )
            throw new Error('Flush batch count must be a positive divisor of the input batches')
          const flushIntervalMs = batchesPerFlush * continuation.metadata.batchIntervalMs
          const groupedBatches: Array<
            Pick<OfficialScienceContinuationBatch, 'kind' | 'virtualTimeMs' | 'events'>
          > = []
          for (let index = 0; index < inputMessageBatches.length; index += batchesPerFlush) {
            const group = inputMessageBatches.slice(index, index + batchesPerFlush)
            expect(group).toHaveLength(batchesPerFlush)
            groupedBatches.push({
              kind: 'message',
              virtualTimeMs: group.at(-1)!.virtualTimeMs,
              events: group.flatMap(({ events }) => events)
            })
          }
          expect(groupedBatches).toHaveLength(inputMessageBatches.length / batchesPerFlush)
          expect(groupedBatches.flatMap(({ events }) => events)).toEqual(
            inputMessageBatches.flatMap(({ events }) => events)
          )
          const terminalBatch = continuationBatches.at(-1)!
          expect(terminalBatch.kind).toBe('terminal')
          const batches = probe
            ? [...groupedBatches.slice(0, 2), terminalBatch]
            : [...groupedBatches, terminalBatch]
          let terminalPublications = 0
          for (const batch of batches) {
            const saved = await measure(batch.kind, async () => {
              if (batch.kind === 'terminal') {
                expect(batch.events).toHaveLength(1)
                await owner.commitTerminal(batch.events[0], () => {
                  terminalPublications++
                })
                // Wait for physical completion even if the terminal's UI deadline elapsed.
                await owner.flush(scope.sessionId, scope.promptMessageId)
                await owner.retryTerminalCommitNow(
                  scope.sessionId,
                  scope.promptMessageId,
                  scope.executionId
                )
                return latestCommitted
              }
              for (const event of batch.events) owner.accept(event)
              const committed = await owner.flush(scope.sessionId, scope.promptMessageId)
              if (!committed) throw new Error('Runtime batch did not commit')
              return committed
            })
            session = saved.session
            samples.push(saved.sample)
            expect(saved.sample.commits).toBe(1)
            if (probe)
              saved.sample.wireProbe = await probeBusinessRecord(
                root,
                seed.fork.identity,
                continuation.metadata.responseMessageId,
                batch.events,
                samples.filter(({ kind }) => kind === 'message').length === 1
              )
          }
          expect(terminalPublications).toBe(1)
          expect(samples).toHaveLength(batches.length + 2)
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
          expect(completedSession.status).toBe('idle')
          expect(completedSession.activeRun).toBeUndefined()
          expect(completedSession.runtimeTranscriptOwner).toBe('main')
          expect(completedSession.runtimeTranscriptLastRun).toEqual({
            promptMessageId: continuation.metadata.promptMessageId,
            startedAt: continuation.metadata.startedAt
          })
          const expectedReply = batches
            .filter(({ kind }) => kind === 'message')
            .flatMap(({ events }) => events)
            .map(({ text }) => text ?? '')
            .join('')
          const response = completed.messages.find(
            ({ id }) => id === continuation.metadata.responseMessageId
          )!
          expect(response.content).toBe(expectedReply)
          expect(response.status).toBe('complete')
          expect(response.turnUsage).toEqual(batches.at(-1)!.events[0].turnUsage)
          if (!probe)
            expect(Buffer.byteLength(response.content)).toBe(continuation.metadata.replyBytes)
          expect(await projection.pending()).toEqual([])
          let forkSqliteRows = await sqliteRows(seed.fork.identity)
          expect(forkSqliteRows).toEqual({
            turns: seed.fork.sqliteRows.turns + 1,
            modelCalls:
              seed.fork.sqliteRows.modelCalls + continuation.metadata.expectedAddedModelCalls,
            runs: seed.fork.sqliteRows.runs + 1,
            artifacts: seed.fork.sqliteRows.artifacts
          })
          const controlMetadata = {
            ...continuation.metadata,
            probe,
            admissionCommits: 1,
            flushIntervalMs,
            batchesPerFlush,
            processedMessageCommits: batches.filter(({ kind }) => kind === 'message').length,
            processedMessageInputBatches:
              batches.filter(({ kind }) => kind === 'message').length * batchesPerFlush,
            processedMessageEvents: batches
              .filter(({ kind }) => kind === 'message')
              .reduce((count, batch) => count + batch.events.length, 0)
          }
          let control: Written['control']
          const turns: SavedTurn[] = []
          if (targetTurns !== undefined) {
            // Keep the existing control continuation intact. Only this opt-in mode appends more
            // turns, reusing the same owner, repository and original sample as its fixed template.
            const cloneMilestone = async (turnNumber: number): Promise<string> => {
              expect(await projection.pending()).toEqual([])
              const checkpoint = await client.$queryRawUnsafe<Array<{ busy: number | bigint }>>(
                'PRAGMA wal_checkpoint(FULL)'
              )
              expect(checkpoint).toHaveLength(1)
              expect(Number(checkpoint[0].busy)).toBe(0)
              const milestoneRoot = await mkdtemp(
                join(tmpdir(), `open-science-runtime-turn-${turnNumber}-`)
              )
              roots.push(milestoneRoot)
              // No mutations run while copying. The checkpointed DB and any retained WAL form
              // the same settled state; copying and all verification are outside save timings.
              await cp(root, milestoneRoot, { recursive: true, force: false })
              return milestoneRoot
            }
            const recordTurn = async (
              absoluteUserTurn: number,
              kind: SavedTurn['kind'],
              sampleStart: number,
              metadata: unknown,
              milestone: boolean
            ): Promise<SavedTurn> => {
              const turnSamples = samples.slice(sampleStart)
              const saved: SavedTurn = {
                absoluteUserTurn,
                kind,
                sampleStart,
                sampleEnd: samples.length,
                endpoint: endpoint(session, root),
                sqliteRows: await sqliteRows(seed.fork.identity),
                sqliteDigest: await sqliteDigest(client, seed.fork.identity),
                metadata,
                saveSummary: {
                  commits: turnSamples.reduce((sum, sample) => sum + sample.commits, 0),
                  ownerMs: turnSamples.reduce((sum, sample) => sum + sample.ownerMs, 0),
                  repositorySaveMs: turnSamples.reduce(
                    (sum, sample) => sum + sample.repositorySaveMs,
                    0
                  ),
                  bytes: turnSamples.reduce((sum, sample) => sum + sample.bytes, 0)
                },
                ...(milestone ? { milestoneRoot: await cloneMilestone(absoluteUserTurn) } : {})
              }
              turns.push(saved)
              return saved
            }
            for (const sample of samples) {
              sample.absoluteUserTurn = originalUserTurns + 1
              sample.roundKind = 'control'
            }
            const controlTurn = await recordTurn(
              originalUserTurns + 1,
              'control',
              0,
              controlMetadata,
              true
            )
            control = {
              root: controlTurn.milestoneRoot!,
              ...controlTurn.endpoint,
              samples: samples.slice(),
              metadata: controlMetadata,
              sqliteRows: controlTurn.sqliteRows,
              sqliteDigest: controlTurn.sqliteDigest,
              storage: await storageSummary(root, seed.fork.identity)
            }
            for (
              let absoluteUserTurn = originalUserTurns + 2;
              absoluteUserTurn <= targetTurns;
              absoluteUserTurn++
            ) {
              const before = canonical(session, root).session
              const previousRows = await sqliteRows(seed.fork.identity)
              const followup = createOfficialScienceFollowup(session, {
                templateSession: originalSession,
                turnNumber: absoluteUserTurn
              })
              const [nextPrompt, ...runtimeBatches] = followup.batches
              expect(nextPrompt.kind).toBe('prompt')
              const sampleStart = samples.length
              const collect = (sample: WriteSample): void => {
                sample.absoluteUserTurn = absoluteUserTurn
                sample.roundKind = 'template-followup'
                samples.push(sample)
                expect(sample.commits).toBe(1)
              }
              const prompted = await measure('prompt', () =>
                repository.saveSession(nextPrompt.apply(session), session.revision)
              )
              session = prompted.session
              latestCommitted = session
              collect(prompted.sample)
              runtimeNow = followup.metadata.startedAt
              const nextScope = {
                ...getActiveConversationContext(
                  session.conversationGraph!,
                  followup.metadata.promptMessageId
                ),
                projectId: session.projectId,
                sessionId: session.id,
                executionId: `official-science-runtime-benchmark:execution:${absoluteUserTurn}`
              }
              const nextAdmission = await measure('admission', () => owner.begin(nextScope))
              session = nextAdmission.session
              latestCommitted = session
              collect(nextAdmission.sample)
              const nextTerminal = runtimeBatches.at(-1)!
              expect(nextTerminal.kind).toBe('terminal')
              const inputBatches = runtimeBatches.slice(0, -1)
              const grouped = [] as Array<{
                kind: string
                events: (typeof runtimeBatches)[number]['events']
              }>
              for (let index = 0; index < inputBatches.length; index += batchesPerFlush) {
                const group = inputBatches.slice(index, index + batchesPerFlush)
                grouped.push({
                  kind: group.every(({ kind }) => kind === 'message') ? 'message' : 'tool',
                  events: group.flatMap(({ events }) => events)
                })
              }
              expect(grouped.flatMap(({ events }) => events)).toEqual(
                inputBatches.flatMap(({ events }) => events)
              )
              let publications = 0
              for (const batch of [...grouped, nextTerminal]) {
                const saved = await measure(batch.kind, async () => {
                  if (batch.kind === 'terminal') {
                    expect(batch.events).toHaveLength(1)
                    await owner.commitTerminal(batch.events[0], () => {
                      publications++
                    })
                    await owner.flush(nextScope.sessionId, nextScope.promptMessageId)
                    await owner.retryTerminalCommitNow(
                      nextScope.sessionId,
                      nextScope.promptMessageId,
                      nextScope.executionId
                    )
                    return latestCommitted
                  }
                  for (const event of batch.events) owner.accept(event)
                  const committed = await owner.flush(
                    nextScope.sessionId,
                    nextScope.promptMessageId
                  )
                  if (!committed) throw new Error('Follow-up runtime batch did not commit')
                  return committed
                })
                session = saved.session
                collect(saved.sample)
              }
              expect(publications).toBe(1)
              const after = canonical(session, root).session
              const beforeGraph = before.conversationGraph!
              const afterGraph = after.conversationGraph!
              expect(afterGraph.messages.filter(({ role }) => role === 'user')).toHaveLength(
                absoluteUserTurn
              )
              expect(afterGraph.messages).toHaveLength(
                beforeGraph.messages.length +
                  followup.metadata.expectedAddedUserMessages +
                  followup.metadata.expectedAddedAgentMessages
              )
              expect(afterGraph.activities).toHaveLength(
                beforeGraph.activities.length + followup.metadata.expectedAddedToolActivities
              )
              for (const message of beforeGraph.messages)
                expect(afterGraph.messages.find(({ id }) => id === message.id)).toEqual(message)
              for (const activity of beforeGraph.activities)
                expect(afterGraph.activities.find(({ id }) => id === activity.id)).toEqual(activity)
              for (const group of beforeGraph.activityGroups)
                expect(afterGraph.activityGroups.find(({ id }) => id === group.id)).toEqual(group)
              expect(after.artifacts).toEqual(before.artifacts)
              expect(after.forkOrigin).toEqual(before.forkOrigin)
              expect(new Set(afterGraph.messages.map(({ id }) => id)).size).toBe(
                afterGraph.messages.length
              )
              expect(new Set(afterGraph.activities.map(({ id }) => id)).size).toBe(
                afterGraph.activities.length
              )
              for (const message of followup.expected.messages)
                expect(afterGraph.messages.find(({ id }) => id === message.id)).toMatchObject(
                  message
                )
              for (const activity of followup.expected.tools) {
                const actual = afterGraph.activities.find(({ id }) => id === activity.id)
                expect(actual).toBeDefined()
                // JSON omits undefined optional fields. Compare every expected value, including
                // absence, without requiring an explicit undefined property in durable JSON.
                for (const [key, value] of Object.entries(activity))
                  expect(Reflect.get(actual!, key)).toEqual(value)
              }
              expect(after.status).toBe('idle')
              expect(after.activeRun).toBeUndefined()
              expect(after.runtimeTranscriptLastRun).toEqual({
                promptMessageId: followup.metadata.promptMessageId,
                startedAt: followup.metadata.startedAt
              })
              expect(await projection.pending()).toEqual([])
              forkSqliteRows = await sqliteRows(seed.fork.identity)
              expect(forkSqliteRows).toEqual({
                turns: previousRows.turns + 1,
                modelCalls: previousRows.modelCalls + followup.metadata.expectedAddedModelCalls,
                runs: previousRows.runs + 1,
                artifacts: previousRows.artifacts
              })
              await recordTurn(
                absoluteUserTurn,
                'template-followup',
                sampleStart,
                {
                  ...followup.metadata,
                  flushIntervalMs,
                  batchesPerFlush,
                  processedRuntimeCommits: grouped.length,
                  processedRuntimeInputBatches: inputBatches.length,
                  processedRuntimeEvents: inputBatches.reduce(
                    (count, batch) => count + batch.events.length,
                    0
                  ),
                  preservedPriorMessages: beforeGraph.messages.length,
                  preservedPriorActivities: beforeGraph.activities.length
                },
                absoluteUserTurn === targetTurns
              )
            }
          }
          if (variant === 'current-legacy-json') {
            for (const identity of [seed.imported.identity, seed.fork.identity]) {
              expect((await storageSummary(root, identity)).format).toBe('json')
              for (const table of ['SessionHistoryIndex', 'SessionHistoryItem']) {
                const rows = await client.$queryRawUnsafe<Array<{ count: number }>>(
                  `SELECT COUNT(*) AS count FROM ${table} WHERE sessionId = ?`,
                  identity.sessionId
                )
                expect(Number(rows[0].count)).toBe(0)
              }
            }
          }
          results.push({
            id: seed.source.id,
            root,
            seedStorage: {
              format: variant === 'current-jsonl' ? 'journal' : 'json',
              initializationBytes
            },
            imported: {
              ...endpoint(renamed.session, root),
              sample: renamed.sample,
              sqliteRows: importedSqliteRows,
              sqliteDigest: await sqliteDigest(client, seed.imported.identity),
              storage: await storageSummary(root, seed.imported.identity)
            },
            ...(control ? { control } : {}),
            fork: {
              ...endpoint(session, root),
              samples,
              metadata:
                targetTurns === undefined
                  ? controlMetadata
                  : {
                      ...controlMetadata,
                      targetTurns,
                      originalUserTurns,
                      completedUserTurns: targetTurns,
                      additionalTemplateTurns: turns.length - 1
                    },
              ...(targetTurns === undefined ? {} : { turns }),
              sqliteRows: forkSqliteRows,
              sqliteDigest: await sqliteDigest(client, seed.fork.identity),
              storage: await storageSummary(root, seed.fork.identity)
            }
          })
        } finally {
          await client.$disconnect()
        }
      }
      await writeReport({ phase, results })
      roots.length = 0
    } finally {
      fullCodec?.mockRestore()
      for (const root of roots) await rm(root, { recursive: true, force: true })
    }
  },
  300_000
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

type DisplayPage = {
  session: PersistedChatSession
  totalItems: number
  hasMore: boolean
  beforeCursor?: string
  complete?: boolean
}

// Independent display oracle over the complete decoded transcript. User prompts carried as
// context do not consume the 80 message/tool slots; tools are never split into output fragments.
const createDisplayPager = (full: PersistedChatSession): ((before?: number) => DisplayPage) => {
  const groupByActivity = new Map(
    (full.activityGroups ?? []).flatMap((group) =>
      group.activityIds.map((id) => [id, group.id] as const)
    )
  )
  const canonicalPrompts = new Map(
    full.conversationGraph?.activities.map((item) => [item.id, item.promptMessageId])
  )
  let latestPrompt: string | undefined
  const messagePrompts = new Map<string, string>()
  for (const message of full.messages) {
    if (message.role === 'user') latestPrompt = message.id
    else if (message.responseToMessageId ?? latestPrompt)
      messagePrompts.set(message.id, (message.responseToMessageId ?? latestPrompt)!)
  }
  const ordered = [
    ...full.messages.map((item, index) => ({
      kind: 'message' as const,
      item,
      sortIndex: index,
      prompt: messagePrompts.get(item.id),
      group: undefined as string | undefined
    })),
    ...(full.activities ?? []).map((item) => ({
      kind: 'activity' as const,
      item,
      sortIndex: item.sortIndex,
      prompt: canonicalPrompts.get(item.id) ?? item.promptMessageId,
      group: item.activityGroupId ?? groupByActivity.get(item.id)
    }))
  ].sort(
    (a, b) =>
      a.item.createdAt - b.item.createdAt ||
      a.sortIndex - b.sortIndex ||
      a.item.id.localeCompare(b.item.id)
  )
  latestPrompt = undefined
  for (const row of ordered) {
    if (row.kind === 'message' && 'role' in row.item && row.item.role === 'user')
      latestPrompt = row.item.id
    if (row.kind === 'activity' && !row.prompt) row.prompt = latestPrompt
  }
  return (before?: number): DisplayPage => {
    const end = before ?? ordered.length
    const start = Math.max(0, end - 80)
    const selected = ordered.slice(start, end)
    const ids = new Set(
      selected.filter(({ kind }) => kind === 'message').map(({ item }) => item.id)
    )
    for (const row of selected) if (row.prompt) ids.add(row.prompt)
    const messages = full.messages.filter(({ id }) => ids.has(id))
    const toolIds = new Set(
      selected.filter(({ kind }) => kind === 'activity').map(({ item }) => item.id)
    )
    const activities = (full.activities ?? []).filter(({ id }) => toolIds.has(id))
    const groupIds = new Set(selected.map(({ group }) => group).filter(Boolean))
    const activityGroups = (full.activityGroups ?? [])
      .filter(({ id }) => groupIds.has(id))
      .map((group) => ({
        ...group,
        activityIds: group.activityIds.filter((id) => toolIds.has(id))
      }))
      .sort(
        (a, b) => a.createdAt - b.createdAt || a.sortIndex - b.sortIndex || a.id.localeCompare(b.id)
      )
    const artifactIds = new Set(messages.flatMap((message) => message.artifactIds ?? []))
    const artifacts = (full.artifacts ?? [])
      .filter(({ id }) => artifactIds.has(id))
      .sort((a, b) => a.id.localeCompare(b.id))
    const { conversationGraph, ...header } = full
    void conversationGraph
    return {
      session: { ...header, messages, activities, activityGroups, artifacts },
      totalItems: ordered.length,
      hasMore: start > 0,
      ...(start > 0 ? { beforeCursor: String(start) } : {})
    }
  }
}
const selectDisplayPage = (full: PersistedChatSession, before?: number): DisplayPage =>
  createDisplayPager(full)(before)

const portableDisplay = (session: PersistedChatSession, root: string): unknown =>
  JSON.parse(JSON.stringify(encodeSessionDataPaths(session, root)))

it.skipIf(phase !== 'page')(
  'measures recent history, all pages and complete legacy reads separately',
  async () => {
    const mode = env('MODE')
    const id = env('CASE')
    const input = JSON.parse(await readFile(env('INPUT'), 'utf8')) as {
      seeds?: Seed[]
      results?: Written[]
    }
    let root: string
    let identity: Identity
    let expectedDigest: string
    let expectedSql: string | undefined
    let storageFormat: StorageSummary['format']
    if (mode === 'legacy-first') {
      const seed = input.seeds!.find(({ source }) => source.id === id)!
      root = await mkdtemp(join(tmpdir(), 'open-science-runtime-run-'))
      await cp(seed.root, root, { recursive: true, force: false })
      identity = seed.imported.identity
      expectedDigest = seed.hashes.imported
      storageFormat = 'json'
    } else {
      const written = input.results!.find((item) => item.id === id)!
      root = written.root
      identity = written.fork.identity
      expectedDigest = written.fork.digest
      expectedSql = written.fork.sqliteDigest
      storageFormat = written.fork.storage.format
    }
    initDataRoot(root)
    const client = createProjectDbClient(root)
    try {
      await client.$connect()
      // Schema startup is outside the timer. Legacy reads must not build a history index.
      await migrateApplicationDatabase(client)
      const projection = new SessionProjectionRepository(async () => client)
      const repository = new SessionRepository(root, {}, projection)
      const nativePage = Reflect.get(repository, 'loadSessionHistoryPage') as
        | ((
            request: Identity & { beforeCursor?: string; limit?: number }
          ) => Promise<DisplayPage | undefined>)
        | undefined
      const hasNativePaging = typeof nativePage === 'function'
      const logicalPath = join(root, 'sessions', identity.projectId, `${identity.sessionId}.json`)
      const originalLegacy =
        mode === 'legacy-first' ? await readFile(logicalPath, 'utf8') : undefined
      const originalSql = mode === 'legacy-first' ? await sqliteDigest(client, identity) : undefined
      if (hasNativePaging && mode === 'legacy-first') {
        const indexes = await client.$queryRawUnsafe<Array<{ count: number }>>(
          'SELECT COUNT(*) AS count FROM SessionHistoryIndex WHERE sessionId = ?',
          identity.sessionId
        )
        expect(Number(indexes[0].count)).toBe(0)
      }
      const pages: DisplayPage[] = []
      let complete: PersistedChatSession | undefined
      let residentPager: ((before?: number) => DisplayPage) | undefined
      let beforeCursor: string | undefined
      const start = performance.now()
      do {
        let page: DisplayPage
        if (hasNativePaging) {
          const loaded = await nativePage!.call(repository, {
            ...identity,
            beforeCursor,
            limit: 80
          })
          if (!loaded) throw new Error('Native display index was unavailable')
          page = loaded
        } else {
          // The original application reads once. Further pages slice its resident transcript;
          // deliberately do not charge the original a repeated complete JSON read per page.
          complete ??= await load(repository, identity)
          if (mode === 'legacy-first') {
            page = {
              session: complete,
              complete: true,
              hasMore: false,
              totalItems: complete.messages.length + (complete.activities?.length ?? 0)
            }
          } else {
            residentPager ??= createDisplayPager(complete)
            page = residentPager(beforeCursor === undefined ? undefined : Number(beforeCursor))
          }
        }
        pages.push(page)
        beforeCursor = page.beforeCursor
      } while (mode === 'all' && pages.at(-1)!.hasMore)
      const elapsedMs = performance.now() - start
      complete ??= await load(repository, identity)
      expect(endpoint(complete, root).digest).toBe(expectedDigest)
      const actualSql = await sqliteDigest(client, identity)
      if (expectedSql) expect(actualSql).toBe(expectedSql)
      if (originalSql) expect(actualSql).toBe(originalSql)
      let before: number | undefined
      for (const page of pages) {
        if (mode === 'legacy-first' || page.complete) {
          expect(page.complete).toBe(true)
          expect(page.hasMore).toBe(false)
          expect(page.beforeCursor).toBeUndefined()
          expect(page.totalItems).toBe(
            complete.messages.length + (complete.activities?.length ?? 0)
          )
          expect(portableDisplay(page.session, root)).toEqual(portableDisplay(complete, root))
          expect(endpoint(page.session, root).digest).toBe(expectedDigest)
          continue
        }
        const expectedPage = selectDisplayPage(complete, before)
        expect(page.totalItems).toBe(expectedPage.totalItems)
        expect(page.hasMore).toBe(expectedPage.hasMore)
        // Compare all fields and payloads; only portable data-root paths are normalized.
        expect(portableDisplay(page.session, root)).toEqual(
          portableDisplay(expectedPage.session, root)
        )
        before =
          expectedPage.beforeCursor === undefined ? undefined : Number(expectedPage.beforeCursor)
      }
      if (mode === 'all') expect(pages.at(-1)!.hasMore).toBe(false)
      if (hasNativePaging && storageFormat === 'json') {
        expect(pages[0].complete).toBe(true)
        for (const table of ['SessionHistoryIndex', 'SessionHistoryItem']) {
          const rows = await client.$queryRawUnsafe<Array<{ count: number }>>(
            `SELECT COUNT(*) AS count FROM ${table} WHERE sessionId = ?`,
            identity.sessionId
          )
          expect(Number(rows[0].count)).toBe(0)
        }
        await expect(stat(logicalPath.replace(/\.json$/, '.jsonl'))).rejects.toMatchObject({
          code: 'ENOENT'
        })
      }
      if (originalLegacy !== undefined) {
        expect(await readFile(logicalPath, 'utf8')).toBe(originalLegacy)
        await expect(stat(logicalPath.replace(/\.json$/, '.jsonl'))).rejects.toMatchObject({
          code: 'ENOENT'
        })
        if (hasNativePaging) {
          for (const table of ['SessionHistoryIndex', 'SessionHistoryItem']) {
            const rows = await client.$queryRawUnsafe<Array<{ count: number }>>(
              `SELECT COUNT(*) AS count FROM ${table} WHERE sessionId = ?`,
              identity.sessionId
            )
            expect(Number(rows[0].count)).toBe(0)
          }
        }
      }
      await writeReport({
        phase,
        mode,
        id,
        root,
        identity,
        elapsedMs,
        hasNativePaging,
        storageFormat,
        paginatedResponse: hasNativePaging && !pages[0].complete,
        complete: pages[0].complete ?? false,
        ...(mode === 'legacy-first'
          ? { legacyUnchanged: true, createdJsonl: false, historyIndexRows: 0 }
          : {}),
        pageCount: pages.length,
        totalItems: pages[0].totalItems,
        firstPageMessages: pages[0].session.messages.length,
        firstPageActivities: pages[0].session.activities?.length ?? 0,
        completeMessages: complete.messages.length,
        completeActivities: complete.activities?.length ?? 0,
        pageBytes: Buffer.byteLength(
          JSON.stringify(pages.map(({ session }) => portableDisplay(session, root)))
        ),
        pageDigest: digest(pages.map(({ session }) => portableDisplay(session, root))),
        completeDigest: expectedDigest,
        sqliteDigest: actualSql
      })
    } finally {
      await client.$disconnect()
    }
  },
  60_000
)

await configureTestElectronHost(await import('electron'))
