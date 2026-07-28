import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { PrismaClient } from '@prisma/client'
import { afterEach, describe, expect, it } from 'vitest'

import { createProjectDbClient, ensureProjectSchema } from '../projects/prisma-client'
import { NotebookInputRegistry } from './input-registry'
import { createNotebookInputPreviewKey } from '../../shared/notebook'

let storageRoot: string | undefined
let client: PrismaClient | undefined

afterEach(async () => {
  await client?.$disconnect()
  client = undefined
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  storageRoot = undefined
})

const checksum = (content: string): string => createHash('sha256').update(content).digest('hex')

const writeManagedContent = async (storageKey: string, content: string): Promise<void> => {
  if (!storageRoot) throw new Error('Test storage is not initialized.')
  const path = join(storageRoot, ...storageKey.split('/'))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

const createUpload = async (input: {
  projectId: string
  sessionId: string
  uploadFileId: string
  versionId: string
  filename: string
  content: string
}): Promise<string> => {
  if (!client) throw new Error('Test database is not initialized.')
  const storageKey = `uploads/${input.projectId}/${input.sessionId}/${input.uploadFileId}/${input.versionId}/content`
  await writeManagedContent(storageKey, input.content)
  await client.fileOriginSession.upsert({
    where: {
      projectId_sessionId: { projectId: input.projectId, sessionId: input.sessionId }
    },
    create: { projectId: input.projectId, sessionId: input.sessionId },
    update: {}
  })
  await client.uploadFile.create({
    data: {
      id: input.uploadFileId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      filename: input.filename,
      originalFilename: input.filename,
      versions: {
        create: {
          id: input.versionId,
          versionNumber: 1,
          state: 'ready',
          contentStorageKey: storageKey,
          filename: input.filename,
          originalFilename: input.filename,
          contentType: 'text/csv',
          sizeBytes: BigInt(Buffer.byteLength(input.content)),
          checksum: checksum(input.content),
          createdAt: new Date('2026-07-27T10:00:00.000Z')
        }
      }
    }
  })
  return storageKey
}

const createArtifact = async (input: {
  projectId: string
  sessionId: string
  artifactId: string
  versionId: string
  filename: string
  content: string
}): Promise<void> => {
  if (!client) throw new Error('Test database is not initialized.')
  const contentStorageKey = `artifacts/${input.projectId}/${input.sessionId}/.provenance/${input.artifactId}/versions/${input.versionId}/content`
  await writeManagedContent(contentStorageKey, input.content)
  await client.fileOriginSession.upsert({
    where: {
      projectId_sessionId: { projectId: input.projectId, sessionId: input.sessionId }
    },
    create: { projectId: input.projectId, sessionId: input.sessionId },
    update: {}
  })
  await client.artifactLineage.create({
    data: {
      id: input.artifactId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      normalizedFilename: input.filename.toLowerCase(),
      filename: input.filename,
      versions: {
        create: {
          id: input.versionId,
          versionNumber: 1,
          artifactRunId: 'artifact-run-source',
          rootFrameId: 'root-source',
          agentFrameId: 'agent-source',
          messageBranchId: 'branch-source',
          runtimeSegmentId: 'runtime-source',
          promptMessageId: 'prompt-source',
          state: 'finalized',
          contentStorageKey,
          evidenceStorageKey: `${dirname(contentStorageKey)}/evidence.json`,
          contentType: 'text/csv',
          sizeBytes: BigInt(Buffer.byteLength(input.content)),
          checksum: checksum(input.content),
          evidenceJson: '{}',
          evidenceChecksum: checksum('{}'),
          createdAt: new Date('2026-07-27T10:05:00.000Z')
        }
      }
    }
  })
}

const setup = async (): Promise<NotebookInputRegistry> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-input-registry-'))
  client = createProjectDbClient(storageRoot)
  await ensureProjectSchema(client)
  return new NotebookInputRegistry({ storageRoot, getClient: () => Promise.resolve(client!) })
}

describe('NotebookInputRegistry', () => {
  it('freezes exact Upload and Artifact Versions in turn order without exposing absolute paths', async () => {
    const registry = await setup()
    await createUpload({
      projectId: 'project-1',
      sessionId: 'source-session-1',
      uploadFileId: 'upload-1',
      versionId: 'upload-version-1',
      filename: 'groups.csv',
      content: 'group\nA\n'
    })
    await createArtifact({
      projectId: 'project-1',
      sessionId: 'source-session-2',
      artifactId: 'artifact-1',
      versionId: 'artifact-version-1',
      filename: 'normalized.csv',
      content: 'value\n1\n'
    })

    await registry.registerTurn({
      projectId: 'project-1',
      appSessionId: 'active-session',
      promptMessageId: 'prompt-1',
      uploads: [
        {
          id: 'upload-1',
          versionId: 'upload-version-1',
          versionNumber: 1,
          sessionId: 'source-session-1',
          name: 'groups.csv',
          originalName: 'groups.csv',
          path: '/untrusted-renderer-path',
          size: 8
        }
      ],
      references: [
        {
          id: 'artifact-1',
          versionId: 'artifact-version-1',
          source: 'artifact',
          name: 'normalized.csv',
          path: '/another-untrusted-path'
        }
      ]
    })

    const inputs = registry.getTurnInputs({
      projectId: 'project-1',
      appSessionId: 'active-session',
      promptMessageId: 'prompt-1'
    })
    expect(inputs.map((input) => [input.sourceKind, input.inputFileVersionId])).toEqual([
      ['upload-version', 'upload-version-1'],
      ['artifact-version', 'artifact-version-1']
    ])
    expect(inputs[0]).toMatchObject({
      sourceFileId: 'upload-1',
      sourceSessionId: 'source-session-1',
      association: 'turn-attached'
    })
    expect(inputs[0]?.storageKey).not.toContain('/untrusted-renderer-path')
    await expect(
      registry.readPreview({
        path: createNotebookInputPreviewKey({
          projectId: 'project-1',
          sourceKind: 'upload-version',
          inputFileVersionId: 'upload-version-1'
        }),
        encoding: 'utf8'
      })
    ).resolves.toMatchObject({ content: 'group\nA\n', size: 8 })
  })

  it('skips legacy Project File references without blocking immutable turn inputs', async () => {
    const registry = await setup()
    await createArtifact({
      projectId: 'project-1',
      sessionId: 'source-session-1',
      artifactId: 'artifact-1',
      versionId: 'artifact-version-1',
      filename: 'normalized.csv',
      content: 'value\n1\n'
    })

    await expect(
      registry.registerTurn({
        projectId: 'project-1',
        appSessionId: 'active-session',
        promptMessageId: 'prompt-1',
        uploads: [],
        references: [
          {
            id: 'legacy-upload',
            source: 'upload',
            name: 'legacy.csv',
            path: '/legacy/path.csv'
          },
          {
            id: 'artifact-1',
            versionId: 'artifact-version-1',
            source: 'artifact',
            name: 'normalized.csv',
            path: '/ignored'
          }
        ]
      })
    ).resolves.toBeUndefined()

    expect(
      registry.getTurnInputs({
        projectId: 'project-1',
        appSessionId: 'active-session',
        promptMessageId: 'prompt-1'
      })
    ).toEqual([
      expect.objectContaining({
        sourceKind: 'artifact-version',
        inputFileVersionId: 'artifact-version-1'
      })
    ])
  })

  it('upgrades only resolver-used Versions on an execution-scoped run lease', async () => {
    const registry = await setup()
    const storageKey = await createUpload({
      projectId: 'project-1',
      sessionId: 'source-session-1',
      uploadFileId: 'upload-1',
      versionId: 'upload-version-1',
      filename: 'groups.csv',
      content: 'group\nA\n'
    })
    await registry.registerTurn({
      projectId: 'project-1',
      appSessionId: 'active-session',
      promptMessageId: 'prompt-1',
      uploads: [
        {
          id: 'upload-1',
          versionId: 'upload-version-1',
          versionNumber: 1,
          sessionId: 'source-session-1',
          name: 'groups.csv',
          originalName: 'groups.csv',
          path: '/ignored',
          size: 8
        }
      ],
      references: []
    })

    const lease = await registry.openRun({
      projectId: 'project-1',
      appSessionId: 'active-session',
      promptMessageId: 'prompt-1'
    })
    expect(lease.getRunInputFiles()).toEqual([
      expect.objectContaining({ association: 'turn-attached' })
    ])
    await expect(
      lease.resolve({
        sourceKind: 'artifact-version',
        inputFileVersionId: 'upload-version-1'
      })
    ).rejects.toThrow(/not registered/i)
    await expect(
      lease.resolve({
        sourceKind: 'upload-version',
        inputFileVersionId: 'upload-version-1'
      })
    ).resolves.toBe(await realpath(join(storageRoot!, ...storageKey.split('/'))))
    expect(lease.close()).toEqual([expect.objectContaining({ association: 'resolver-accessed' })])
    expect(() => lease.getRunInputFiles()).toThrow(/closed/i)
  })

  it('rejects same-size input corruption before returning a managed path', async () => {
    const registry = await setup()
    const storageKey = await createUpload({
      projectId: 'project-1',
      sessionId: 'source-session-1',
      uploadFileId: 'upload-1',
      versionId: 'upload-version-1',
      filename: 'groups.csv',
      content: 'group\nA\n'
    })
    await writeManagedContent(storageKey, 'group\nB\n')

    await expect(
      registry.resolvePreview({
        projectId: 'project-1',
        sourceKind: 'upload-version',
        inputFileVersionId: 'upload-version-1'
      })
    ).rejects.toThrow(/checksum/i)
  })

  it('rejects cross-Project identities and conflicting registration for the same prompt', async () => {
    const registry = await setup()
    await createUpload({
      projectId: 'project-2',
      sessionId: 'session-2',
      uploadFileId: 'upload-2',
      versionId: 'upload-version-2',
      filename: 'private.csv',
      content: 'private'
    })

    await expect(
      registry.registerTurn({
        projectId: 'project-1',
        appSessionId: 'active-session',
        promptMessageId: 'prompt-1',
        uploads: [],
        references: [
          {
            id: 'upload-2',
            versionId: 'upload-version-2',
            source: 'upload',
            name: 'private.csv',
            path: '/ignored'
          }
        ]
      })
    ).rejects.toThrow(/unavailable in this Project/)
  })
})
