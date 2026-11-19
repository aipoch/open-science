import { randomUUID } from 'node:crypto'

import { NotebookExecutionAdmissionError } from './execution-admission'
import type { notebookExecutionIntentReference } from './execution-model-contract'

export type NotebookExecutionIntentScope = Readonly<{
  projectId: string
  sessionId: string
  messageBranchId?: string
  promptMessageId?: string
}>
export type NotebookExecutionContinuation = NotebookExecutionIntentScope &
  Readonly<{ refusalId: string }>
export type NotebookExecutionIntentDeletion =
  { projectId: string } | { sessionIds: readonly string[] }

// Main owns this transient authority. A prompt id, tool argument or document cannot create it.
// Concrete transports and derived Attempts retain the same immutable reference.
export class NotebookExecutionIntent {
  declare readonly [notebookExecutionIntentReference]: true
  private refusal?: Readonly<{ id: string; reason: string }>
  private userPreparationPending = false
  private userMemoryRecheck?: () => void
  private readonly branches = new Map<
    string,
    { onViolation?: () => void; providerStopRequested: boolean; cancellation: AbortController }
  >()

  constructor(readonly scope: NotebookExecutionIntentScope) {}

  get refusalId(): string | undefined {
    return this.refusal?.id
  }

  // A missing origin can inherit only when its admitted conversation contains this grant.
  forDescendant(context?: {
    messageBranchId?: string
    messageAncestry?: readonly string[]
  }): NotebookExecutionIntent {
    if (
      this.refusal ||
      (this.scope.messageBranchId === context?.messageBranchId &&
        this.scope.promptMessageId &&
        context?.messageAncestry?.includes(this.scope.promptMessageId))
    )
      return this
    const stopped = new NotebookExecutionIntent(this.scope)
    stopped.block('originating-execution-context-unavailable')
    return stopped
  }

  block(reason: string): string {
    this.refusal ??= Object.freeze({ id: randomUUID(), reason })
    return this.refusal.id
  }

  prepareUserExecution(assertUserCurrent?: () => void): void {
    this.userPreparationPending = true
    this.userMemoryRecheck = assertUserCurrent
  }

  // Provider dispatch commits preparation before tools run. Keep the one-shot human recheck
  // separate so neither a Task preparation nor a later Agent call gains a cache bypass.
  consumeUserMemoryRecheck(): (() => void) | undefined {
    const assertCurrent = this.userMemoryRecheck
    this.userMemoryRecheck = undefined
    return assertCurrent
  }

  commitUserExecution(): void {
    this.userPreparationPending = false
  }

  abandonUserExecution(): void {
    this.userMemoryRecheck = undefined
    if (!this.userPreparationPending) return
    this.userPreparationPending = false
    this.block('user-execution-preparation-not-committed')
  }

  assertExecutable(): void {
    if (this.refusal)
      throw new NotebookExecutionAdmissionError(
        'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION',
        'Execution was not started. This user execution context was stopped. Explain the result or inspect existing outputs, then wait for the user to explicitly continue execution. Do not retry, change tools, language, environment or Session, or delegate the rejected work.'
      )
  }

  // Only an authenticated transport entry counts as another execution attempt. Boundary
  // rechecks of a single admitted request must not turn the first refusal into cancellation.
  assertDispatch(credential: string | undefined): void {
    if (this.refusal && credential) {
      const branch = this.branches.get(credential)
      if (branch?.onViolation && !branch.providerStopRequested) {
        branch.providerStopRequested = true
        branch.onViolation()
      }
    }
    this.assertExecutable()
  }

  observeViolations(
    credential: string,
    onViolation: () => void
  ): (() => void) & { acceptUserCancellation(): void } {
    const branch = {
      onViolation: onViolation as (() => void) | undefined,
      providerStopRequested: false,
      cancellation: new AbortController()
    }
    this.branches.set(credential, branch)
    return Object.assign(
      () => {
        branch.onViolation = undefined
        if (this.branches.get(credential) === branch) this.branches.delete(credential)
      },
      {
        acceptUserCancellation: () => {
          branch.providerStopRequested = false
          branch.cancellation.abort()
        }
      }
    )
  }

  captureProviderStopProof(credential: string): (() => boolean) | undefined {
    const branch = this.branches.get(credential)
    return branch ? () => branch.providerStopRequested : undefined
  }

  userCancellationSignal(credential: string): AbortSignal | undefined {
    return this.branches.get(credential)?.cancellation.signal
  }
}

const intentKey = Symbol('Notebook host execution intent')
const credentialKey = Symbol('Notebook host execution credential')
export const withNotebookExecutionIntent = <T extends object>(
  request: T,
  intent: NotebookExecutionIntent
): T => Object.assign({}, request, { [intentKey]: intent })

export const notebookExecutionIntent = (request: object): NotebookExecutionIntent | undefined =>
  (request as { [intentKey]?: NotebookExecutionIntent })[intentKey]

export const markNotebookExecutionIntent = (
  request: object,
  intent: NotebookExecutionIntent,
  credential?: string
): void => {
  Object.assign(request, {
    [intentKey]: intent,
    ...(credential ? { [credentialKey]: credential } : {})
  })
}

export const notebookExecutionCredential = (request: object): string | undefined =>
  (request as { [credentialKey]?: string })[credentialKey]

type NotebookUserOperation = Readonly<{
  refusalId?: string
  projectId?: string
  assertCurrent(): void
}>
const userOperationKey = Symbol('Trusted Notebook user operation')
export const withNotebookUserOperation = <T extends object>(
  request: T,
  operation: NotebookUserOperation
): T => Object.assign({}, request, { [userOperationKey]: operation })
export const notebookUserOperation = (request: object): NotebookUserOperation | undefined =>
  (request as { [userOperationKey]?: NotebookUserOperation })[userOperationKey]

// Active credentials/Attempts keep their authority alive. Completed turns need no durable ledger.
export class NotebookExecutionIntentOwner {
  private readonly scopes = new Map<string, Set<WeakRef<NotebookExecutionIntent>>>()
  private readonly currentIntents = new Map<string, NotebookExecutionIntent>()
  private readonly origins = new Map<string, WeakRef<NotebookExecutionIntent>>()

  private readonly collectedOrigins = new FinalizationRegistry<string>((key) => {
    if (!this.origins.get(key)?.deref()) this.origins.delete(key)
  })

  private live(scope: NotebookExecutionIntentScope): Set<WeakRef<NotebookExecutionIntent>> {
    const key = JSON.stringify([scope.projectId, scope.sessionId])
    const refs = this.scopes.get(key) ?? new Set<WeakRef<NotebookExecutionIntent>>()
    for (const ref of refs) if (!ref.deref()) refs.delete(ref)
    this.scopes.set(key, refs)
    return refs
  }

  create(scope: NotebookExecutionIntentScope): NotebookExecutionIntent {
    const intent = new NotebookExecutionIntent(Object.freeze({ ...scope }))
    this.bind(scope, intent)
    return intent
  }

  bind(scope: NotebookExecutionIntentScope, intent: NotebookExecutionIntent): void {
    this.register(scope, intent)
    this.currentIntents.set(JSON.stringify([scope.projectId, scope.sessionId]), intent)
  }

  adopt(scope: NotebookExecutionIntentScope, sessionId: string): void {
    if (scope.sessionId === sessionId) return
    const previousKey = JSON.stringify([scope.projectId, scope.sessionId])
    const canonicalScope = { projectId: scope.projectId, sessionId }
    const canonicalKey = JSON.stringify([scope.projectId, sessionId])
    for (const ref of this.live(scope)) {
      const intent = ref.deref()
      if (intent) this.register(canonicalScope, intent)
    }
    this.scopes.delete(previousKey)
    const previous = this.currentIntents.get(previousKey)
    if (previous && !this.currentIntents.has(canonicalKey))
      this.currentIntents.set(canonicalKey, previous)
    this.currentIntents.delete(previousKey)
  }

  forgetDeleted(deletion: NotebookExecutionIntentDeletion): void {
    const sessionIds = new Set('sessionIds' in deletion ? deletion.sessionIds : [])
    const matches = (key: string): boolean => {
      const [projectId, sessionId] = JSON.parse(key) as [string, string]
      return 'projectId' in deletion ? projectId === deletion.projectId : sessionIds.has(sessionId)
    }
    for (const key of this.scopes.keys()) {
      if (!matches(key)) continue
      this.scopes.delete(key)
      this.currentIntents.delete(key)
    }
    for (const [key, ref] of this.origins) {
      if (!matches(key)) continue
      this.collectedOrigins.unregister(ref)
      this.origins.delete(key)
    }
  }

  current(scope: NotebookExecutionIntentScope): NotebookExecutionIntent | undefined {
    return this.currentIntents.get(JSON.stringify([scope.projectId, scope.sessionId]))
  }

  blockedContinuations(projectId: string): readonly NotebookExecutionContinuation[] {
    return [...this.currentIntents.entries()].flatMap(([key, intent]) => {
      const [ownerProjectId, sessionId] = JSON.parse(key) as [string, string]
      return ownerProjectId === projectId && intent.refusalId
        ? [
            {
              projectId,
              sessionId,
              refusalId: intent.refusalId,
              messageBranchId: intent.scope.messageBranchId
            }
          ]
        : []
    })
  }

  register(scope: NotebookExecutionIntentScope, intent: NotebookExecutionIntent): void {
    const refs = this.live(scope)
    if (![...refs].some((ref) => ref.deref() === intent)) refs.add(new WeakRef(intent))
  }

  remember(
    scope: NotebookExecutionIntentScope,
    promptMessageId: string,
    intent: NotebookExecutionIntent
  ): void {
    this.register(scope, intent)
    const key = JSON.stringify([scope.projectId, scope.sessionId, promptMessageId])
    const previous = this.origins.get(key)
    if (previous?.deref() === intent) return
    if (previous) this.collectedOrigins.unregister(previous)
    const ref = new WeakRef(intent)
    this.origins.set(key, ref)
    this.collectedOrigins.register(intent, key, ref)
  }

  resolve(
    scope: NotebookExecutionIntentScope,
    promptMessageId: string
  ): NotebookExecutionIntent | undefined {
    return this.origins
      .get(JSON.stringify([scope.projectId, scope.sessionId, promptMessageId]))
      ?.deref()
  }

  refused(
    scope: NotebookExecutionIntentScope,
    refusalId: string
  ): NotebookExecutionIntent | undefined {
    for (const ref of this.live(scope)) {
      const intent = ref.deref()
      if (intent?.refusalId === refusalId) return intent
    }
    return undefined
  }

  block(
    scope: NotebookExecutionIntentScope,
    reason: string
  ): readonly NotebookExecutionContinuation[] {
    const affected = new Set<NotebookExecutionIntent>()
    for (const ref of this.live(scope)) {
      const intent = ref.deref()
      if (intent) {
        intent.block(reason)
        affected.add(intent)
      }
    }
    // A resource scope may belong to another originating user Session. Offer continuation only
    // for that Session's current binding, never an obsolete intent retained by a late callback.
    return [...this.currentIntents.entries()].flatMap(([key, intent]) => {
      if (!affected.has(intent) || !intent.refusalId) return []
      const [projectId, sessionId] = JSON.parse(key) as [string, string]
      return [
        {
          projectId,
          sessionId,
          refusalId: intent.refusalId,
          messageBranchId: intent.scope.messageBranchId
        }
      ]
    })
  }
}
