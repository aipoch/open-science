// Executed in a disposable process by the crash recovery integration suite.
import fs, { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectDbClient, migrateApplicationDatabase } from '../../projects/prisma-client'
import { ArtifactProvenanceRepository } from '../provenance-repository'
import { ArtifactRepository } from '../repository'
import { ArtifactStorageAccess } from '../storage-access'
import { defaultArtifactDurability } from '../durability'
import { NotebookLocalRpcServer } from '../../notebook/local-rpc-server'
import { NotebookRuntimeService } from '../../notebook/runtime-service'
import { NotebookRunRepository } from '../../notebook/repository'
import { writeArtifactFileForCurrentRun } from '../mcp-server'
import { createLinearConversationGraph } from '../../../shared/conversation-graph'
import type { PersistedChatSession } from '../../../shared/session-persistence'

const [root, phase] = process.argv.slice(2)
const pause = async (): Promise<never> => {
  process.send?.({ phase })
  return new Promise(() => undefined)
}
const main = async (): Promise<void> => {
  await mkdir(root, { recursive: true })
  const client = createProjectDbClient(root)
  await migrateApplicationDatabase(client)
  const compatibility = new ArtifactRepository(root)
  const messages: PersistedChatSession['messages'] = [
    {
      id: 'prompt-1',
      role: 'user',
      content: 'save',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'message-1',
      role: 'agent',
      content: 'done',
      status: 'complete',
      eventIds: [],
      createdAt: 2,
      updatedAt: 2
    }
  ]
  const graph = createLinearConversationGraph({
    sessionId: 'session-1',
    messages,
    frameworkId: 'codex',
    createdAt: 1,
    updatedAt: 2
  })
  let session: PersistedChatSession = {
    id: 'session-1',
    projectId: 'project-1',
    title: 'crash',
    cwd: root,
    status: 'idle',
    messages,
    conversationGraph: graph,
    createdAt: 1,
    updatedAt: 2
  }
  const binding = {
    projectId: 'project-1',
    appSessionId: 'session-1',
    artifactStorageSessionId: 'artifact-session-1',
    artifactRunId: 'artifact-run-1',
    rootFrameId: graph.rootFrameId,
    agentFrameId: graph.activeFrameId,
    messageBranchId: graph.branches[0].id,
    runtimeSegmentId: graph.runtimeSegments[0].id,
    promptMessageId: 'prompt-1',
    sourceScope: { allowedImportRoots: [root], workspaceCwd: root }
  }
  const repository = new ArtifactProvenanceRepository({
    storageRoot: root,
    getClient: () => Promise.resolve(client),
    compatibilityRepository: compatibility,
    loadSession: async () => session,
    durability: {
      ...defaultArtifactDurability,
      syncFile: async (path) => {
        await defaultArtifactDurability.syncFile(path)
        if (phase === 'before-version' && path.includes('.staging') && path.endsWith('content'))
          await pause()
        if (phase === 'staging' && path.includes('.staging') && path.endsWith('evidence.json'))
          await pause()
      }
    }
  })
  if (phase === 'recover') {
    try {
      session = JSON.parse(await readFile(join(root, 'session.json'), 'utf8'))
    } catch {
      /* no durable message before save */
    }
    const result = await repository.reconcileSession('project-1', 'session-1', session)
    const versions = await client.artifactVersion.findMany({
      select: { id: true, state: true, checksum: true, messageId: true, writeOperationId: true }
    })
    let replayedVersionId: string | undefined
    if (versions.length === 1 && versions[0].state === 'pending') {
      const replay = await repository.saveVersion(
        {
          ...binding,
          writeOperationId: versions[0].writeOperationId!,
          filename: 'first.txt',
          source: {
            kind: 'inline',
            content: Buffer.from('first crash-safe bytes').toString('base64'),
            encoding: 'base64'
          }
        },
        binding.sourceScope
      )
      replayedVersionId = replay.versionId
      if ((await client.artifactVersion.count()) !== 1)
        throw new Error('Crash replay created another Version.')
    }
    process.send?.({ recovered: result, versions, replayedVersionId })
    await client.$disconnect()
    return
  }
  const copySourcePath = join(root, 'copy-source.txt')
  if (phase === 'copying') {
    await writeFile(copySourcePath, Buffer.alloc(128 * 1024, 97))
    const resolvedSource = await fs.realpath(copySourcePath)
    const open = fs.open
    fs.open = async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      if (args[0] === resolvedSource) {
        const read = handle.read.bind(handle)
        let reads = 0
        handle.read = (async (...input: Parameters<typeof read>) => {
          if (++reads === 2) await pause()
          return read(...input)
        }) as typeof handle.read
      }
      return handle
    }
  }
  const service = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'project-1',
    repository: new NotebookRunRepository(root)
  })
  const server = new NotebookLocalRpcServer(service, {
    transport: 'tcp',
    artifactProvenance: {
      createVersion: (request, signal) => repository.createVersion(request, signal),
      saveVersion: async (request, scope, signal) => {
        const result = await repository.saveVersion(request, scope, signal)
        if (phase === 'committed') await pause()
        return result
      }
    }
  })
  const connection = await server.ensureStarted()
  const currentRunFile = join(root, 'current-run.json')
  await writeFile(
    currentRunFile,
    JSON.stringify({ ...binding, rpcCapabilityToken: server.issueArtifactRunCapability(binding) })
  )
  const env = {
    storageRoot: root,
    sessionId: binding.artifactStorageSessionId,
    projectId: binding.projectId,
    currentRunFile,
    allowedImportRoots: [],
    rpcEndpoint: connection.endpoint
  }
  const first = await writeArtifactFileForCurrentRun(
    compatibility,
    env,
    phase === 'copying'
      ? { filename: 'first.txt', source: { kind: 'localPath', path: copySourcePath } }
      : { filename: 'first.txt', content: 'first crash-safe bytes' },
    { requestId: 'first' }
  )
  const second = await writeArtifactFileForCurrentRun(
    compatibility,
    env,
    { filename: 'second.txt', content: 'second crash-safe bytes' },
    { requestId: 'second' }
  )
  session.messages[1].artifactIds = [first.id, second.id]
  session.artifacts = [first, second].map((file) => ({
    ...file,
    kind: 'managed-file' as const,
    createdAt: Date.parse(file.createdAt)
  }))
  session.conversationGraph!.messages.find((message) => message.id === 'message-1')!.artifactIds = [
    first.id,
    second.id
  ]
  await writeFile(join(root, 'session.json'), JSON.stringify(session))
  const provenanceContext = {
    rootFrameId: binding.rootFrameId,
    agentFrameId: binding.agentFrameId,
    messageBranchId: binding.messageBranchId,
    runtimeSegmentId: binding.runtimeSegmentId,
    promptMessageId: binding.promptMessageId
  }
  const request = {
    ...binding,
    artifactVersionIds: [first.versionId!, second.versionId!],
    messageId: 'message-1'
  }
  await compatibility.prepareRunFinalization({
    projectId: binding.projectId,
    sessionId: binding.appSessionId,
    sourceSessionId: binding.artifactStorageSessionId,
    runId: binding.artifactRunId,
    artifactVersionIds: request.artifactVersionIds,
    provenanceContext
  })
  if (phase === 'prepared') await pause()
  const moveMetadata = ArtifactStorageAccess.prototype.moveArtifactMetadata
  ArtifactStorageAccess.prototype.moveArtifactMetadata = async function (...args) {
    if (phase === 'partial-publication') await pause()
    return moveMetadata.apply(this, args)
  }
  await repository.withSessionMutation(binding, async () => {
    await repository.finalizeRun(request)
    await compatibility.finalizeRunArtifacts({
      projectId: binding.projectId,
      sessionId: binding.appSessionId,
      sourceSessionId: binding.artifactStorageSessionId,
      runId: binding.artifactRunId,
      messageId: request.messageId,
      artifactVersionIds: request.artifactVersionIds,
      provenanceContext
    })
    await repository.activateFinalizedRun(request)
  })
  await server.close()
  await client.$disconnect()
}
void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  )
  process.exit(1)
})
