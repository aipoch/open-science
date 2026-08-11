import { DurableDelegatedWorkError } from './durable-delegated-work-error'
import { currentAttempt, sameSession } from './delegated-work-record-invariants'
import type {
  DelegatedWorkDurableRecords,
  DurableSnapshot,
  RootDelegatePermissionEvent,
  RootDelegatePermissionRequest,
  RootDelegatePermissionResponse
} from './durable-delegated-work'
import type { DelegateExecutionEvent, RunningDelegateExecution } from './execution-port'

type Permission = RootDelegatePermissionRequest & Readonly<{ execution: RunningDelegateExecution }>
type TakenPermissions = Array<[string, Permission]>

class RootDelegatePermissionOwner {
  private readonly permissions = new Map<string, Permission>()

  constructor(
    private readonly records: DelegatedWorkDurableRecords,
    private readonly onEvent?: (event: RootDelegatePermissionEvent) => void
  ) {}

  observe(
    frameId: string,
    attemptId: string,
    childTitle: string,
    execution: RunningDelegateExecution,
    event: DelegateExecutionEvent
  ): void {
    if (event.kind !== 'permission') return
    const key = this.key(frameId, attemptId, event.requestId)
    if (!event.awaiting) {
      this.delete(key)
      return
    }
    this.set(key, {
      requestId: event.requestId,
      frameId,
      attemptId,
      childTitle,
      action: event.title,
      riskScope: this.riskScope(event.options),
      options: event.options.map(({ optionId, name, kind, scope }) => ({
        optionId,
        name,
        kind,
        ...(scope ? { scope } : {})
      })),
      execution
    })
  }

  hasAwaiting(frameId: string, attemptId: string): boolean {
    return [...this.permissions.values()].some(
      (permission) => permission.frameId === frameId && permission.attemptId === attemptId
    )
  }

  takeAttempt(frameId: string, attemptId: string): TakenPermissions {
    const prefix = `${frameId}\u0000${attemptId}\u0000`
    const taken = [...this.permissions.entries()].filter(([key]) => key.startsWith(prefix))
    for (const [key] of taken) this.delete(key)
    return taken
  }

  clearAttempt(frameId: string, attemptId: string): void {
    this.takeAttempt(frameId, attemptId)
  }

  restoreAttempt(taken: TakenPermissions): void {
    for (const [key, permission] of taken) {
      if (!this.permissions.has(key)) this.set(key, permission)
    }
  }

  async requests(
    session: DurableSnapshot['session']
  ): Promise<readonly RootDelegatePermissionRequest[]> {
    const snapshot = await this.records.snapshot()
    if (!sameSession(snapshot.session, session)) return []
    const currentAttempts = new Map(
      snapshot.records.map((child) => [child.frameId, currentAttempt(child)])
    )
    return [...this.permissions.values()]
      .filter((permission) => {
        const child = snapshot.records.find((candidate) => candidate.frameId === permission.frameId)
        const attempt = currentAttempts.get(permission.frameId)
        return (
          child?.originBindingState === 'validated' &&
          snapshot.originMessageIds.includes(child.originMessageId) &&
          attempt?.id === permission.attemptId &&
          attempt.status === 'running'
        )
      })
      .map((permission) => this.request(permission))
  }

  async respond(
    session: DurableSnapshot['session'],
    response: RootDelegatePermissionResponse
  ): Promise<void> {
    const snapshot = await this.records.snapshot()
    const child = sameSession(snapshot.session, session)
      ? snapshot.records.find((candidate) => candidate.frameId === response.frameId)
      : undefined
    const attempt = child && currentAttempt(child)
    const key = this.key(response.frameId, response.attemptId, response.requestId)
    const permission = this.permissions.get(key)
    if (
      !permission ||
      child?.originBindingState !== 'validated' ||
      !snapshot.originMessageIds.includes(child.originMessageId) ||
      !attempt ||
      attempt.id !== response.attemptId ||
      attempt.status !== 'running'
    ) {
      throw new DurableDelegatedWorkError(
        'conflict',
        'permission request is no longer active for the current delegated Attempt'
      )
    }
    this.delete(key)
    try {
      await permission.execution.respondToPermission({
        requestId: response.requestId,
        ...(response.optionId ? { optionId: response.optionId } : {}),
        ...(response.cancelled ? { cancelled: true } : {})
      })
    } catch (error) {
      const latest = (await this.records.snapshot()).records.find(
        (candidate) => candidate.frameId === response.frameId
      )
      if (
        latest &&
        currentAttempt(latest).id === response.attemptId &&
        currentAttempt(latest).status === 'running'
      ) {
        this.set(key, permission)
      }
      throw error
    }
  }

  private key(frameId: string, attemptId: string, requestId: string): string {
    return `${frameId}\u0000${attemptId}\u0000${requestId}`
  }

  private request(permission: Permission): RootDelegatePermissionRequest {
    const { execution: _execution, ...request } = permission
    void _execution
    return Object.freeze({ ...request, options: Object.freeze([...request.options]) })
  }

  private publish(kind: RootDelegatePermissionEvent['kind'], permission: Permission): void {
    this.onEvent?.({ kind, request: this.request(permission) })
  }

  private set(key: string, permission: Permission): void {
    const isNew = !this.permissions.has(key)
    this.permissions.set(key, permission)
    if (isNew) this.publish('requested', permission)
  }

  private delete(key: string): Permission | undefined {
    const permission = this.permissions.get(key)
    if (!permission) return undefined
    this.permissions.delete(key)
    this.publish('settled', permission)
    return permission
  }

  private riskScope(
    options: readonly Readonly<{
      kind: string
      scope?: 'once' | 'session' | 'project' | 'global'
    }>[]
  ): string {
    const scopes = new Set(options.map(({ scope }) => scope).filter(Boolean))
    if (scopes.has('global')) return 'Global, project, session, or this call'
    if (scopes.has('project')) return 'This project, this session, or this call'
    if (scopes.has('session')) return 'This session or this call'
    const kinds = new Set(options.map(({ kind }) => kind.toLowerCase()))
    return kinds.has('allow_always') ? 'This session or this call' : 'This call only'
  }
}

export { RootDelegatePermissionOwner }
export type { TakenPermissions }
