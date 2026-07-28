import { createHash } from 'node:crypto'
import { createReadStream, type Dirent } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { createProjectDbClient } from '../projects/prisma-client'
import { validateConversationGraph } from '../../shared/conversation-graph'
import { NOTEBOOK_RUN_FILE } from '../../shared/notebook'
import { normalizeSessionFile } from '../../shared/session-persistence'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const storageKey = (...segments: string[]): string => segments.join('/')

const assertStorageKey = (actual: string, expected: string, label: string): void => {
  if (actual !== expected) throw new Error(`${label} storage ownership is invalid.`)
}

const sha256File = async (path: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

const readEntries = async (path: string): Promise<Dirent[]> => {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return []
    }
    throw error
  }
}

const readRecord = async (path: string): Promise<Record<string, unknown>> => {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid provenance JSON: ${path}`)
  }
  return parsed as Record<string, unknown>
}

const fileExists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return false
    }
    throw error
  }
}

const resolveManagedStorageKey = (root: string, key: string): string => {
  const path = resolve(root, ...key.split('/'))
  const relativePath = relative(root, path)
  if (
    !key ||
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Managed storage key escapes the data root: ${key}`)
  }
  return path
}

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const validateEnvironmentState = async (root: string): Promise<Set<string>> => {
  const provenanceRoot = join(root, 'runtime', 'provenance')
  const manifestDirectory = join(provenanceRoot, 'environment-manifests')
  const manifestChecksums = new Set<string>()
  for (const entry of await readEntries(manifestDirectory)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const checksum = entry.name.slice(0, -'.json'.length)
    if (SHA256_PATTERN.test(checksum)) manifestChecksums.add(checksum)
  }

  const inventoryRoot = join(provenanceRoot, 'environment-inventory')
  for (const target of await readEntries(inventoryRoot)) {
    if (!target.isDirectory()) continue
    const targetDirectory = join(inventoryRoot, target.name)
    const operationEntries = (await readEntries(join(targetDirectory, 'operations'))).filter(
      (entry) => entry.isFile()
    )
    let binding: Record<string, unknown> | undefined
    try {
      binding = await readRecord(join(targetDirectory, 'binding.json'))
    } catch (error) {
      if (!(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      )) {
        throw error
      }
    }
    if (
      operationEntries.length > 0 ||
      binding?.state === 'dirty' ||
      typeof binding?.dirtyOperationId === 'string' ||
      typeof binding?.dirtyReason === 'string'
    ) {
      throw new Error(`Unfinished Environment operation blocks migration: ${target.name}`)
    }
    if (binding && (binding.schemaVersion !== 1 || !Array.isArray(binding.operationLog))) {
      throw new Error(`Invalid Environment binding blocks migration: ${target.name}`)
    }
  }
  return manifestChecksums
}

const validateReferencedEnvironmentManifests = async (
  root: string,
  manifestChecksums: Set<string>
): Promise<void> => {
  const validated = new Set<string>()
  const notebooksRoot = join(root, 'notebooks')
  for (const project of await readEntries(notebooksRoot)) {
    if (!project.isDirectory()) continue
    for (const session of await readEntries(join(notebooksRoot, project.name))) {
      if (!session.isDirectory()) continue
      const runPath = join(notebooksRoot, project.name, session.name, NOTEBOOK_RUN_FILE)
      if (!(await fileExists(runPath))) continue
      const document = await readRecord(runPath)
      if (document.projectName !== project.name || document.sessionId !== session.name) {
        throw new Error(`Notebook run ownership is invalid: ${project.name}/${session.name}`)
      }
      const runs = Array.isArray(document.runs) ? document.runs : []
      for (const rawRun of runs) {
        const run = recordValue(rawRun)
        if (!run) throw new Error(`Notebook run record is invalid: ${project.name}/${session.name}`)
        const capture = recordValue(run.environmentCapture)
        const captureState = capture?.state
        const checksum =
          typeof run.environmentManifestChecksum === 'string'
            ? run.environmentManifestChecksum
            : captureState === 'available' || captureState === 'partial'
              ? capture?.manifestChecksum
              : undefined
        if (checksum === undefined) continue
        if (typeof checksum !== 'string' || !SHA256_PATTERN.test(checksum)) {
          throw new Error(`Notebook Environment reference is invalid: ${String(run.runId ?? '')}`)
        }
        if (validated.has(checksum)) continue
        if (!manifestChecksums.has(checksum)) {
          throw new Error(`Notebook Environment manifest is unavailable: ${checksum}`)
        }
        const manifestPath = join(
          root,
          'runtime',
          'provenance',
          'environment-manifests',
          `${checksum}.json`
        )
        if ((await sha256File(manifestPath)) !== checksum) {
          throw new Error(`Notebook Environment manifest checksum mismatch: ${checksum}`)
        }
        validated.add(checksum)
      }
    }
  }
}

const validateArtifactVersions = async (root: string): Promise<void> => {
  const artifactsRoot = join(root, 'artifacts')
  for (const project of await readEntries(artifactsRoot)) {
    if (!project.isDirectory()) continue
    for (const session of await readEntries(join(artifactsRoot, project.name))) {
      if (!session.isDirectory()) continue
      const provenanceRoot = join(artifactsRoot, project.name, session.name, '.provenance')
      const stagingVersions = await readEntries(join(provenanceRoot, '.staging', 'versions'))
      if (stagingVersions.length > 0) {
        throw new Error(
          `Unfinished Artifact staging blocks migration: ${project.name}/${session.name}`
        )
      }
      for (const lineage of await readEntries(provenanceRoot)) {
        if (!lineage.isDirectory() || lineage.name.startsWith('.')) continue
        const versionsRoot = join(provenanceRoot, lineage.name, 'versions')
        for (const version of await readEntries(versionsRoot)) {
          if (!version.isDirectory()) continue
          const versionDirectory = join(versionsRoot, version.name)
          const evidence = await readRecord(join(versionDirectory, 'evidence.json'))
          const sizeBytes = evidence.size_bytes
          const checksum = evidence.checksum
          if (
            evidence.schema_version !== 1 ||
            evidence.project_id !== project.name ||
            evidence.app_session_id !== session.name ||
            evidence.artifact_id !== lineage.name ||
            evidence.version_id !== version.name ||
            !Number.isSafeInteger(sizeBytes) ||
            (sizeBytes as number) < 0 ||
            typeof checksum !== 'string' ||
            !SHA256_PATTERN.test(checksum)
          ) {
            throw new Error(`Artifact evidence identity is invalid: ${version.name}`)
          }
          const contentPath = join(versionDirectory, 'content')
          const contentSize = (await stat(contentPath)).size
          if (contentSize !== sizeBytes || (await sha256File(contentPath)) !== checksum) {
            throw new Error(`Artifact content checksum mismatch: ${version.name}`)
          }
          if (recordValue(evidence.execution_status)?.state === 'available') {
            const executionChecksum = evidence.execution_snapshot_checksum
            if (
              typeof executionChecksum !== 'string' ||
              !SHA256_PATTERN.test(executionChecksum) ||
              (await sha256File(join(versionDirectory, 'execution.json'))) !== executionChecksum
            ) {
              throw new Error(`Artifact execution checksum mismatch: ${version.name}`)
            }
          }
        }
      }
    }
  }
}

const validateSessionGraphs = async (authorityRoot: string): Promise<void> => {
  const sessionsRoot = join(authorityRoot, 'sessions')
  for (const project of await readEntries(sessionsRoot)) {
    if (!project.isDirectory()) continue
    for (const entry of await readEntries(join(sessionsRoot, project.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.includes('.tmp')) continue
      const path = join(sessionsRoot, project.name, entry.name)
      const session = normalizeSessionFile(JSON.parse(await readFile(path, 'utf8')) as unknown, {
        preserveLegacyUploadPaths: true
      })
      const expectedSessionId = entry.name.slice(0, -'.json'.length)
      if (!session || session.id !== expectedSessionId || !session.conversationGraph) {
        throw new Error(`Session graph ownership is invalid: ${project.name}/${entry.name}`)
      }
      validateConversationGraph(session.conversationGraph)
    }
  }
}

const assertNoUploadStaging = async (root: string): Promise<void> => {
  const uploadsRoot = join(root, 'uploads')
  for (const project of await readEntries(uploadsRoot)) {
    if (
      project.isDirectory() &&
      (await readEntries(join(uploadsRoot, project.name, '.staging'))).length > 0
    ) {
      throw new Error(`Unfinished Upload staging blocks migration: ${project.name}`)
    }
  }
}

const validateSqliteStore = async (dataRoot: string, authorityRoot: string): Promise<void> => {
  const databasePath = join(authorityRoot, 'open-science.db')
  if (!(await fileExists(databasePath))) return
  const client = createProjectDbClient(authorityRoot)
  try {
    const checkpointRows = await client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      'PRAGMA wal_checkpoint(FULL)'
    )
    const checkpointBusy = Number(
      checkpointRows[0]?.busy ?? Object.values(checkpointRows[0] ?? {})[0]
    )
    if (!Number.isFinite(checkpointBusy) || checkpointBusy !== 0) {
      throw new Error('SQLite WAL checkpoint is busy; provenance writes are still active.')
    }
    const integrityRows =
      await client.$queryRawUnsafe<Array<Record<string, unknown>>>('PRAGMA integrity_check')
    if (
      integrityRows.length === 0 ||
      integrityRows.some((row) => !Object.values(row).some((value) => value === 'ok'))
    ) {
      throw new Error('SQLite integrity check failed.')
    }
    const foreignKeyRows = await client.$queryRawUnsafe<Array<Record<string, unknown>>>(
      'PRAGMA foreign_key_check'
    )
    if (foreignKeyRows.length > 0) throw new Error('SQLite foreign key check failed.')
    const tableRows = await client.$queryRawUnsafe<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    )
    const tables = new Set(tableRows.map((row) => row.name))
    if (tables.has('ArtifactVersion')) {
      const versions = await client.artifactVersion.findMany({ include: { artifact: true } })
      for (const version of versions) {
        if (version.state === 'staging') {
          throw new Error(`Unfinished Artifact staging blocks migration: ${version.id}`)
        }
        if (
          createHash('sha256').update(version.evidenceJson).digest('hex') !==
          version.evidenceChecksum
        ) {
          throw new Error(`Artifact canonical evidence checksum mismatch: ${version.id}`)
        }
        const versionRoot = storageKey(
          'artifacts',
          version.artifact.projectId,
          version.artifact.sessionId,
          '.provenance',
          version.artifactId,
          'versions',
          version.id
        )
        assertStorageKey(
          version.contentStorageKey,
          storageKey(versionRoot, 'content'),
          `Artifact ${version.id} content`
        )
        assertStorageKey(
          version.evidenceStorageKey,
          storageKey(versionRoot, 'evidence.json'),
          `Artifact ${version.id} evidence`
        )
        const contentPath = resolveManagedStorageKey(dataRoot, version.contentStorageKey)
        if (
          (await stat(contentPath)).size !== Number(version.sizeBytes) ||
          (await sha256File(contentPath)) !== version.checksum
        ) {
          throw new Error(`Artifact SQLite content checksum mismatch: ${version.id}`)
        }
        const evidencePath = resolveManagedStorageKey(dataRoot, version.evidenceStorageKey)
        if ((await readFile(evidencePath, 'utf8')) !== version.evidenceJson) {
          throw new Error(`Artifact evidence mirror mismatch: ${version.id}`)
        }
        if (version.executionSnapshotJson) {
          assertStorageKey(
            version.executionSnapshotStorageKey ?? '',
            storageKey(versionRoot, 'execution.json'),
            `Artifact ${version.id} execution`
          )
          if (
            !version.executionSnapshotChecksum ||
            !version.executionSnapshotStorageKey ||
            createHash('sha256').update(version.executionSnapshotJson).digest('hex') !==
              version.executionSnapshotChecksum ||
            (await readFile(
              resolveManagedStorageKey(dataRoot, version.executionSnapshotStorageKey),
              'utf8'
            )) !== version.executionSnapshotJson
          ) {
            throw new Error(`Artifact execution mirror mismatch: ${version.id}`)
          }
        }
      }
    }
    if (tables.has('UploadVersion')) {
      const versions = await client.uploadVersion.findMany({ include: { uploadFile: true } })
      for (const version of versions) {
        if (version.state === 'staging') {
          throw new Error(`Unfinished Upload staging blocks migration: ${version.id}`)
        }
        assertStorageKey(
          version.contentStorageKey,
          storageKey(
            'uploads',
            version.uploadFile.projectId,
            version.uploadFile.sessionId,
            version.uploadFileId,
            'versions',
            version.id,
            'content'
          ),
          `Upload ${version.id} content`
        )
        const contentPath = resolveManagedStorageKey(dataRoot, version.contentStorageKey)
        if (
          (await stat(contentPath)).size !== Number(version.sizeBytes) ||
          (await sha256File(contentPath)) !== version.checksum
        ) {
          throw new Error(`Upload SQLite content checksum mismatch: ${version.id}`)
        }
      }
    }
    if (tables.has('ArtifactMessageSnapshot')) {
      const snapshots = await client.artifactMessageSnapshot.findMany()
      for (const snapshot of snapshots) {
        if (snapshot.state === 'staging') {
          throw new Error(`Unfinished Message snapshot blocks migration: ${snapshot.id}`)
        }
        assertStorageKey(
          snapshot.storageKey,
          storageKey(
            'artifacts',
            snapshot.projectId,
            snapshot.sessionId,
            '.provenance',
            'message-snapshots',
            `${snapshot.id}.json`
          ),
          `Message snapshot ${snapshot.id}`
        )
        const serialized = await readFile(
          resolveManagedStorageKey(dataRoot, snapshot.storageKey),
          'utf8'
        )
        const actualChecksum = createHash('sha256').update(serialized).digest('hex')
        // Early Provenance snapshots predate the checksum column and retain an empty value. Their
        // identity and message-count proof below still make them safe to copy; once a checksum has
        // been recorded, however, any byte change remains a hard migration failure.
        if (snapshot.checksum && actualChecksum !== snapshot.checksum) {
          throw new Error(`Message snapshot checksum mismatch: ${snapshot.id}`)
        }
        const payload = recordValue(JSON.parse(serialized))
        if (
          !payload ||
          payload.snapshotId !== snapshot.id ||
          payload.rootFrameId !== snapshot.rootFrameId ||
          payload.agentFrameId !== snapshot.agentFrameId ||
          payload.messageBranchId !== snapshot.messageBranchId ||
          payload.terminalMessageId !== snapshot.terminalMessageId ||
          !Array.isArray(payload.messages) ||
          payload.messages.length !== snapshot.messageCount
        ) {
          throw new Error(`Message snapshot ownership is invalid: ${snapshot.id}`)
        }
      }
    }
    if (tables.has('ReviewScopeSnapshot')) {
      const snapshots = await client.reviewScopeSnapshot.findMany({ include: { review: true } })
      for (const snapshot of snapshots) {
        if (snapshot.state === 'staging') {
          throw new Error(`Unfinished Review snapshot blocks migration: ${snapshot.id}`)
        }
        if (snapshot.state !== 'ready') continue
        assertStorageKey(
          snapshot.storageKey,
          storageKey(
            'artifacts',
            encodeURIComponent(snapshot.projectId),
            encodeURIComponent(snapshot.sessionId),
            '.provenance',
            'review-scope-snapshots',
            `${snapshot.id}.json`
          ),
          `Review snapshot ${snapshot.id}`
        )
        const serialized = await readFile(
          resolveManagedStorageKey(dataRoot, snapshot.storageKey),
          'utf8'
        )
        if (
          serialized !== snapshot.snapshotJson ||
          createHash('sha256').update(serialized).digest('hex') !== snapshot.checksum
        ) {
          throw new Error(`Review snapshot checksum mismatch: ${snapshot.id}`)
        }
        const payload = recordValue(JSON.parse(serialized))
        const payloadScope = recordValue(payload?.scope)
        const reviewScope = recordValue(JSON.parse(snapshot.review.scope))
        if (
          !payload ||
          payload.schemaVersion !== snapshot.schemaVersion ||
          payload.snapshotId !== snapshot.id ||
          payload.reviewId !== snapshot.reviewId ||
          payload.projectId !== snapshot.projectId ||
          payload.sessionId !== snapshot.sessionId ||
          snapshot.review.projectId !== snapshot.projectId ||
          snapshot.review.sessionId !== snapshot.sessionId ||
          payloadScope?.turnMessageId !== snapshot.scopeTurnMessageId ||
          reviewScope?.turnMessageId !== snapshot.scopeTurnMessageId ||
          payloadScope?.agentFrameId !== reviewScope?.agentFrameId ||
          payloadScope?.messageBranchId !== reviewScope?.messageBranchId ||
          payload.agentFrameId !== reviewScope?.agentFrameId ||
          payload.messageBranchId !== reviewScope?.messageBranchId ||
          !Array.isArray(payload.blocks) ||
          payload.blocks.length !== snapshot.blockCount
        ) {
          throw new Error(`Review snapshot ownership is invalid: ${snapshot.id}`)
        }
      }
    }
    if (tables.has('ArtifactVersionInput')) {
      const inputs = await client.artifactVersionInput.findMany({
        include: {
          sourceArtifactVersion: { include: { artifact: true } },
          sourceUploadVersion: { include: { uploadFile: true } }
        }
      })
      for (const input of inputs) {
        const artifactSource = input.sourceArtifactVersion
        const uploadSource = input.sourceUploadVersion
        const commonMatches = (
          source: {
            id: string
            versionNumber: number
            filename: string
            contentType: string | null
            sizeBytes: bigint
            checksum: string
            contentStorageKey: string
          },
          sourceFileId: string,
          sourceProjectId: string,
          sourceSessionId: string
        ): boolean =>
          input.inputFileVersionId === source.id &&
          input.sourceFileId === sourceFileId &&
          input.sourceVersionNumber === source.versionNumber &&
          input.sourceProjectId === sourceProjectId &&
          input.sourceSessionId === sourceSessionId &&
          input.filename === source.filename &&
          input.contentType === source.contentType &&
          input.sizeBytes === source.sizeBytes &&
          input.checksum === source.checksum &&
          input.storageKey === source.contentStorageKey
        const validArtifactSource =
          input.sourceKind === 'artifact-version' &&
          artifactSource !== null &&
          uploadSource === null &&
          input.sourceArtifactVersionId === artifactSource.id &&
          commonMatches(
            { ...artifactSource, filename: artifactSource.artifact.filename },
            artifactSource.artifactId,
            artifactSource.artifact.projectId,
            artifactSource.artifact.sessionId
          )
        const validUploadSource =
          input.sourceKind === 'upload-version' &&
          uploadSource !== null &&
          artifactSource === null &&
          input.sourceUploadVersionId === uploadSource.id &&
          commonMatches(
            uploadSource,
            uploadSource.uploadFileId,
            uploadSource.uploadFile.projectId,
            uploadSource.uploadFile.sessionId
          )
        if (!validArtifactSource && !validUploadSource) {
          throw new Error(`Artifact input ownership is invalid: ${input.id}`)
        }
      }
    }
  } finally {
    await client.$disconnect()
  }
}

// Migration validates domain state in addition to byte-for-byte copy inventories. It refuses open
// mutations and checks immutable evidence before either root can become authoritative.
export const validateProvenanceMigrationState = async (
  dataRoot: string,
  authorityRoot: string = dataRoot
): Promise<void> => {
  await validateSessionGraphs(authorityRoot)
  await validateSqliteStore(dataRoot, authorityRoot)
  const manifests = await validateEnvironmentState(dataRoot)
  await validateReferencedEnvironmentManifests(dataRoot, manifests)
  await validateArtifactVersions(dataRoot)
  await assertNoUploadStaging(dataRoot)
}
