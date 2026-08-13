import { useCallback, useRef, useState } from 'react'

import type { AcpSaveAsSkillRequest } from '../../../../shared/acp'
import { useSessionStore } from '../../stores/session-store'
import { flushSessionPersistence } from '../session-persistence/session-persistence'
import type { useAcpRuntime } from './useAcpRuntime'
import type { HistoryReplayDescriptor } from './history-preamble'
import { ensureWorkspaceSessionReady } from './workspace-runtime-session-lifecycle-owner'

type WorkspaceSaveAsSkillOwnerOptions = {
  runtime: ReturnType<typeof useAcpRuntime>
  supportsImageInput: boolean
  getHistoryReplayDescriptor: (sessionId: string) => HistoryReplayDescriptor
}

type WorkspaceSaveAsSkillOwner = {
  saveAsSkillInFlightSessionIds: string[]
  saveAsSkill: (request: Omit<AcpSaveAsSkillRequest, 'historyReplay'>) => Promise<void>
}

// Owns local admission from the click through provider turn completion. Every consumer observes the
// same exact Session set while the durable command is prepared and dispatched.
const useWorkspaceRuntimeSaveAsSkillOwner = ({
  runtime,
  supportsImageInput,
  getHistoryReplayDescriptor
}: WorkspaceSaveAsSkillOwnerOptions): WorkspaceSaveAsSkillOwner => {
  const inFlightRef = useRef(new Set<string>())
  const [saveAsSkillInFlightSessionIds, setSaveAsSkillInFlightSessionIds] = useState<string[]>([])

  const saveAsSkill = useCallback(
    async (request: Omit<AcpSaveAsSkillRequest, 'historyReplay'>): Promise<void> => {
      if (inFlightRef.current.has(request.sessionId)) return
      inFlightRef.current.add(request.sessionId)
      setSaveAsSkillInFlightSessionIds((current) => [...current, request.sessionId])
      try {
        const contextReset = await ensureWorkspaceSessionReady(runtime, request.sessionId)
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
        if (
          contextReset &&
          !useSessionStore.getState().openContextResetRuntimeSegment(session.id)
        ) {
          throw new Error('Save as skill Runtime Segment could not be created.')
        }
        await flushSessionPersistence()
        await window.api.acp.saveAsSkill({
          ...request,
          historyReplay: {
            ...getHistoryReplayDescriptor(session.id),
            supportsImageInput,
            ...(contextReset ? { contextReset: true as const } : {})
          }
        })
      } finally {
        inFlightRef.current.delete(request.sessionId)
        setSaveAsSkillInFlightSessionIds((current) =>
          current.filter((sessionId) => sessionId !== request.sessionId)
        )
      }
    },
    [getHistoryReplayDescriptor, runtime, supportsImageInput]
  )

  return { saveAsSkillInFlightSessionIds, saveAsSkill }
}

export { useWorkspaceRuntimeSaveAsSkillOwner }
