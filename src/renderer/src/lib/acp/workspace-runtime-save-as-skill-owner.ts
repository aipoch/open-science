import { useCallback, useRef, useState } from 'react'

import type { AcpSaveAsSkillRequest } from '../../../../shared/acp'
import { useSessionStore } from '../../stores/session-store'
import { flushSessionPersistence } from '../session-persistence/session-persistence'
import type { useAcpRuntime } from './useAcpRuntime'
import { prepareExistingWorkspacePrompt } from './workspace-runtime-prompt-preparation-owner'
import type { WorkspaceSessionRuntimeSelection } from './workspace-runtime-selection-owner'

type WorkspaceSaveAsSkillOwnerOptions = {
  runtime: ReturnType<typeof useAcpRuntime>
  resolveSessionRuntimeSelection: (sessionId: string) => WorkspaceSessionRuntimeSelection
  drainRuntimeEvents?: (sessionId?: string) => Promise<void>
}

type WorkspaceSaveAsSkillOwner = {
  saveAsSkillInFlightSessionIds: string[]
  saveAsSkill: (request: Omit<AcpSaveAsSkillRequest, 'promptMessageId'>) => Promise<void>
}

// Owns local admission from the click through provider acceptance. Every consumer observes the
// same exact Session set while the durable command is prepared and dispatched.
const useWorkspaceRuntimeSaveAsSkillOwner = ({
  runtime,
  resolveSessionRuntimeSelection,
  drainRuntimeEvents
}: WorkspaceSaveAsSkillOwnerOptions): WorkspaceSaveAsSkillOwner => {
  const inFlightRef = useRef(new Set<string>())
  const [saveAsSkillInFlightSessionIds, setSaveAsSkillInFlightSessionIds] = useState<string[]>([])

  const saveAsSkill = useCallback(
    async (request: Omit<AcpSaveAsSkillRequest, 'promptMessageId'>): Promise<void> => {
      if (inFlightRef.current.has(request.sessionId)) return
      inFlightRef.current.add(request.sessionId)
      setSaveAsSkillInFlightSessionIds((current) => [...current, request.sessionId])
      let controlMessageId: string | undefined
      try {
        const initialSession = useSessionStore
          .getState()
          .sessions.find((candidate) => candidate.id === request.sessionId)
        if (!initialSession) throw new Error(`Session not found: ${request.sessionId}`)
        const initialHead = initialSession.conversationGraph?.branches.find(
          ({ id }) => id === request.messageBranchId
        )?.headMessageId
        const isCurrent = (): boolean => {
          const current = useSessionStore
            .getState()
            .sessions.find((candidate) => candidate.id === request.sessionId)
          const graph = current?.conversationGraph
          const frame = graph?.frames.find(({ id }) => id === graph.activeFrameId)
          const head = graph?.branches.find(({ id }) => id === frame?.activeBranchId)?.headMessageId
          return Boolean(
            current &&
            current.projectId === request.projectId &&
            !current.interrupted &&
            !current.resumeRecovery &&
            frame?.id === request.agentFrameId &&
            frame.activeBranchId === request.messageBranchId &&
            (controlMessageId
              ? current.activeRun?.promptMessageId === controlMessageId && head === controlMessageId
              : !current.activeRun && head === initialHead)
          )
        }
        const selected = resolveSessionRuntimeSelection(request.sessionId)
        const replayPolicy = {
          ...selected.historyReplayDescriptor,
          supportsImageInput: selected.supportsImageInput || selected.supportsImageRelay
        }
        const prepared = await prepareExistingWorkspacePrompt(runtime, {
          sessionId: request.sessionId,
          requireExistingSession: true,
          isCurrent,
          cwd: initialSession.cwd,
          projectId: initialSession.projectId,
          permissionProfile: initialSession.permissionProfile,
          selectedRuntime: {
            frameworkId: selected.agentFrameworkId,
            backendId: selected.agentBackendId,
            agentModel: selected.agentModel,
            agentConfiguration: selected.agentTarget
              ? {
                  providerId: selected.agentTarget.providerId,
                  model: selected.agentTarget.model,
                  reasoningEffort: selected.agentTarget.reasoningEffort
                }
              : undefined,
            supportsImageInput: selected.supportsImageInput,
            supportsImageRelay: selected.supportsImageRelay
          },
          replay: { descriptor: replayPolicy },
          drainRuntimeEvents
        })
        if (!isCurrent()) return
        if (!prepared) throw new Error('Save as skill Session preparation did not complete.')
        const session = useSessionStore
          .getState()
          .sessions.find((candidate) => candidate.id === request.sessionId)
        if (!session?.conversationGraph) {
          throw new Error('Conversation branch history is unavailable.')
        }
        const frame = session.conversationGraph.frames.find(
          ({ id }) => id === session.conversationGraph?.activeFrameId
        )
        if (
          !frame ||
          frame.id !== request.agentFrameId ||
          frame.activeBranchId !== request.messageBranchId
        ) {
          throw new Error('Save as skill stopped because the active conversation branch changed.')
        }
        const contextReset = prepared.replay().contextReset
        if (
          contextReset &&
          !useSessionStore.getState().openContextResetRuntimeSegment(session.id)
        ) {
          throw new Error('Save as skill Runtime Segment could not be created.')
        }
        const controlMessage = useSessionStore.getState().appendUserMessage({
          sessionId: session.id,
          content: 'Save as skill',
          turnIntent: 'save-as-skill',
          agentModel: selected.agentModel
        })
        if (!controlMessage) throw new Error('Save as skill control message could not be created.')
        controlMessageId = controlMessage.messageId
        await flushSessionPersistence()
        if (!isCurrent()) return
        await window.api.acp.saveAsSkill({
          ...request,
          ...(selected.supportsImageRelay ? { supportsImageRelay: true } : {}),
          promptMessageId: controlMessage.messageId
        })
        prepared.acceptPrompt(controlMessage.messageId)
        if (contextReset) {
          useSessionStore.getState().clearPendingHistoryReplay(session.id, { kind: 'all' })
        }
      } catch (error) {
        const current = useSessionStore
          .getState()
          .sessions.find((candidate) => candidate.id === request.sessionId)
        if (controlMessageId && current?.activeRun?.promptMessageId === controlMessageId) {
          useSessionStore
            .getState()
            .interruptRun(
              request.sessionId,
              'connection-lost',
              error instanceof Error ? error.message : String(error),
              controlMessageId
            )
        }
        throw error
      } finally {
        inFlightRef.current.delete(request.sessionId)
        setSaveAsSkillInFlightSessionIds((current) =>
          current.filter((sessionId) => sessionId !== request.sessionId)
        )
      }
    },
    [drainRuntimeEvents, resolveSessionRuntimeSelection, runtime]
  )

  return { saveAsSkillInFlightSessionIds, saveAsSkill }
}

export { useWorkspaceRuntimeSaveAsSkillOwner }
