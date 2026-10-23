import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MAX_R_STAGE_CHECKPOINT_BYTES, sealWorkflowCapture } from '@aipoch/reproducibility'
import type { ProvenanceNotebookRun, RStageCheckpointFile } from '@aipoch/reproducibility/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { validateProvenanceMigrationState } from './provenance-migration-validation'
import { operationJournalPath, RuntimeOperationJournal } from '@aipoch/environment'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { ArtifactReproducibilityReceiptStore } from '../artifacts/artifact-reproducibility-receipts'

let root: string
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'open-science-provenance-migration-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const checkpointRun = async (): Promise<ProvenanceNotebookRun> => {
  const lock = JSON.stringify({
    schemaVersion: 1,
    format: 'environment-lock-bundle',
    kernelKind: 'r',
    environmentName: 'default-r',
    components: [
      {
        ecosystem: 'conda',
        format: 'conda-explicit-md5',
        resolution: 'locked',
        packages: ['r-base'],
        explicitLock:
          '@EXPLICIT\nhttps://conda.example/r-base.conda#0123456789abcdef0123456789abcdef\n'
      }
    ]
  })
  const lockChecksum = sha256(lock)
  const lockPath = join(root, 'runtime', 'provenance', 'environment-locks', `${lockChecksum}.json`)
  await mkdir(dirname(lockPath), { recursive: true })
  await writeFile(lockPath, lock)
  const file = async (bytes: string): Promise<RStageCheckpointFile> => {
    const checksum = sha256(bytes)
    const storageKey = `runtime/provenance/r-stage-checkpoints/${checksum}.rds`
    await mkdir(dirname(join(root, storageKey)), { recursive: true })
    await writeFile(join(root, storageKey), bytes)
    return { storageKey, checksum, sizeBytes: Buffer.byteLength(bytes) }
  }
  return {
    runId: 'run-1',
    runIndex: 0,
    agentFrameId: 'frame',
    messageBranchId: 'branch',
    runtimeSegmentId: 'segment',
    promptMessageId: 'prompt',
    kernelKind: 'r',
    kernelEpochId: 'epoch',
    script: 'x <- 1',
    status: 'completed',
    startedAt: '2026-10-20T00:00:00Z',
    outputs: [],
    inputFileVersionKeys: [],
    environmentLock: { state: 'available', format: 'environment-lock-bundle', lockChecksum },
    stageCheckpoint: {
      state: 'available',
      schemaVersion: 1,
      runId: 'run-1',
      kernelEpochId: 'epoch',
      sourceChecksum: sha256('x <- 1'),
      environmentLockChecksum: lockChecksum,
      input: await file('RDS input'),
      output: await file('RDS output'),
      inputNames: [],
      outputNames: ['x']
    }
  }
}

type RunLocation = 'notebook' | 'artifact' | 'workflow'
const writeCheckpointRun = async (
  location: RunLocation,
  run: ProvenanceNotebookRun
): Promise<void> => {
  if (location === 'notebook') {
    const path = join(root, 'notebooks', 'project-1', 'session-1', 'run.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({ projectId: 'project-1', sessionId: 'session-1', runs: [run] })
    )
    return
  }
  const directory = join(
    root,
    'artifacts',
    'project-1',
    'session-1',
    '.provenance',
    'artifact-1',
    'versions',
    'version-1'
  )
  await mkdir(directory, { recursive: true })
  const capture =
    location === 'workflow'
      ? sealWorkflowCapture({
          schemaVersion: 1,
          runs: [run],
          inputFiles: [],
          graph: {
            schemaVersion: 1,
            targetEntityId: 'artifact',
            completeness: 'complete',
            reasonCodes: [],
            activities: [
              {
                activityId: run.runId,
                kind: 'notebook-run',
                sequence: 0,
                runIndex: 0,
                inclusion: 'workflow-capture',
                evidenceState: 'available'
              }
            ],
            entities: [
              {
                entityId: 'artifact',
                kind: 'artifact-version',
                versionId: 'version-1',
                filename: 'result.txt',
                checksum: sha256('artifact'),
                sizeBytes: 8
              }
            ],
            edges: []
          }
        })
      : undefined
  const execution = JSON.stringify({
    runs: location === 'artifact' ? [run] : [],
    ...(capture ? { workflowCapture: { state: 'available', capture } } : {})
  })
  await writeFile(join(directory, 'content'), 'artifact')
  await writeFile(join(directory, 'execution.json'), execution)
  await writeFile(
    join(directory, 'evidence.json'),
    JSON.stringify({
      schema_version: 1,
      project_id: 'project-1',
      app_session_id: 'session-1',
      artifact_id: 'artifact-1',
      version_id: 'version-1',
      size_bytes: 8,
      checksum: sha256('artifact'),
      execution_status: { state: 'available' },
      execution_snapshot_checksum: sha256(execution)
    })
  )
}

describe.each<RunLocation>(['notebook', 'artifact', 'workflow'])(
  'R stage checkpoint migration: %s',
  (location) => {
    it('validates both referenced state blobs and detects missing or corrupt bytes', async () => {
      const run = await checkpointRun()
      await writeCheckpointRun(location, run)
      const checkpoint = run.stageCheckpoint!
      if (checkpoint.state !== 'available') throw new Error('fixture checkpoint missing')
      await expect(validateProvenanceMigrationState(root)).resolves.toBeUndefined()
      const input = join(root, checkpoint.input.storageKey)
      await writeFile(input, 'RDS other')
      await expect(validateProvenanceMigrationState(root)).rejects.toThrow(/checkpoint checksum/i)
      await rm(input)
      await expect(validateProvenanceMigrationState(root)).rejects.toThrow(/ENOENT/)
    })

    it('rejects a renamed or linked state blob', async () => {
      const run = await checkpointRun()
      await writeCheckpointRun(location, run)
      const checkpoint = run.stageCheckpoint!
      if (checkpoint.state !== 'available') throw new Error('fixture checkpoint missing')
      const input = join(root, checkpoint.input.storageKey)
      const renamed = `${input}.renamed`
      await rename(input, renamed)
      await expect(validateProvenanceMigrationState(root)).rejects.toThrow(/ENOENT/)
      await symlink(renamed, input)
      await expect(validateProvenanceMigrationState(root)).rejects.toThrow(
        /checkpoint storage path/i
      )
    })
  }
)

describe('Frame Notebook checkpoint migration', () => {
  it.each([false, true])(
    'validates child history when a root history is present: %s',
    async (withRoot) => {
      const run = await checkpointRun()
      if (withRoot) await writeCheckpointRun('notebook', { ...run, stageCheckpoint: undefined })
      const framePath = join(
        root,
        'notebooks',
        'project-1',
        'session-1',
        'frames',
        run.agentFrameId,
        'run.json'
      )
      await mkdir(dirname(framePath), { recursive: true })
      await writeFile(
        framePath,
        JSON.stringify({ projectId: 'project-1', sessionId: 'session-1', runs: [run] })
      )
      await expect(validateProvenanceMigrationState(root)).resolves.toBeUndefined()
      const checkpoint = run.stageCheckpoint!
      if (checkpoint.state !== 'available') throw new Error('fixture checkpoint missing')
      const inputPath = join(root, checkpoint.input.storageKey)
      await writeFile(inputPath, 'RDS other')
      await expect(validateProvenanceMigrationState(root)).rejects.toThrow(/checkpoint checksum/i)
      await rm(inputPath)
      await expect(validateProvenanceMigrationState(root)).rejects.toThrow(/ENOENT/)
    }
  )

  it('accepts legacy frame-only history without a checkpoint', async () => {
    const run = await checkpointRun()
    delete run.stageCheckpoint
    const framePath = join(
      root,
      'notebooks',
      'project-1',
      'session-1',
      'frames',
      run.agentFrameId,
      'run.json'
    )
    await mkdir(dirname(framePath), { recursive: true })
    await writeFile(
      framePath,
      JSON.stringify({
        projectId: 'project-1',
        sessionId: 'session-1',
        runs: [{ ...run, agentFrameId: undefined }]
      })
    )
    await expect(validateProvenanceMigrationState(root)).resolves.toBeUndefined()
  })

  it.each(['project', 'session', 'frame'])(
    'rejects mismatched child %s ownership',
    async (owner) => {
      const run = await checkpointRun()
      const framePath = join(
        root,
        'notebooks',
        'project-1',
        'session-1',
        'frames',
        run.agentFrameId,
        'run.json'
      )
      await mkdir(dirname(framePath), { recursive: true })
      if (owner === 'frame') run.agentFrameId = 'other-frame'
      await writeFile(
        framePath,
        JSON.stringify({
          projectId: owner === 'project' ? 'other-project' : 'project-1',
          sessionId: owner === 'session' ? 'other-session' : 'session-1',
          runs: [run]
        })
      )
      await expect(validateProvenanceMigrationState(root)).rejects.toThrow(/ownership/i)
    }
  )
})

describe('R stage checkpoint migration binding', () => {
  it.each([
    'runId',
    'kernelEpochId',
    'sourceChecksum',
    'environmentLockChecksum',
    'schemaVersion',
    'path',
    'size',
    'oversize',
    'unknown-state'
  ])('rejects %s mismatches', async (field) => {
    const run = await checkpointRun()
    const checkpoint = run.stageCheckpoint!
    if (checkpoint.state !== 'available') throw new Error('fixture checkpoint missing')
    if (field === 'runId') checkpoint.runId = 'other-run'
    if (field === 'kernelEpochId') checkpoint.kernelEpochId = 'other-epoch'
    if (field === 'sourceChecksum') checkpoint.sourceChecksum = '0'.repeat(64)
    if (field === 'environmentLockChecksum') checkpoint.environmentLockChecksum = '0'.repeat(64)
    if (field === 'schemaVersion') Object.assign(checkpoint, { schemaVersion: 2 })
    if (field === 'path')
      checkpoint.input.storageKey = 'runtime/provenance/r-stage-checkpoints/wrong.rds'
    if (field === 'size') checkpoint.input.sizeBytes += 1
    if (field === 'oversize') checkpoint.input.sizeBytes = MAX_R_STAGE_CHECKPOINT_BYTES + 1
    if (field === 'unknown-state') Object.assign(checkpoint, { state: 'future-format' })
    await writeCheckpointRun('notebook', run)
    await expect(validateProvenanceMigrationState(root)).rejects.toThrow(/checkpoint/i)
  })

  it.each<RunLocation>(['notebook', 'artifact', 'workflow'])(
    'preserves legacy and explicitly unavailable %s runs',
    async (location) => {
      const run = await checkpointRun()
      delete run.stageCheckpoint
      await writeCheckpointRun(location, run)
      await expect(validateProvenanceMigrationState(root)).resolves.toBeUndefined()
      run.stageCheckpoint = { state: 'unavailable', reason: 'historical-state-unavailable' }
      await writeCheckpointRun(location, run)
      await expect(validateProvenanceMigrationState(root)).resolves.toBeUndefined()
    }
  )
})

describe('validateProvenanceMigrationState', () => {
  it('accepts dirty Environment cache state because relocation rebuilds the runtime', async () => {
    const target = join(root, 'runtime', 'provenance', 'environment-inventory', 'environment-key')
    await mkdir(join(target, 'operations'), { recursive: true })
    await writeFile(
      join(target, 'binding.json'),
      JSON.stringify({
        schemaVersion: 1,
        generation: 1,
        state: 'dirty',
        dirtyOperationId: 'operation-1',
        dirtyReason: 'package-mutation',
        operationLog: []
      })
    )
    await writeFile(join(target, 'operations', 'operation-1.json'), '{}')

    await expect(validateProvenanceMigrationState(root)).resolves.toBeUndefined()
  })

  it.each(['operation-orphaned.json', 'operation-orphaned.json.123.tmp'])(
    'accepts a clean Environment binding with an unbound operation file: %s',
    async (operationFilename) => {
      const target = join(root, 'runtime', 'provenance', 'environment-inventory', 'environment-key')
      await mkdir(join(target, 'operations'), { recursive: true })
      await writeFile(
        join(target, 'binding.json'),
        JSON.stringify({
          schemaVersion: 1,
          generation: 1,
          state: 'clean',
          operationLog: []
        })
      )
      await writeFile(join(target, 'operations', operationFilename), '{}')

      await expect(validateProvenanceMigrationState(root)).resolves.toBeUndefined()
    }
  )

  it('ignores malformed Environment cache metadata that relocation does not preserve', async () => {
    const target = join(root, 'runtime', 'provenance', 'environment-inventory', 'environment-key')
    await mkdir(target, { recursive: true })
    await writeFile(
      join(target, 'binding.json'),
      JSON.stringify({
        schemaVersion: 1,
        generation: 1,
        state: 'clean',
        operationLog: [],
        operationLogTruncation: { omittedCount: 0 }
      })
    )

    await expect(validateProvenanceMigrationState(root)).resolves.toBeUndefined()
  })

  it('refuses a pending runtime operation from the authoritative recovery journal', async () => {
    const runtimeRoot = join(root, 'runtime')
    const journal = RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot))
    await journal.begin({
      operationId: 'operation-installing',
      kind: 'install',
      runtimeId: 'default-python',
      phase: 'install-python',
      startedAt: Date.now(),
      targetPath: join(runtimeRoot, 'envs', 'default-python')
    })

    await expect(validateProvenanceMigrationState(root)).rejects.toThrow(
      /unfinished Runtime operation blocks migration: operation-installing/i
    )
  })

  it('refuses a corrupt runtime operation journal instead of treating it as empty', async () => {
    const runtimeRoot = join(root, 'runtime')
    await mkdir(runtimeRoot, { recursive: true })
    await writeFile(operationJournalPath(runtimeRoot), '{ not valid json')

    await expect(validateProvenanceMigrationState(root)).rejects.toThrow(
      /Runtime operation journal is corrupt/i
    )
  })

  it('refuses an Artifact staging directory that has not reached an immutable lifecycle state', async () => {
    await mkdir(
      join(
        root,
        'artifacts',
        'project-1',
        'session-1',
        '.provenance',
        '.staging',
        'versions',
        'version-1'
      ),
      { recursive: true }
    )

    await expect(validateProvenanceMigrationState(root)).rejects.toThrow(
      /unfinished Artifact staging/i
    )
  })

  it('refuses a corrupt SQLite authority store', async () => {
    await writeFile(join(root, 'open-science.db'), 'not a sqlite database')

    await expect(validateProvenanceMigrationState(root)).rejects.toThrow(/database|sqlite/i)
  })

  it('accepts an internally consistent SQLite authority store', async () => {
    const client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    await client.$disconnect()

    await expect(validateProvenanceMigrationState(root)).resolves.toBeUndefined()
  })

  it('validates the fixed config-root SQLite authority against a separate data root', async () => {
    const authorityRoot = join(root, 'config')
    const dataRoot = join(root, 'data')
    await Promise.all([
      mkdir(authorityRoot, { recursive: true }),
      mkdir(dataRoot, { recursive: true })
    ])
    const client = createProjectDbClient(authorityRoot)
    await migrateApplicationDatabase(client)
    await client.$disconnect()
    // A stray database under dataRoot is not authoritative and must never be copied or selected.
    await writeFile(join(dataRoot, 'open-science.db'), 'not the authority database')

    await expect(validateProvenanceMigrationState(dataRoot, authorityRoot)).resolves.toBeUndefined()
  }, 30_000)

  it('accepts an Upload input whose frozen name is the original pre-sanitized filename', async () => {
    const client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    const uploadContent = 'group\nA\n'
    const uploadChecksum = sha256(uploadContent)
    const uploadKey = 'uploads/project-1/session-1/upload-1/versions/upload-version-1/content'
    await mkdir(join(root, 'uploads/project-1/session-1/upload-1/versions/upload-version-1'), {
      recursive: true
    })
    await writeFile(join(root, uploadKey), uploadContent)
    await client.uploadFile.create({
      data: {
        id: 'upload-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        filename: 'groups_.csv',
        originalFilename: 'groups?.csv',
        versions: {
          create: {
            id: 'upload-version-1',
            versionNumber: 1,
            state: 'ready',
            contentStorageKey: uploadKey,
            filename: 'groups_.csv',
            originalFilename: 'groups?.csv',
            contentType: 'text/csv',
            sizeBytes: BigInt(Buffer.byteLength(uploadContent)),
            checksum: uploadChecksum
          }
        }
      }
    })
    await client.artifactLineage.create({
      data: {
        id: 'artifact-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        normalizedFilename: 'result.txt',
        filename: 'result.txt'
      }
    })
    const artifactContent = 'result'
    const artifactChecksum = sha256(artifactContent)
    const versionRoot =
      'artifacts/project-1/session-1/.provenance/artifact-1/versions/artifact-version-1'
    const evidence = JSON.stringify({
      schema_version: 1,
      project_id: 'project-1',
      app_session_id: 'session-1',
      artifact_id: 'artifact-1',
      version_id: 'artifact-version-1',
      size_bytes: Buffer.byteLength(artifactContent),
      checksum: artifactChecksum,
      execution_status: { state: 'unavailable' }
    })
    await mkdir(join(root, versionRoot), { recursive: true })
    await Promise.all([
      writeFile(join(root, versionRoot, 'content'), artifactContent),
      writeFile(join(root, versionRoot, 'evidence.json'), evidence)
    ])
    await client.artifactVersion.create({
      data: {
        id: 'artifact-version-1',
        artifactId: 'artifact-1',
        versionNumber: 1,
        filename: 'result.txt',
        artifactRunId: 'artifact-run-1',
        rootFrameId: 'root-1',
        agentFrameId: 'agent-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'prompt-1',
        state: 'pending',
        contentStorageKey: `${versionRoot}/content`,
        evidenceStorageKey: `${versionRoot}/evidence.json`,
        evidenceSchemaVersion: 1,
        contentType: 'text/plain',
        sizeBytes: BigInt(Buffer.byteLength(artifactContent)),
        checksum: artifactChecksum,
        evidenceJson: evidence,
        evidenceChecksum: sha256(evidence),
        inputs: {
          create: {
            id: 'input-1',
            ordinal: 0,
            inputFileVersionId: 'upload-version-1',
            sourceKind: 'upload-version',
            sourceFileId: 'upload-1',
            sourceUploadVersionId: 'upload-version-1',
            sourceVersionNumber: 1,
            sourceProjectId: 'project-1',
            sourceSessionId: 'session-1',
            filename: 'groups?.csv',
            contentType: 'text/csv',
            sizeBytes: BigInt(Buffer.byteLength(uploadContent)),
            checksum: uploadChecksum,
            storageKey: uploadKey,
            strongestAssociation: 'turn-attached'
          }
        }
      }
    })
    await client.$disconnect()

    await expect(validateProvenanceMigrationState(root)).resolves.toBeUndefined()
  })

  it('rejects Artifact bytes whose storage key is not owned by their lineage and Version', async () => {
    const authorityRoot = join(root, 'config')
    const dataRoot = join(root, 'data')
    await Promise.all([
      mkdir(authorityRoot, { recursive: true }),
      mkdir(dataRoot, { recursive: true })
    ])
    const client = createProjectDbClient(authorityRoot)
    await migrateApplicationDatabase(client)
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client.artifactLineage.create({
      data: {
        id: 'artifact-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        normalizedFilename: 'result.txt',
        filename: 'result.txt'
      }
    })
    const evidence = '{}'
    await client.artifactVersion.create({
      data: {
        id: 'version-1',
        artifactId: 'artifact-1',
        versionNumber: 1,
        filename: 'result.txt',
        artifactRunId: 'artifact-run-1',
        rootFrameId: 'root-1',
        agentFrameId: 'agent-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'prompt-1',
        state: 'pending',
        contentStorageKey:
          'artifacts/project-2/session-2/.provenance/artifact-1/versions/version-1/content',
        evidenceStorageKey:
          'artifacts/project-1/session-1/.provenance/artifact-1/versions/version-1/evidence.json',
        evidenceSchemaVersion: 1,
        contentType: 'text/plain',
        sizeBytes: 0,
        checksum: sha256(''),
        evidenceJson: evidence,
        evidenceChecksum: sha256(evidence)
      }
    })
    await client.$disconnect()

    await expect(validateProvenanceMigrationState(dataRoot, authorityRoot)).rejects.toThrow(
      /storage ownership is invalid/i
    )
  })

  it('rejects a Message snapshot whose payload identity does not match its row', async () => {
    const authorityRoot = join(root, 'config')
    const dataRoot = join(root, 'data')
    await Promise.all([
      mkdir(authorityRoot, { recursive: true }),
      mkdir(dataRoot, { recursive: true })
    ])
    const client = createProjectDbClient(authorityRoot)
    await migrateApplicationDatabase(client)
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    const payload = JSON.stringify({
      schemaVersion: 3,
      snapshotId: 'snapshot-1',
      rootFrameId: 'root-1',
      agentFrameId: 'agent-1',
      messageBranchId: 'branch-1',
      terminalMessageId: 'wrong-message',
      messages: []
    })
    const key = 'artifacts/project-1/session-1/.provenance/message-snapshots/snapshot-1.json'
    await mkdir(join(dataRoot, 'artifacts/project-1/session-1/.provenance/message-snapshots'), {
      recursive: true
    })
    await writeFile(join(dataRoot, key), payload)
    await client.artifactMessageSnapshot.create({
      data: {
        id: 'snapshot-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        rootFrameId: 'root-1',
        agentFrameId: 'agent-1',
        messageBranchId: 'branch-1',
        terminalMessageId: 'message-1',
        state: 'ready',
        storageKey: key,
        checksum: sha256(payload),
        messageCount: 0
      }
    })
    await client.$disconnect()

    await expect(validateProvenanceMigrationState(dataRoot, authorityRoot)).rejects.toThrow(
      /Message snapshot ownership is invalid/i
    )
  })

  it('accepts a valid legacy Message snapshot whose checksum was never recorded', async () => {
    const authorityRoot = join(root, 'config')
    const dataRoot = join(root, 'data')
    await Promise.all([
      mkdir(authorityRoot, { recursive: true }),
      mkdir(dataRoot, { recursive: true })
    ])
    const client = createProjectDbClient(authorityRoot)
    await migrateApplicationDatabase(client)
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    const payload = JSON.stringify({
      schemaVersion: 2,
      snapshotId: 'snapshot-legacy',
      rootFrameId: 'root-1',
      agentFrameId: 'agent-1',
      messageBranchId: 'branch-1',
      terminalMessageId: 'message-1',
      messages: []
    })
    const key = 'artifacts/project-1/session-1/.provenance/message-snapshots/snapshot-legacy.json'
    await mkdir(join(dataRoot, 'artifacts/project-1/session-1/.provenance/message-snapshots'), {
      recursive: true
    })
    await writeFile(join(dataRoot, key), payload)
    await client.artifactMessageSnapshot.create({
      data: {
        id: 'snapshot-legacy',
        projectId: 'project-1',
        sessionId: 'session-1',
        rootFrameId: 'root-1',
        agentFrameId: 'agent-1',
        messageBranchId: 'branch-1',
        terminalMessageId: 'message-1',
        state: 'ready',
        storageKey: key,
        checksum: '',
        messageCount: 0
      }
    })
    await client.$disconnect()

    await expect(validateProvenanceMigrationState(dataRoot, authorityRoot)).resolves.toBeUndefined()

    const reopened = createProjectDbClient(authorityRoot)
    await reopened.artifactMessageSnapshot.update({
      where: { id: 'snapshot-legacy' },
      data: { checksum: 'f'.repeat(64) }
    })
    await reopened.$disconnect()
    await expect(validateProvenanceMigrationState(dataRoot, authorityRoot)).rejects.toThrow(
      /Message snapshot checksum mismatch/i
    )
  })

  it('rejects a Review snapshot whose frozen scope belongs to another Session', async () => {
    const authorityRoot = join(root, 'config')
    const dataRoot = join(root, 'data')
    await Promise.all([
      mkdir(authorityRoot, { recursive: true }),
      mkdir(dataRoot, { recursive: true })
    ])
    const client = createProjectDbClient(authorityRoot)
    await migrateApplicationDatabase(client)
    const scope = {
      turnMessageId: 'message-1',
      agentFrameId: 'agent-1',
      messageBranchId: 'branch-1'
    }
    await client.review.create({
      data: {
        id: 'review-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        turnMessageId: 'message-1',
        scope: JSON.stringify(scope)
      }
    })
    const payload = JSON.stringify({
      schemaVersion: 2,
      snapshotId: 'review-snapshot-1',
      reviewId: 'review-1',
      projectId: 'project-1',
      sessionId: 'session-2',
      scope,
      agentFrameId: 'agent-1',
      messageBranchId: 'branch-1',
      blocks: []
    })
    const key =
      'artifacts/project-1/session-1/.provenance/review-scope-snapshots/review-snapshot-1.json'
    await mkdir(
      join(dataRoot, 'artifacts/project-1/session-1/.provenance/review-scope-snapshots'),
      { recursive: true }
    )
    await writeFile(join(dataRoot, key), payload)
    await client.reviewScopeSnapshot.create({
      data: {
        id: 'review-snapshot-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        reviewId: 'review-1',
        scopeTurnMessageId: 'message-1',
        state: 'ready',
        snapshotJson: payload,
        checksum: sha256(payload),
        storageKey: key,
        schemaVersion: 2,
        blockCount: 0
      }
    })
    await client.$disconnect()

    await expect(validateProvenanceMigrationState(dataRoot, authorityRoot)).rejects.toThrow(
      /Review snapshot ownership is invalid/i
    )
  })

  it('refuses a malformed Session conversation graph in the fixed config root', async () => {
    const authorityRoot = join(root, 'config')
    const sessionDirectory = join(authorityRoot, 'sessions', 'project-1')
    await mkdir(sessionDirectory, { recursive: true })
    await writeFile(
      join(sessionDirectory, 'session-1.json'),
      JSON.stringify({
        version: 2,
        session: {
          id: 'session-1',
          projectId: 'project-1',
          title: 'Invalid graph',
          cwd: '/workspace',
          status: 'idle',
          messages: [],
          conversationGraph: {
            schemaVersion: 1,
            rootFrameId: 'missing-frame',
            activeFrameId: 'missing-frame',
            frames: [],
            branches: [],
            messages: [],
            activities: [],
            activityGroups: [],
            runtimeSegments: []
          },
          createdAt: 1,
          updatedAt: 1
        }
      })
    )

    await expect(validateProvenanceMigrationState(root, authorityRoot)).rejects.toThrow(
      /Session graph ownership is invalid/i
    )
  })

  it('refuses unfinished Upload transfer bytes under a Project staging directory', async () => {
    const staging = join(root, 'uploads', 'default-project', '.staging')
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'transfer.part'), 'partial')

    await expect(validateProvenanceMigrationState(root)).rejects.toThrow(
      /unfinished Upload staging/i
    )
  })

  it('validates self-contained immutable Artifact bytes without requiring its cache manifest', async () => {
    const content = Buffer.from('artifact bytes')
    const checksum = createHash('sha256').update(content).digest('hex')
    const manifestChecksum = 'f'.repeat(64)
    const versionDirectory = join(
      root,
      'artifacts',
      'project-1',
      'session-1',
      '.provenance',
      'artifact-1',
      'versions',
      'version-1'
    )
    await mkdir(versionDirectory, { recursive: true })
    await writeFile(join(versionDirectory, 'content'), content)
    await writeFile(
      join(versionDirectory, 'evidence.json'),
      JSON.stringify({
        schema_version: 1,
        project_id: 'project-1',
        app_session_id: 'session-1',
        artifact_id: 'artifact-1',
        version_id: 'version-1',
        version_number: 1,
        filename: 'result.txt',
        size_bytes: content.byteLength,
        checksum,
        environment: { source_manifest_checksum: manifestChecksum },
        execution_status: { state: 'unavailable' }
      })
    )
    await expect(validateProvenanceMigrationState(root)).resolves.toBeUndefined()
    const receipt = await new ArtifactReproducibilityReceiptStore({
      resolveVersionDirectory: async () => versionDirectory
    }).append(
      {
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: 'artifact-1',
        versionId: 'version-1'
      },
      {
        schemaVersion: 1,
        receiptId: 'attempt-1',
        startedAt: '2026-09-02T00:00:00.000Z',
        completedAt: '2026-09-02T00:01:00.000Z',
        outcome: 'matched',
        artifactVersion: {
          projectId: 'project-1',
          appSessionId: 'session-1',
          artifactId: 'artifact-1',
          versionId: 'version-1',
          targetChecksum: checksum
        },
        frontier: { frontierId: 'original-inputs', claimScope: 'end-to-end' },
        recipe: { recipeId: 'a'.repeat(64), graphChecksum: 'b'.repeat(64) },
        environmentLocks: [],
        completedStepIds: ['notebook:run-1'],
        comparisons: [
          {
            stepId: 'notebook:run-1',
            entityId: 'file-1',
            relativePath: 'result.txt',
            expectedChecksum: checksum,
            expectedSizeBytes: content.byteLength,
            actualChecksum: checksum,
            actualSizeBytes: content.byteLength,
            status: 'matched'
          }
        ]
      }
    )
    const receiptPath = join(
      versionDirectory,
      'reproducibility-checks',
      `sha256-${receipt.receiptChecksum}.json`
    )
    const receiptContents = await readFile(receiptPath, 'utf8')
    const logPath = join(
      versionDirectory,
      'reproducibility-checks',
      'logs',
      `sha256-${receipt.checkLog!.logChecksum}.json`
    )
    const logContents = await readFile(logPath, 'utf8')
    await expect(validateProvenanceMigrationState(root)).resolves.toBeUndefined()
    await writeFile(logPath, logContents.replace('"truncated":false', '"truncated":true'))
    await expect(validateProvenanceMigrationState(root)).rejects.toThrow(
      /reproducibility check log checksum mismatch/i
    )
    await writeFile(logPath, logContents)
    await writeFile(
      join(versionDirectory, 'reproducibility-checks', 'history-index.json'),
      '{broken'
    )
    await expect(validateProvenanceMigrationState(root)).resolves.toBeUndefined()
    await writeFile(
      receiptPath,
      receiptContents.replace('"outcome":"matched"', '"outcome":"different"')
    )
    await expect(validateProvenanceMigrationState(root)).rejects.toThrow(
      /reproducibility receipt checksum mismatch/i
    )
    await writeFile(receiptPath, receiptContents)
    await writeFile(join(versionDirectory, 'content'), Buffer.from('artifact bytez'))
    await expect(validateProvenanceMigrationState(root)).rejects.toThrow(/content checksum/i)
  })

  it('refuses an Artifact execution snapshot with a malformed reproduction recipe', async () => {
    const content = Buffer.from('artifact bytes')
    const checksum = sha256(content)
    const execution = JSON.stringify({
      schemaVersion: 2,
      reproducibilityRecipe: { schemaVersion: 1 }
    })
    const versionDirectory = join(
      root,
      'artifacts',
      'project-1',
      'session-1',
      '.provenance',
      'artifact-1',
      'versions',
      'version-1'
    )
    await mkdir(versionDirectory, { recursive: true })
    await writeFile(join(versionDirectory, 'content'), content)
    await writeFile(join(versionDirectory, 'execution.json'), execution)
    await writeFile(
      join(versionDirectory, 'evidence.json'),
      JSON.stringify({
        schema_version: 1,
        project_id: 'project-1',
        app_session_id: 'session-1',
        artifact_id: 'artifact-1',
        version_id: 'version-1',
        size_bytes: content.byteLength,
        checksum,
        execution_status: { state: 'available' },
        execution_snapshot_checksum: sha256(execution)
      })
    )

    await expect(validateProvenanceMigrationState(root)).rejects.toThrow(
      /reproducibility recipe is invalid/i
    )
  })

  it('validates only Environment manifests referenced by retained Notebook runs', async () => {
    const manifest = JSON.stringify({ schemaVersion: 1, environmentName: 'default-python' })
    const manifestChecksum = createHash('sha256').update(manifest).digest('hex')
    const manifestDirectory = join(root, 'runtime', 'provenance', 'environment-manifests')
    await mkdir(manifestDirectory, { recursive: true })
    await writeFile(join(manifestDirectory, `${manifestChecksum}.json`), manifest)
    await writeFile(join(manifestDirectory, `${'e'.repeat(64)}.json`), 'corrupt unused cache entry')
    const notebookDirectory = join(root, 'notebooks', 'project-1', 'notebook-session-1')
    await mkdir(notebookDirectory, { recursive: true })
    await writeFile(
      join(notebookDirectory, 'run.json'),
      JSON.stringify({
        version: 1,
        projectId: 'project-1',
        sessionId: 'notebook-session-1',
        runs: [
          {
            runId: 'run-1',
            environmentCapture: { state: 'available', manifestChecksum },
            environmentManifestChecksum: manifestChecksum
          }
        ]
      })
    )

    await expect(validateProvenanceMigrationState(root)).resolves.toBeUndefined()
    await writeFile(join(manifestDirectory, `${manifestChecksum}.json`), 'corrupt referenced entry')
    await expect(validateProvenanceMigrationState(root)).rejects.toThrow(
      /Notebook Environment manifest checksum mismatch/i
    )
  })

  it('validates content-addressed Environment locks referenced by Notebook runs', async () => {
    const manifest = JSON.stringify({ schemaVersion: 1, environmentName: 'default-python' })
    const manifestChecksum = sha256(manifest)
    const manifestDirectory = join(root, 'runtime', 'provenance', 'environment-manifests')
    await mkdir(manifestDirectory, { recursive: true })
    await writeFile(join(manifestDirectory, `${manifestChecksum}.json`), manifest)

    const lock = JSON.stringify({
      schemaVersion: 1,
      format: 'environment-lock-bundle',
      kernelKind: 'python',
      environmentName: 'default-python',
      components: [
        {
          ecosystem: 'conda',
          format: 'conda-explicit-md5',
          resolution: 'locked',
          explicitLock:
            '@EXPLICIT\nhttps://conda.example/linux-64/numpy.conda#0123456789abcdef0123456789abcdef\n',
          packages: ['numpy']
        }
      ]
    })
    const lockChecksum = sha256(lock)
    const lockDirectory = join(root, 'runtime', 'provenance', 'environment-locks')
    await mkdir(lockDirectory, { recursive: true })
    await writeFile(join(lockDirectory, `${lockChecksum}.json`), lock)

    const notebookDirectory = join(root, 'notebooks', 'project-1', 'notebook-session-1')
    await mkdir(notebookDirectory, { recursive: true })
    await writeFile(
      join(notebookDirectory, 'run.json'),
      JSON.stringify({
        version: 1,
        projectId: 'project-1',
        sessionId: 'notebook-session-1',
        runs: [
          {
            runId: 'run-1',
            environmentCapture: { state: 'available', manifestChecksum },
            environmentManifestChecksum: manifestChecksum,
            environmentLock: {
              state: 'available',
              format: 'environment-lock-bundle',
              lockChecksum
            }
          }
        ]
      })
    )

    await expect(validateProvenanceMigrationState(root)).resolves.toBeUndefined()
    await writeFile(join(lockDirectory, `${lockChecksum}.json`), `${lock}\n`)
    await expect(validateProvenanceMigrationState(root)).rejects.toThrow(
      /Environment lock checksum mismatch/i
    )
  })
})
