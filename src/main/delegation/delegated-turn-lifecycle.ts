import type { ArtifactFile } from '../../shared/artifacts'
import type { AttemptRuntimeTranscriptStager } from './attempt-runtime-transcript'
import type { DurableMessage, DelegatedWorkDurableRecords } from './delegated-work-record-types'
import type { DelegateExecutionInput } from './execution-port'

type SessionKey = Readonly<{ projectId: string; sessionId: string }>

type DelegatedArtifactScope = Readonly<{
  session: SessionKey
  executionId: string
  attemptId: string
  rootFrameId: string
  agentFrameId: string
  messageBranchId: string
  runtimeSegmentId: string
  promptMessageId: string
  agentName: string
}>

type DelegatedArtifactProjectionScope = DelegatedArtifactScope &
  Readonly<{
    runtimeSegmentIds: readonly string[]
    terminalMessageId?: string
  }>

type DelegatedArtifactHandle = Readonly<{
  execution?: Readonly<{ currentRunFile: string }>
  activateAt?(currentRunFile: string): Promise<void>
  finalize(terminalMessageId: string): Promise<void>
  dispose(): Promise<void>
}>

type DelegatedArtifactEvidence = Readonly<{
  open(scope: DelegatedArtifactScope): Promise<DelegatedArtifactHandle>
  revoke?(scope: DelegatedArtifactProjectionScope): Promise<void>
  project(scope: DelegatedArtifactProjectionScope): Promise<readonly ArtifactFile[]>
}>

type TurnContext = Readonly<{
  rootFrameId: string
  messageBranchId: string
  promptMessageId: string
  runtimeSegmentId: string
}>

const createDelegatedTurnLifecycle = (options: {
  records: DelegatedWorkDurableRecords
  artifactEvidence?: DelegatedArtifactEvidence
  session: SessionKey
  attemptId: string
  agentFrameId: string
  agentName: string
  transcript: AttemptRuntimeTranscriptStager
  now(): number
}): Readonly<{
  openInitial(context: TurnContext): Promise<void>
  currentArtifact(): DelegatedArtifactHandle | undefined
  lastTurnMessage(): DurableMessage | undefined
  create(context: TurnContext, initial: boolean): NonNullable<DelegateExecutionInput['turn']>
  finalizeFallback(terminalMessageId: string): Promise<void>
  dispose(): Promise<void>
}> => {
  let currentArtifact: DelegatedArtifactHandle | undefined
  const artifactHandles: DelegatedArtifactHandle[] = []
  const disposedArtifacts = new Set<DelegatedArtifactHandle>()
  const pendingArtifactOpens = new Set<Promise<void>>()
  let artifactHandoffFile: string | undefined
  let completedTurnMessage: DurableMessage | undefined
  let disposeRequested = false

  const openArtifact = (context: TurnContext, executionId: string): Promise<void> => {
    if (disposeRequested) return Promise.resolve()
    const opening = (async () => {
      const artifact = await options.artifactEvidence?.open({
        session: options.session,
        executionId,
        attemptId: options.attemptId,
        rootFrameId: context.rootFrameId,
        agentFrameId: options.agentFrameId,
        messageBranchId: context.messageBranchId,
        runtimeSegmentId: context.runtimeSegmentId,
        promptMessageId: context.promptMessageId,
        agentName: options.agentName
      })
      if (!artifact) return
      artifactHandles.push(artifact)
      if (disposeRequested) {
        await artifact.dispose()
        disposedArtifacts.add(artifact)
        return
      }
      currentArtifact = artifact
      if (artifactHandoffFile) await artifact.activateAt?.(artifactHandoffFile)
      else artifactHandoffFile = artifact.execution?.currentRunFile
    })()
    pendingArtifactOpens.add(opening)
    void opening.then(
      () => pendingArtifactOpens.delete(opening),
      () => pendingArtifactOpens.delete(opening)
    )
    return opening
  }

  return {
    openInitial: (context) => openArtifact(context, options.attemptId),
    currentArtifact: () => currentArtifact,
    lastTurnMessage: () => completedTurnMessage,
    create: (context, initial) => ({
      promptMessageId: context.promptMessageId,
      messageBranchId: context.messageBranchId,
      runtimeSegmentId: context.runtimeSegmentId,
      ...(!initial
        ? {
            begin: () => openArtifact(context, `${options.attemptId}:${context.promptMessageId}`)
          }
        : {}),
      async complete(response, turnUsage, turnUsageUnavailable) {
        const completedAt = options.now()
        const transcript = await options.transcript.settle(context, {
          fallbackResponse: response,
          endedAt: completedAt,
          terminalStatus: 'completed',
          ...(turnUsage
            ? { turnUsage }
            : turnUsageUnavailable
              ? { turnUsageUnavailable: true }
              : {})
        })
        const message = transcript.terminalMessage
        if (!message) throw new Error('Completed child Turn has no final agent Message.')
        await currentArtifact?.finalize(message.id)
        await options.records.completeTurn(
          options.agentFrameId,
          options.attemptId,
          context.runtimeSegmentId,
          completedAt
        )
        completedTurnMessage = message
      }
    }),
    async finalizeFallback(terminalMessageId) {
      await currentArtifact?.finalize(terminalMessageId)
    },
    async dispose() {
      disposeRequested = true
      const openingAtDisposal = [...pendingArtifactOpens]
      const disposalAtStart = artifactHandles
        .filter((artifact) => !disposedArtifacts.has(artifact))
        .map(async (artifact) => {
          await artifact.dispose()
          disposedArtifacts.add(artifact)
        })
      // An open that was already in flight when disposal began owns disposal of its late handle.
      // Await it alongside current handles so failure keeps the outer finalizer retryable.
      await Promise.all([...disposalAtStart, ...openingAtDisposal])
    }
  }
}

export { createDelegatedTurnLifecycle }
export type {
  DelegatedArtifactEvidence,
  DelegatedArtifactHandle,
  DelegatedArtifactProjectionScope,
  DelegatedArtifactScope
}
