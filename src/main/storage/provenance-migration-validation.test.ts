import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { validateProvenanceMigrationState } from './provenance-migration-validation'
import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'

let root: string
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'open-science-provenance-migration-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('validateProvenanceMigrationState', () => {
  it('refuses a dirty Environment binding or unfinished operation', async () => {
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

    await expect(validateProvenanceMigrationState(root)).rejects.toThrow(
      /unfinished Environment operation/i
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
    await ensureProjectSchema(client)
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
    await ensureProjectSchema(client)
    await client.$disconnect()
    // A stray database under dataRoot is not authoritative and must never be copied or selected.
    await writeFile(join(dataRoot, 'open-science.db'), 'not the authority database')

    await expect(validateProvenanceMigrationState(dataRoot, authorityRoot)).resolves.toBeUndefined()
  })

  it('rejects Artifact bytes whose storage key is not owned by their lineage and Version', async () => {
    const authorityRoot = join(root, 'config')
    const dataRoot = join(root, 'data')
    await Promise.all([
      mkdir(authorityRoot, { recursive: true }),
      mkdir(dataRoot, { recursive: true })
    ])
    const client = createProjectDbClient(authorityRoot)
    await ensureProjectSchema(client)
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
    await ensureProjectSchema(client)
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
    await ensureProjectSchema(client)
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
    await ensureProjectSchema(client)
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
    await writeFile(join(versionDirectory, 'content'), Buffer.from('artifact bytez'))
    await expect(validateProvenanceMigrationState(root)).rejects.toThrow(/content checksum/i)
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
        projectName: 'project-1',
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
})
