import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import {
  createProjectDbClient,
  migrateApplicationDatabase
} from '../../src/main/projects/prisma-client'
import { fileChecksum } from '../../src/main/session-package/archive'
import { SessionPackageService } from '../../src/main/session-package/service'
import { SessionRepository } from '../../src/main/session-persistence/repository'
import { encodeSessionDataPaths } from '../../src/main/session-persistence/session-data-paths'
import { initDataRoot } from '../../src/main/storage-root'
import { createSessionFile, type PersistedChatSession } from '../../src/shared/session-persistence'
import type { SessionPackagePreview, SessionPackageRequest } from '../../src/shared/session-package'
import { sessionUsageRuns } from '../../src/shared/session-usage'

export type OfficialScienceSource = {
  id: string
  path: string
  sha256?: string
  bytes?: number
  url?: string
  page?: string
}

export type OfficialSessionSummary = {
  canonicalBytes: number
  canonicalDigest: string
  messages: number
  messagesByRole: Record<string, number>
  activeMessages: number
  messageTextBytes: number
  toolActivities: number
  toolRawOutputBytes: number
  toolContentBytes: number
  frames: number
  branches: number
  artifacts: number
  turnUsageOwners: number
  modelCalls: number
  currentUsageRuns: number
  createdAt: number
  updatedAt: number
}

export type OfficialScienceSeed = {
  root: string
  databasePath: string
  source: OfficialScienceSource
  archive: {
    bytes: number
    sha256: string
    expectedChecksumMatched: boolean | null
    validation: 'passed'
    preview: SessionPackagePreview
    inventoryEntries: number
    inventoryBytes: number
    taskRuns: number
    computeJobs: number
    streamingEventLogAvailable: false
  }
  timingsMs: { inspect: number; import: number; fork: number }
  imported: SeedSession
  fork: SeedSession
}

type SeedSession = {
  identity: SessionPackageRequest
  summary: OfficialSessionSummary
  sqliteRows: { turns: number; modelCalls: number; runs: number; artifacts: number }
}

// Hash the whole public canonical document, with only documented data-root path encoding.
// Key order is immaterial; content, usage and provenance fields all remain in the digest.
export const summarizeOfficialSession = (
  session: PersistedChatSession,
  root: string
): OfficialSessionSummary => {
  const canonical = createSessionFile(encodeSessionDataPaths(session, root))
  const serialized = JSON.stringify(canonical, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) => left.localeCompare(right))
        )
      : item
  )
  const graph = canonical.session.conversationGraph!
  const messages = graph.messages
  const activities = graph.activities
  const messagesByRole: Record<string, number> = {}
  for (const message of messages) {
    messagesByRole[message.role] = (messagesByRole[message.role] ?? 0) + 1
  }
  return {
    canonicalBytes: Buffer.byteLength(serialized),
    canonicalDigest: createHash('sha256').update(serialized).digest('hex'),
    messages: messages.length,
    messagesByRole,
    activeMessages: canonical.session.messages.length,
    messageTextBytes: messages.reduce(
      (sum, message) => sum + Buffer.byteLength(message.content),
      0
    ),
    toolActivities: activities.length,
    toolRawOutputBytes: activities.reduce(
      (sum, activity) => sum + Buffer.byteLength(JSON.stringify(activity.rawOutput) ?? ''),
      0
    ),
    toolContentBytes: activities.reduce(
      (sum, activity) => sum + Buffer.byteLength(JSON.stringify(activity.toolContent) ?? ''),
      0
    ),
    frames: graph.frames.length,
    branches: graph.branches.length,
    artifacts: canonical.session.artifacts?.length ?? 0,
    turnUsageOwners: messages.filter((message) => !!message.turnUsage).length,
    modelCalls: messages.reduce((sum, message) => sum + (message.modelCallUsage?.length ?? 0), 0),
    currentUsageRuns: sessionUsageRuns(canonical.session).length,
    createdAt: canonical.session.createdAt,
    updatedAt: canonical.session.updatedAt
  }
}

const readSeedSession = async (
  root: string,
  identity: SessionPackageRequest,
  client: PrismaClient
): Promise<{ session: PersistedChatSession; result: SeedSession }> => {
  // A separate owner for each identity verifies durable authority, without repairing it or
  // accidentally measuring a populated repository cache as a cold read.
  const loaded = await new SessionRepository(root).loadSessionWithDiagnostics(
    identity.projectId,
    identity.sessionId,
    { mode: 'read-only', preserveRuntimeState: true }
  )
  if (loaded.status !== 'found')
    throw new Error(`Published ${identity.sessionId}: ${loaded.status}`)
  if (loaded.session.id !== identity.sessionId || loaded.session.projectId !== identity.projectId)
    throw new Error('Published Session identity mismatch.')
  const where = { sessionId: identity.sessionId }
  const [turns, modelCalls, runs, artifacts] = await Promise.all([
    client.sessionTurnUsage.count({ where }),
    client.sessionModelCallUsage.count({ where }),
    client.sessionRun.count({ where }),
    client.sessionArtifactRef.count({ where })
  ])
  return {
    session: loaded.session,
    result: {
      identity,
      summary: summarizeOfficialSession(loaded.session, root),
      sqliteRows: { turns, modelCalls, runs, artifacts }
    }
  }
}

// The caller installs the regular headless host capabilities first (tests use
// configureTestElectronHost). This helper owns a fresh root/client, never the production singleton.
// Run once before copying this seed to both variants: import/fork generate IDs and timestamps.
// No model, tool, shell or Notebook execution is requested. A .science archive is a settled
// snapshot plus research evidence, not the original provider chunk/500 ms persistence stream.
export const prepareOfficialScienceSeed = async (
  source: OfficialScienceSource,
  root: string
): Promise<OfficialScienceSeed> => {
  if (!isAbsolute(root)) throw new Error('Official benchmark root must be an absolute empty path.')
  const rootPath = resolve(root)
  await mkdir(rootPath, { recursive: true })
  const rootInfo = await lstat(rootPath)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (await readdir(rootPath)).length)
    throw new Error('Official benchmark root must be an empty regular directory.')
  const sourcePath = resolve(source.path)
  const sourceInfo = await lstat(sourcePath)
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink())
    throw new Error('Official archive must be a regular file.')
  const checksum = await fileChecksum(sourcePath)
  if (source.sha256 && checksum !== source.sha256)
    throw new Error('Official archive does not match its recorded SHA-256.')
  if (source.bytes !== undefined && sourceInfo.size !== source.bytes)
    throw new Error('Official archive does not match its recorded size.')

  initDataRoot(rootPath)
  const databasePath = join(rootPath, 'open-science.db')
  const client = createProjectDbClient(rootPath)
  const service = new SessionPackageService({
    storageRoot: rootPath,
    configRoot: rootPath,
    getClient: async () => client
  })
  try {
    await migrateApplicationDatabase(client, { databasePath })
    let started = performance.now()
    const preview = await service.inspect(sourcePath)
    const inspectMs = performance.now() - started
    started = performance.now()
    const importedIdentity = await service.importFrom(sourcePath)
    const importMs = performance.now() - started
    started = performance.now()
    const forkIdentity = await service.fork(importedIdentity)
    const forkMs = performance.now() - started
    const imported = await readSeedSession(rootPath, importedIdentity, client)
    const fork = await readSeedSession(rootPath, forkIdentity, client)
    if (!imported.session.packageOrigin || fork.session.packageOrigin || !fork.session.forkOrigin)
      throw new Error('Official import/fork protection and lineage contract was not preserved.')
    if (fork.session.id === imported.session.id)
      throw new Error('Official fork reused the imported Session identity.')
    // Counts are invariant under the supported fork remapping; full digests intentionally differ
    // because fork assigns IDs, lineage, replay state and timestamps through product policy.
    for (const key of [
      'messages',
      'toolActivities',
      'frames',
      'branches',
      'artifacts',
      'turnUsageOwners',
      'modelCalls'
    ] as const) {
      if (imported.result.summary[key] !== fork.result.summary[key])
        throw new Error(`Official fork changed history count: ${key}`)
    }
    const origin = await service.readOrigin(importedIdentity)
    if ((await fileChecksum(sourcePath)) !== checksum)
      throw new Error('Official archive changed while preparing its seed.')
    return {
      root: rootPath,
      databasePath,
      source: { ...source, path: sourcePath },
      archive: {
        bytes: sourceInfo.size,
        sha256: checksum,
        expectedChecksumMatched: source.sha256 ? true : null,
        validation: 'passed',
        preview,
        inventoryEntries: origin.sourceManifest.inventory.length,
        inventoryBytes: origin.sourceManifest.inventory.reduce(
          (sum, entry) => sum + entry.sizeBytes,
          0
        ),
        taskRuns: origin.history?.taskRuns.length ?? 0,
        computeJobs: origin.history?.computeJobs.length ?? 0,
        streamingEventLogAvailable: false
      },
      timingsMs: { inspect: inspectMs, import: importMs, fork: forkMs },
      imported: imported.result,
      fork: fork.result
    }
  } finally {
    try {
      await service.close()
    } finally {
      await client.$disconnect()
    }
  }
}
