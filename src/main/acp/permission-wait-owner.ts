import type { AcpPermissionResponse } from '../../shared/acp'
import {
  sanitizeSessionPermissionRuntimeContext,
  type PersistedChatSession,
  type SessionPermissionRuntimeContext,
  type SessionRuntimeContext
} from '../../shared/session-persistence'
import type {
  SessionCatalog,
  SessionMutation,
  SessionRuntimeContextCommands
} from '../session-persistence/coordinator'
import type { DurablePermissionWaitCandidate } from './permission-broker'

type PermissionWaitSessions = SessionRuntimeContextCommands &
  Pick<SessionCatalog, 'containsMessageOnActiveBranch' | 'loadSessionForContinuation'> &
  Partial<Pick<SessionCatalog, 'sessionProjectId'> & SessionMutation>

type RestoredPermissionDecision = Readonly<{
  permission: SessionPermissionRuntimeContext
  option?: SessionPermissionRuntimeContext['request']['options'][number]
  denied: boolean
}>

type PublishPermissionWaitSession = (session: PersistedChatSession) => Promise<void> | void

const isRevisionConflict = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'revision-conflict'

class AcpPermissionWaitOwner {
  constructor(
    private readonly sessions?: PermissionWaitSessions,
    private readonly publishSessionUpdated?: PublishPermissionWaitSession
  ) {}

  async persist(candidate: DurablePermissionWaitCandidate): Promise<boolean> {
    if (!this.sessions || !candidate.projectId || !candidate.promptMessageId) return false
    if (
      !(await this.sessions.containsMessageOnActiveBranch(
        candidate.projectId,
        candidate.request.sessionId,
        candidate.promptMessageId
      ))
    ) {
      return false
    }

    const permission = sanitizeSessionPermissionRuntimeContext({
      state: 'pending',
      request: candidate.request,
      originatingPromptMessageId: candidate.promptMessageId,
      fingerprint: candidate.fingerprint,
      categoryKey: candidate.categoryKey,
      capability: candidate.capability,
      createdAt: Date.now()
    })
    if (!permission) throw new Error('Permission request could not be persisted safely.')

    await this.patch(
      candidate.projectId,
      candidate.request.sessionId,
      (context) => {
        const currentPermission = context.permission
        if (currentPermission) {
          if (
            currentPermission.state === 'pending' &&
            currentPermission.request.requestId === permission.request.requestId
          ) {
            return currentPermission
          }
          throw new Error('Another durable permission request already owns this Session.')
        }
        return permission
      },
      'waiting-permission'
    )
    return true
  }

  async clearLive(candidate: DurablePermissionWaitCandidate): Promise<void> {
    if (!this.sessions || !candidate.projectId || !candidate.promptMessageId) return
    await this.clear(
      candidate.projectId,
      candidate.request.sessionId,
      candidate.request.requestId,
      'running'
    )
  }

  async clearAfterContinuation(
    projectId: string,
    sessionId: string,
    requestId: string
  ): Promise<boolean> {
    if (!this.sessions) return false
    return this.patch(
      projectId,
      sessionId,
      (context) => {
        const permission = context.permission
        if (!permission || permission.request.requestId !== requestId) return permission
        if (permission.state !== 'continuing') {
          throw new Error('The restored permission continuation is no longer active.')
        }
        return undefined
      },
      'idle'
    )
  }

  async cancelContinuation(projectId: string, sessionId: string, requestId: string): Promise<void> {
    if (!this.sessions) return
    await this.patch(
      projectId,
      sessionId,
      (context) => {
        const permission = context.permission
        if (!permission) return undefined
        if (permission.request.requestId !== requestId) {
          throw new Error('A different permission request now owns this Session.')
        }
        return undefined
      },
      'idle'
    )
  }

  async cancelPendingSession(sessionId: string): Promise<string | undefined> {
    if (!this.sessions?.sessionProjectId) return undefined
    const projectId = await this.sessions.sessionProjectId(sessionId)
    if (!projectId) return undefined
    let cancelledRequestId: string | undefined
    const cleared = await this.patch(
      projectId,
      sessionId,
      (context) => {
        const permission = context.permission
        if (
          !permission ||
          permission.state !== 'pending' ||
          permission.request.sessionId !== sessionId
        ) {
          return permission
        }
        cancelledRequestId = permission.request.requestId
        return undefined
      },
      'idle'
    )
    return cleared ? cancelledRequestId : undefined
  }

  async beginContinuation(projectId: string, sessionId: string, requestId: string): Promise<void> {
    await this.transitionContinuation(
      projectId,
      sessionId,
      requestId,
      'pending',
      'continuing',
      'running'
    )
  }

  async rearmContinuation(projectId: string, sessionId: string, requestId: string): Promise<void> {
    await this.transitionContinuation(
      projectId,
      sessionId,
      requestId,
      'continuing',
      'pending',
      'waiting-permission'
    )
  }

  async resolveRestored(
    response: AcpPermissionResponse,
    projectId: string,
    sessionId: string
  ): Promise<RestoredPermissionDecision> {
    if (!this.sessions || !response.restored) {
      throw new Error('The restored permission request is no longer available.')
    }
    if (response.restored.sessionId !== sessionId || response.restored.projectId !== projectId) {
      throw new Error('Restored permission Session context does not match the active Session.')
    }

    const context = await this.sessions.readSessionRuntimeContext(projectId, sessionId)
    const permission = context.permission
    if (
      !permission ||
      permission.state !== 'pending' ||
      permission.request.requestId !== response.requestId ||
      permission.request.sessionId !== sessionId
    ) {
      throw new Error('The restored permission request is stale or no longer pending.')
    }
    if (
      !(await this.sessions.containsMessageOnActiveBranch(
        projectId,
        sessionId,
        permission.originatingPromptMessageId
      ))
    ) {
      throw new Error('The restored permission request is not on the active Message Branch.')
    }

    if (response.cancelled || !response.optionId) {
      return { permission, denied: true }
    }
    const option = permission.request.options.find(
      (candidate) => candidate.optionId === response.optionId
    )
    if (!option) throw new Error('The restored permission option is no longer available.')
    const kind = option.kind.toLowerCase()
    if (
      kind !== 'allow_once' &&
      kind !== 'allow_always' &&
      kind !== 'reject_once' &&
      kind !== 'reject_always'
    ) {
      throw new Error('The restored permission option cannot be replayed safely.')
    }
    return { permission, option, denied: kind.startsWith('reject_') }
  }

  private async clear(
    projectId: string,
    sessionId: string,
    requestId: string,
    sessionStatus: 'running' | 'idle'
  ): Promise<void> {
    await this.patch(
      projectId,
      sessionId,
      (context) =>
        context.permission?.request.requestId === requestId ? undefined : context.permission,
      sessionStatus
    )
  }

  private async transitionContinuation(
    projectId: string,
    sessionId: string,
    requestId: string,
    expectedState: SessionPermissionRuntimeContext['state'],
    state: SessionPermissionRuntimeContext['state'],
    sessionStatus: 'waiting-permission' | 'running'
  ): Promise<void> {
    if (!this.sessions) return
    await this.patch(
      projectId,
      sessionId,
      (context) => {
        const permission = context.permission
        if (
          !permission ||
          permission.request.requestId !== requestId ||
          permission.state !== expectedState
        ) {
          throw new Error('The restored permission request is stale or no longer pending.')
        }
        return { ...permission, state }
      },
      sessionStatus
    )
  }

  private async patch(
    projectId: string,
    sessionId: string,
    update: (context: SessionRuntimeContext) => SessionPermissionRuntimeContext | undefined,
    sessionStatus: 'waiting-permission' | 'running' | 'idle'
  ): Promise<boolean> {
    if (!this.sessions) return false
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const context = await this.sessions.readSessionRuntimeContext(projectId, sessionId)
      const permission = update(context)
      if (permission === context.permission) return false
      try {
        await this.sessions.patchSessionRuntimeContext({
          projectId,
          sessionId,
          expectedRevision: context.revision,
          patch: { permission },
          sessionStatus
        })
        if (this.publishSessionUpdated) {
          const session = await this.sessions.loadSessionForContinuation(projectId, sessionId)
          await this.publishSessionUpdated(session)
        }
        return true
      } catch (error) {
        if (!isRevisionConflict(error) || attempt === 2) throw error
      }
    }
    return false
  }
}

export { AcpPermissionWaitOwner }
export type { PermissionWaitSessions, PublishPermissionWaitSession, RestoredPermissionDecision }
