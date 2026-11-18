import { acquireDataRootWriter } from '../storage/migration-state'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { createDefaultSessionRepository } from '../session-persistence/ipc'
import { createLogger } from '@aipoch/diagnostics/node'
import { ImageTaskOwner } from '../image-model/tasks'
import {
  ImageModelError,
  MAX_IMAGE_BYTES,
  imageArtifactContent,
  type ImageModelRequest,
  type ImageModelResult
} from '../image-model/contract'
import type { ImageModelService } from '../image-model/service'
import type { ApplicationModuleBuilder } from '../application-runtime'
import type { composeManagedFiles } from './managed-files'
import type { composeSessionAuthority } from './session-authority'
import { resolveDataRoot } from '../storage-root'
import { assertResearchSessionWritable } from '../storage/session-package-state'
import {
  ImageTaskIntegrityError,
  type ImageTaskScope,
  type ImageTaskStart,
  type ImageTaskResult
} from '../../shared/image-task'

export async function composeImageTasks({
  imageModel,
  managedFiles,
  sessionAuthority,
  sessionRepository,
  modules
}: {
  sessionRepository: ReturnType<typeof createDefaultSessionRepository>
  imageModel: ImageModelService
  managedFiles: ReturnType<typeof composeManagedFiles>
  sessionAuthority: Awaited<ReturnType<typeof composeSessionAuthority>>
  modules: ApplicationModuleBuilder
}): Promise<ImageTaskOwner> {
  const persistence = sessionAuthority.sessionPersistenceCoordinator
  const readSession = async (
    scope: ImageTaskScope,
    start?: ImageTaskStart
  ): Promise<PersistedChatSession> => {
    const loaded = await sessionRepository.loadSessionWithDiagnostics(
      scope.projectId,
      scope.sessionId,
      {
        mode: 'read-only'
      }
    )
    if (
      loaded.status === 'found' &&
      loaded.session.id === scope.sessionId &&
      loaded.session.projectId === scope.projectId
    )
      return loaded.session
    if (start)
      throw new ImageModelError('EDIT_CONTEXT_CHANGED', 'Image task Session is unavailable.')
    throw new Error('Image task Session is unavailable.')
  }
  const authorize = async (scope: ImageTaskScope, start?: ImageTaskStart): Promise<void> => {
    const session = await readSession(scope, start)
    if (start) {
      if (session.archivedAt)
        throw new ImageModelError(
          'EDIT_CONTEXT_CHANGED',
          'Image tasks cannot start in an archived Session.'
        )
      await assertResearchSessionWritable(resolveDataRoot(), scope.projectId, scope.sessionId)
      const frame = session.conversationGraph?.frames.find(({ id }) => id === start.frameId)
      if (!frame || frame.activeBranchId !== start.branchId)
        throw new ImageModelError(
          'EDIT_CONTEXT_CHANGED',
          'The image editor branch changed before submission.'
        )
    }
  }
  const authorizeTask = async (
    task: Pick<ImageTaskStart, 'id' | 'projectId' | 'sessionId' | 'frameId' | 'branchId'>
  ): Promise<void> => {
    const session = await readSession(task)
    if (
      !session.conversationGraph?.frames.some(({ id }) => id === task.frameId) ||
      !session.conversationGraph.branches.some(
        ({ id, agentFrameId }) => id === task.branchId && agentFrameId === task.frameId
      )
    )
      throw new ImageTaskIntegrityError([task.id])
  }
  return modules.add(undefined, () => {
    const prepare = async (request: ImageTaskStart) => {
      const execute = imageModel.capture(request.edit.model)
      const source = request.edit.source
      const input = await managedFiles.immutableInputAuthority.resolveVersion({
        projectId: request.projectId,
        sourceKind: source.sourceKind,
        inputFileVersionId: source.sourceVersionId,
        expectedSourceFileId: source.sourceFileId
      })
      if (!input || input.sourceSessionId !== source.sourceSessionId)
        throw new ImageModelError('SOURCE_UNAVAILABLE', 'Image task source Version is unavailable.')
      if (input.sizeBytes > MAX_IMAGE_BYTES)
        throw new ImageModelError(
          'SOURCE_LIMIT_EXCEEDED',
          'Image task source Version exceeds the size limit.'
        )
      const session = await readSession(request, request)
      const rootFrameId = session.conversationGraph?.rootFrameId
      if (!rootFrameId)
        throw new ImageModelError('EDIT_CONTEXT_CHANGED', 'Image task conversation is unavailable.')
      return async (
        signal: AbortSignal,
        onStarted: NonNullable<ImageModelRequest['onStarted']>
      ) => {
        await authorizeTask(request)
        const publishResult = async (result: ImageModelResult): Promise<ImageTaskResult> => {
          // A paid result must never be lost to a chat turn closing or a late cancellation.
          try {
            const publish = async (): Promise<ImageTaskResult> => {
              await authorizeTask(request)
              await assertResearchSessionWritable(
                resolveDataRoot(),
                request.projectId,
                request.sessionId
              )
              const { mimeType: contentType, ...content } = imageArtifactContent(result, {
                filename: source.name,
                operation: 'edit',
                invocationId: request.id,
                prompt: request.prompt,
                inputFiles: [input],
                task: { id: request.id, regionCount: request.edit.regions.length }
              })
              const artifact =
                await managedFiles.artifactProvenanceRepository.writeAppGeneratedVersion({
                  projectId: request.projectId,
                  appSessionId: request.sessionId,
                  artifactStorageSessionId: request.sessionId,
                  artifactRunId: request.id,
                  rootFrameId,
                  agentFrameId: request.frameId,
                  messageBranchId: request.branchId,
                  runtimeSegmentId: null,
                  promptMessageId: null,
                  imageTaskId: request.id,
                  ...content,
                  contentType
                })
              const published =
                await managedFiles.artifactProvenanceRepository.publishImageTaskVersion({
                  projectId: request.projectId,
                  appSessionId: request.sessionId,
                  taskId: request.id,
                  versionId: artifact.versionId,
                  sourceVersionId: source.sourceVersionId
                })
              const { artifactId, versionId, versionNumber, name, mimeType, size, checksum } =
                published
              return { artifactId, versionId, versionNumber, name, mimeType, size, checksum }
            }
            return await persistence.runSessionMutation(
              request.projectId,
              request.sessionId,
              publish
            )
          } catch {
            throw new ImageModelError(
              'OUTCOME_UNKNOWN',
              'The image was generated but its publication could not be confirmed. Check existing results before submitting again.'
            )
          }
        }
        let published: ImageTaskResult | undefined
        await execute({
          operation: 'edit',
          prompt: request.prompt,
          onStarted,
          onResult: async (result) => {
            published = await publishResult(result)
            return published
          },
          sourceIdentity: source.sourceVersionId,
          sourceSizeBytes: input.sizeBytes,
          source: async () => {
            const lease = await managedFiles.immutableInputAuthority.openContent(input)
            let bytes: Buffer
            try {
              bytes = Buffer.from(await lease.readRange(0, lease.size))
              await lease.verifyUnchanged()
            } finally {
              await lease.close()
            }
            return bytes
          },
          options: request.edit.options,
          spatial: { naturalSize: request.edit.naturalSize, regions: request.edit.regions },
          signal,
          context: {
            projectId: request.projectId,
            sessionId: request.sessionId,
            invocationId: request.id,
            frameworkId: 'image-editor'
          }
        })

        if (!published) throw new Error('Image result was not published.')
        return published
      }
    }
    const owner = new ImageTaskOwner({
      root: resolveDataRoot,
      retainWrite: acquireDataRootWriter,
      mutate: (scope, work) =>
        persistence.runSessionMutation(scope.projectId, scope.sessionId, work),
      authorize,
      verifyResults: (tasks) =>
        managedFiles.artifactProvenanceRepository.verifyImageTaskResults(tasks),
      reportError: (error) => createLogger('image-tasks').error('Image task failed', error),
      recover: async (task) => {
        await authorizeTask(task)
        const published = await managedFiles.artifactProvenanceRepository.recoverImageTaskVersion({
          projectId: task.projectId,
          appSessionId: task.sessionId,
          taskId: task.id,
          sourceVersionId: task.edit.source.sourceVersionId
        })
        if (!published) {
          const hasReceipt = await imageModel.inspectReceipt({
            projectId: task.projectId,
            sessionId: task.sessionId,
            invocationId: task.id,
            frameworkId: 'image-editor'
          })
          // Running includes local preprocessing. The receipt is durable before the network call.
          if (task.state === 'running' && hasReceipt === false)
            throw new ImageModelError('CANCELLED', 'Image edit stopped before submission.')
          return undefined
        }
        const { artifactId, versionId, versionNumber, name, mimeType, size, checksum } = published
        return { artifactId, versionId, versionNumber, name, mimeType, size, checksum }
      },
      prepare
    })
    return { name: 'image-tasks', capability: owner, dispose: () => owner.close() }
  })
}
