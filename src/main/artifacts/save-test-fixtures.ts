import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ArtifactRpcCapabilityBinding,
  ArtifactWriteSourceScope
} from '../../shared/artifact-provenance'
import { NotebookLocalRpcServer } from '../notebook/local-rpc-server'
import { NotebookRuntimeService } from '../notebook/runtime-service'
import { createProvenanceTestFixture, provenanceGraph } from './provenance-test-fixtures'
import { type ArtifactMcpEnvironment } from './mcp-server'

// The fixture exposes the exact composed production services to barrier-based integration tests.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export const createArtifactSaveFixture = async () => {
  const fixture = await createProvenanceTestFixture()
  const service = new NotebookRuntimeService({
    configRoot: fixture.storageRoot,
    dataRoot: fixture.storageRoot,
    projectId: 'project-1',
    repository: fixture.notebookRepository
  })
  const server = new NotebookLocalRpcServer(service, {
    transport: 'tcp',
    artifactProvenance: fixture.repository
  })
  const connection = await server.ensureStarted()
  const binding: ArtifactRpcCapabilityBinding = {
    ...provenanceGraph,
    projectId: 'project-1',
    appSessionId: 'session-1',
    artifactStorageSessionId: 'artifact-session-1',
    artifactRunId: 'artifact-run-1'
  }
  const environment = async (
    scope: ArtifactWriteSourceScope = { allowedImportRoots: [] },
    overrides: Partial<ArtifactRpcCapabilityBinding> = {}
  ): Promise<ArtifactMcpEnvironment> => {
    const bound = { ...binding, ...overrides, sourceScope: scope }
    const token = server.issueArtifactRunCapability(bound)
    const currentRunFile = join(fixture.storageRoot, `${bound.artifactRunId}-${token}.json`)
    await writeFile(
      currentRunFile,
      JSON.stringify({ ...bound, ...scope, rpcCapabilityToken: token })
    )
    return {
      storageRoot: fixture.storageRoot,
      projectId: bound.projectId,
      sessionId: bound.artifactStorageSessionId,
      currentRunFile,
      allowedImportRoots: scope.workspaceCwd ? [scope.workspaceCwd] : [],
      rpcEndpoint: connection.endpoint,
      rpcSocketPath: connection.socketPath
    }
  }
  return {
    ...fixture,
    server,
    connection,
    binding,
    environment,
    dispose: async () => {
      await server.close()
      await fixture.dispose()
    }
  }
}
