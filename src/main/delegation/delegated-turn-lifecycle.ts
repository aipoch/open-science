import type { AcpAgentRuntimeUpdate } from '../../shared/acp'
import type { ArtifactFile } from '../../shared/artifacts'
import {
  selectRuntimeScopeUpdates,
  stageAttemptRuntimeTranscript
} from './attempt-runtime-transcript'
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
  runtimeUpdates: AcpAgentRuntimeUpdate[]
  now(): number
  createMessageId(): string
}): Readonly<{
  openInitial(context: TurnContext): Promise<void>
  currentArtifact(): DelegatedArtifactHandle | undefined
  lastTurnMessage(): DurableMessage | undefined
  unstagedRuntimeScope(context: TurnContext | undefined): TurnContext | undefined
  create(context: TurnContext, initial: boolean): NonNullable<DelegateExecutionInput['turn']>
  finalizeFallback(terminalMessageId: string): Promise<void>
  dispose(): Promise<void>
}> => {
  let currentArtifact: DelegatedArtifactHandle | undefined
  const artifactHandles: DelegatedArtifactHandle[] = []
  let artifactHandoffFile: string | undefined
  let stagedRuntimeUpdateCount = 0
  let completedTurnMessage: DurableMessage | undefined
  const stagedRuntimeScopes = new Set<string>()
  const runtimeScopeKey = (context: TurnContext): string =>
    `${context.runtimeSegmentId}\u0000${context.promptMessageId}`

  const openArtifact = async (context: TurnContext, executionId: string): Promise<void> => {
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
    currentArtifact = artifact
    artifactHandles.push(artifact)
    if (artifactHandoffFile) await artifact.activateAt?.(artifactHandoffFile)
    else artifactHandoffFile = artifact.execution?.currentRunFile
  }

  return {
    openInitial: (context) => openArtifact(context, options.attemptId),
    currentArtifact: () => currentArtifact,
    lastTurnMessage: () => completedTurnMessage,
    unstagedRuntimeScope: (context) =>
      context && !stagedRuntimeScopes.has(runtimeScopeKey(context)) ? context : undefined,
    create: (context, initial) => ({
      promptMessageId: context.promptMessageId,
      messageBranchId: context.messageBranchId,
      runtimeSegmentId: context.runtimeSegmentId,
      ...(!initial
        ? {
            begin: () => openArtifact(context, `${options.attemptId}:${context.promptMessageId}`)
          }
        : {}),
      async complete(response, turnUsage, turnUsageUnavailable, modelCallUsage) {
        const completedAt = options.now()
        const turnUpdates = selectRuntimeScopeUpdates(
          options.runtimeUpdates.slice(stagedRuntimeUpdateCount),
          context
        )
        stagedRuntimeUpdateCount = options.runtimeUpdates.length
        const transcript = await stageAttemptRuntimeTranscript(
          options.records,
          options.agentFrameId,
          options.attemptId,
          {
            updates: turnUpdates,
            frameId: options.agentFrameId,
            promptMessageId: context.promptMessageId,
            runtimeSegmentId: context.runtimeSegmentId,
            fallbackResponse: response,
            endedAt: completedAt,
            terminalStatus: 'completed',
            ...(turnUsage
              ? { turnUsage, ...(modelCallUsage ? { modelCallUsage } : {}) }
              : turnUsageUnavailable
                ? { turnUsageUnavailable: true }
                : {}),
            createMessageId: options.createMessageId
          }
        )
        stagedRuntimeScopes.add(runtimeScopeKey(context))
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
      await Promise.allSettled(artifactHandles.map((artifact) => artifact.dispose()))
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
