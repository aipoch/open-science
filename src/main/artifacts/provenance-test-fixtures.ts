import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CreateArtifactVersionRequest } from '../../shared/artifact-provenance'
import { NotebookRunRepository } from '../notebook/repository'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { createPngInlineSource } from './artifact-test-fixtures'
import {
  ArtifactProvenanceRepository,
  type ArtifactProvenanceRepositoryOptions
} from './provenance-repository'
import { ArtifactRepository } from './repository'

export const provenanceGraph = {
  rootFrameId: 'root-frame-1',
  agentFrameId: 'agent-frame-1',
  messageBranchId: 'branch-1',
  runtimeSegmentId: 'runtime-segment-1',
  promptMessageId: 'prompt-1'
} as const

export const createArtifactVersionRequest = (
  overrides: Partial<CreateArtifactVersionRequest> = {}
): CreateArtifactVersionRequest => ({
  projectId: 'project-1',
  appSessionId: 'session-1',
  artifactStorageSessionId: 'artifact-session-1',
  artifactRunId: 'artifact-run-1',
  writeOperationId: 'write-1',
  writeRequestChecksum: 'a'.repeat(64),
  ...provenanceGraph,
  filename: 'plot.png',
  contentType: 'image/png',
  ...overrides
})

export const createProvenanceTestFixture = async (): Promise<{
  storageRoot: string
  client: ReturnType<typeof createProjectDbClient>
  compatibilityRepository: ArtifactRepository
  notebookRepository: NotebookRunRepository
  repositoryOptions: ArtifactProvenanceRepositoryOptions
  repository: ArtifactProvenanceRepository
  stagePng: (payload: string, filename?: string) => Promise<void>
  dispose: () => Promise<void>
}> => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'open-science-provenance-contract-'))
  const client = createProjectDbClient(storageRoot)
  try {
    await migrateApplicationDatabase(client)
  } catch (error) {
    await client.$disconnect().catch(() => undefined)
    await rm(storageRoot, { recursive: true, force: true })
    throw error
  }
  const compatibilityRepository = new ArtifactRepository(storageRoot)
  const notebookRepository = new NotebookRunRepository(storageRoot)
  const repositoryOptions = {
    storageRoot,
    getClient: () => Promise.resolve(client),
    compatibilityRepository,
    notebookRepository
  }
  const repository = new ArtifactProvenanceRepository(repositoryOptions)
  return {
    storageRoot,
    client,
    compatibilityRepository,
    notebookRepository,
    repositoryOptions,
    repository,
    stagePng: async (payload, filename = 'plot.png') => {
      await compatibilityRepository.writePendingFile({
        projectId: 'project-1',
        sessionId: 'artifact-session-1',
        runId: 'artifact-run-1',
        filename,
        mimeType: 'image/png',
        source: createPngInlineSource(payload)
      })
    },
    dispose: async () => {
      try {
        await client.$disconnect()
      } finally {
        await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      }
    }
  }
}
