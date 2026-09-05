import { useCallback, useEffect, useRef, useState } from 'react'

import {
  isSessionSizeLimitError,
  type DelegationPolicy
} from '../../../../shared/session-persistence'
import type { AgentFrameworkId, AgentFrameworkView } from '../../../../shared/settings'
import { setDelegationPolicyAuthority } from '@/lib/session-persistence/session-persistence'
import type { ChatSession } from '@/stores/session-store'

type WorkspaceSessionDelegationControlOwnerOptions = Readonly<{
  activeSession: ChatSession | undefined
  selectedSessionId: string | undefined
  selectedFrameworkId: AgentFrameworkId
  frameworks: readonly AgentFrameworkView[]
  setError: (error: string | null) => void
  onSessionSizeLimit?: (sessionId: string) => void
}>

type WorkspaceSessionDelegationControl = Readonly<{
  enabled: boolean
  newConversationPolicyOverride?: DelegationPolicy
  pending: boolean
  frameworkSupported: boolean
  sessionAuthoritative: boolean
  hasLiveDelegatedAttempts: boolean
  change: (enabled: boolean) => Promise<void>
  resetNewConversation: () => void
}>

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const hasLiveDelegatedAttempts = (
  session: Pick<ChatSession, 'runtimeContext'> | undefined
): boolean => {
  const delegatedWork = session?.runtimeContext?.delegatedWork
  if (!delegatedWork) return false

  const pendingAttemptIds = new Set(
    (delegatedWork.questionRequests ?? [])
      .filter((request) => request.status === 'pending')
      .map((request) => request.sourceAttemptId)
  )
  return delegatedWork.records.some((record) => {
    const latest = record.attempts.at(-1)
    return (
      latest?.status === 'running' || (latest !== undefined && pendingAttemptIds.has(latest.id))
    )
  })
}

const useWorkspaceSessionDelegationControlOwner = ({
  activeSession,
  selectedSessionId,
  selectedFrameworkId,
  frameworks,
  setError,
  onSessionSizeLimit
}: WorkspaceSessionDelegationControlOwnerOptions): WorkspaceSessionDelegationControl => {
  const pendingSessionIdsRef = useRef(new Set<string>())
  const [pendingSessionIds, setPendingSessionIds] = useState<ReadonlySet<string>>(() => new Set())
  const [newConversationPolicyOverride, setNewConversationPolicyOverride] =
    useState<DelegationPolicy>()
  const selectionIdentity = activeSession?.id ?? selectedSessionId
  const previousSelectionIdentityRef = useRef(selectionIdentity)
  const frameworkId = activeSession ? activeSession.agentFrameworkId : selectedFrameworkId
  const frameworkSupported =
    frameworks.find((framework) => framework.id === frameworkId)?.supportsDelegatedWork === true
  const isNewConversation = activeSession === undefined && selectedSessionId === undefined
  const sessionAuthoritative = activeSession
    ? !activeSession.isPending && !activeSession.delegationPolicyAuthorityPending
    : isNewConversation

  useEffect(() => {
    if (previousSelectionIdentityRef.current !== undefined && selectionIdentity === undefined) {
      setNewConversationPolicyOverride(undefined)
    }
    previousSelectionIdentityRef.current = selectionIdentity
  }, [selectionIdentity])

  const resetNewConversation = useCallback(() => setNewConversationPolicyOverride(undefined), [])

  const change = useCallback(
    async (enabled: boolean): Promise<void> => {
      const session = activeSession
      const policy: DelegationPolicy = enabled ? 'allow' : 'deny'
      if (
        !frameworkSupported ||
        (session && (session.isPending || session.delegationPolicyAuthorityPending))
      )
        return
      if (!session) {
        if (!isNewConversation) return
        setNewConversationPolicyOverride(policy)
        return
      }
      if (pendingSessionIdsRef.current.has(session.id)) return
      if ((session.delegationPolicy !== 'deny') === enabled) return

      pendingSessionIdsRef.current.add(session.id)
      setPendingSessionIds((current) => new Set(current).add(session.id))
      setError(null)
      try {
        await setDelegationPolicyAuthority(session.projectId, session.id, policy)
      } catch (error) {
        if (isSessionSizeLimitError(error)) onSessionSizeLimit?.(session.id)
        setError(errorMessage(error))
      } finally {
        pendingSessionIdsRef.current.delete(session.id)
        setPendingSessionIds((current) => {
          if (!current.has(session.id)) return current
          const next = new Set(current)
          next.delete(session.id)
          return next
        })
      }
    },
    [activeSession, frameworkSupported, isNewConversation, onSessionSizeLimit, setError]
  )

  return {
    enabled: activeSession
      ? activeSession.delegationPolicy !== 'deny'
      : !isNewConversation || newConversationPolicyOverride !== 'deny',
    newConversationPolicyOverride,
    pending: activeSession ? pendingSessionIds.has(activeSession.id) : false,
    frameworkSupported,
    sessionAuthoritative,
    hasLiveDelegatedAttempts: hasLiveDelegatedAttempts(activeSession),
    change,
    resetNewConversation
  }
}

export { hasLiveDelegatedAttempts, useWorkspaceSessionDelegationControlOwner }
export type { WorkspaceSessionDelegationControl, WorkspaceSessionDelegationControlOwnerOptions }
