import {
  DelegateExecutionError,
  type DelegateCapacityReservation,
  type DelegateExecution,
  type DelegateExecutionInput,
  type RunningDelegateExecution
} from './execution-port'
import {
  allocateDelegateNames,
  assertNoRemovedDelegateContext,
  createAdmissionGate
} from './delegated-work-admission'
import { DurableDelegatedWorkError } from './durable-delegated-work-error'

type SessionKey = Readonly<{ projectId: string; sessionId: string }>
type AgentCaller = Readonly<{
  session: SessionKey
  frameId: string
  role: 'main' | 'delegate' | 'reviewer'
}>
type DelegateRequest = Readonly<{
  task: string
  name: string
  profile?: string
  inputs?: readonly string[]
}>
type DelegatedWorkErrorCode =
  | 'admission_rejection'
  | 'authorization'
  | 'conflict'
  | 'capacity'
  | 'unsupported_framework'
  | 'execution_failure'
  | 'durability_failure'
  | 'interruption'

class DelegatedWorkError extends Error {
  constructor(
    readonly code: DelegatedWorkErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'DelegatedWorkError'
  }
}

type CancellationReason = 'main_agent_stop' | 'session_stop' | 'runtime_interrupted'
type DelegateReceipt = Readonly<{
  frameId: string
  attemptId: string
  name: string
  status: 'running'
}>
type DelegateResult = Readonly<{
  frameId: string
  attemptId: string
  name: string
  status: 'completed' | 'cancelled' | 'error'
  terminalMessageId?: string
  response?: string
  cancellationReason?: CancellationReason
  error?: Readonly<{ code: DelegatedWorkErrorCode; message: string }>
}>
type DelegateOutcome =
  | Readonly<{ kind: 'receipts'; children: readonly DelegateReceipt[] }>
  | Readonly<{ kind: 'results'; children: readonly DelegateResult[] }>
type ChildSummary = Readonly<{
  frameId: string
  attemptId: string
  title: string
  status: 'running' | 'completed' | 'cancelled' | 'error'
  awaitingPermission?: boolean
}>
type MessageOutcome =
  | Readonly<{ kind: 'queued'; targetFrameId: string; attemptId?: string }>
  | Readonly<{ kind: 'continued'; child: DelegateReceipt }>
type StopOutcome = Readonly<{ frameId: string; status: 'cancelled' | 'already_terminal' }>
type RecoveryOutcome = Readonly<{ interrupted: readonly DelegateResult[] }>

type DelegatedWork = Readonly<{
  delegate(
    caller: AgentCaller,
    requests: DelegateRequest | readonly DelegateRequest[],
    options?: Readonly<{ wait?: boolean }>
  ): Promise<DelegateOutcome>
  children(caller: AgentCaller, frameIds?: readonly string[]): Promise<readonly ChildSummary[]>
  collect(caller: AgentCaller, frameIds: readonly string[]): Promise<readonly DelegateResult[]>
  sendMessage(
    caller: AgentCaller,
    target: string | 'parent',
    message: string,
    kind?: 'info' | 'question'
  ): Promise<MessageOutcome>
  stop(caller: AgentCaller, frameIds: readonly string[]): Promise<readonly StopOutcome[]>
  stopSession(session: SessionKey): Promise<readonly StopOutcome[]>
  recoverInterrupted(): Promise<RecoveryOutcome>
}>

type AttemptRecord = {
  id: string
  status: 'running' | 'completed' | 'cancelled' | 'error'
  result?: DelegateResult
  execution?: RunningDelegateExecution
  reservation?: DelegateCapacityReservation
  slotId?: string
  waiters: Array<(result: DelegateResult) => void>
}
type ChildRecord = {
  session: SessionKey
  frameId: string
  parentFrameId: string
  title: string
  request: DelegateRequest
  attempts: AttemptRecord[]
  awaitingPermission: boolean
}
declare const delegatedWorkMemoryState: unique symbol
type DelegatedWorkMemoryState = Readonly<{ [delegatedWorkMemoryState]: true }>
type MemoryData = {
  children: ChildRecord[]
  nextFrame: number
  nextAttempt: number
  nextMessage: number
  admit: <Result>(operation: () => Promise<Result>) => Promise<Result>
}
const memoryStates = new WeakMap<DelegatedWorkMemoryState, MemoryData>()

const createDelegatedWorkMemoryState = (): DelegatedWorkMemoryState => {
  const state = Object.freeze({}) as DelegatedWorkMemoryState
  memoryStates.set(state, {
    children: [],
    nextFrame: 1,
    nextAttempt: 1,
    nextMessage: 1,
    admit: createAdmissionGate()
  })
  return state
}

const sameSession = (left: SessionKey, right: SessionKey): boolean =>
  left.projectId === right.projectId && left.sessionId === right.sessionId

const createDelegatedWork = (options: {
  execution: DelegateExecution
  state?: DelegatedWorkMemoryState
}): DelegatedWork => {
  const stateHandle = options.state ?? createDelegatedWorkMemoryState()
  const state = memoryStates.get(stateHandle)
  if (!state) throw new DelegatedWorkError('durability_failure', 'unknown delegated-work state')
  const currentAttempt = (child: ChildRecord): AttemptRecord =>
    child.attempts[child.attempts.length - 1]
  const findAuthorizedChild = (caller: AgentCaller, frameId: string): ChildRecord => {
    const child = state.children.find(
      (candidate) => sameSession(candidate.session, caller.session) && candidate.frameId === frameId
    )
    if (!child || child.parentFrameId !== caller.frameId || caller.role !== 'main') {
      throw new DelegatedWorkError('authorization', `caller cannot access child ${frameId}`)
    }
    return child
  }
  const terminalize = (
    child: ChildRecord,
    attempt: AttemptRecord,
    result: Omit<DelegateResult, 'name'>
  ): boolean => {
    if (attempt.status !== 'running') return false
    attempt.status = result.status
    attempt.result = Object.freeze({ ...result, name: child.title })
    child.awaitingPermission = false
    for (const resolve of attempt.waiters.splice(0)) resolve(attempt.result)
    return true
  }
  const run = (
    child: ChildRecord,
    attempt: AttemptRecord,
    reservation: DelegateCapacityReservation,
    slotId: string,
    continuation: boolean
  ): void => {
    const input: DelegateExecutionInput = {
      session: child.session,
      frameId: child.frameId,
      attemptId: attempt.id,
      runtimeSegmentId: `runtime-${attempt.id}`,
      task: child.request.task,
      inputs: child.request.inputs ?? [],
      profile: child.request.profile,
      continuation
    }
    let handle: RunningDelegateExecution
    try {
      handle = options.execution.run(input, slotId)
      attempt.execution = handle
      attempt.reservation = reservation
      attempt.slotId = slotId
    } catch (error) {
      terminalize(child, attempt, {
        frameId: child.frameId,
        attemptId: attempt.id,
        status: 'error',
        error: {
          code: 'execution_failure',
          message: error instanceof Error ? error.message : String(error)
        }
      })
      void reservation.release(slotId)
      return
    }
    const unsubscribe = handle.subscribe((event) => {
      if (attempt.status !== 'running') return
      if (event.kind === 'permission') child.awaitingPermission = event.awaiting
    })
    void (async () => {
      try {
        await Promise.race([handle.accepted, handle.completion.then(() => undefined)])
        const outcome = await handle.completion
        if (outcome.status === 'completed') {
          terminalize(child, attempt, {
            frameId: child.frameId,
            attemptId: attempt.id,
            status: 'completed',
            terminalMessageId: `message-${state.nextMessage++}`,
            response: outcome.response
          })
        } else {
          terminalize(child, attempt, {
            frameId: child.frameId,
            attemptId: attempt.id,
            status: 'cancelled',
            cancellationReason: 'main_agent_stop'
          })
        }
      } catch (error) {
        terminalize(child, attempt, {
          frameId: child.frameId,
          attemptId: attempt.id,
          status: 'error',
          error: {
            code: 'execution_failure',
            message: error instanceof Error ? error.message : String(error)
          }
        })
      } finally {
        unsubscribe()
        await reservation.release(slotId)
      }
    })()
  }
  const collectOne = (child: ChildRecord): Promise<DelegateResult> => {
    const attempt = currentAttempt(child)
    if (attempt.result) return Promise.resolve(attempt.result)
    return new Promise((resolve) => attempt.waiters.push(resolve))
  }
  const stopChild = async (
    child: ChildRecord,
    reason: CancellationReason
  ): Promise<StopOutcome> => {
    const attempt = currentAttempt(child)
    if (attempt.status !== 'running') return { frameId: child.frameId, status: 'already_terminal' }
    terminalize(child, attempt, {
      frameId: child.frameId,
      attemptId: attempt.id,
      status: 'cancelled',
      cancellationReason: reason
    })
    await attempt.execution?.cancel().catch(() => undefined)
    return { frameId: child.frameId, status: 'cancelled' }
  }

  const module: DelegatedWork = {
    async delegate(caller, requestOrRequests, delegateOptions = {}) {
      if (caller.role !== 'main') {
        throw new DelegatedWorkError('authorization', 'only the Main Agent can delegate work')
      }
      const requests = Array.isArray(requestOrRequests) ? requestOrRequests : [requestOrRequests]
      try {
        assertNoRemovedDelegateContext(requests)
      } catch (error) {
        if (error instanceof DurableDelegatedWorkError) {
          throw new DelegatedWorkError(error.code, error.message)
        }
        throw error
      }
      if (requests.length === 0 || requests.some((request) => request.task.trim().length === 0)) {
        throw new DelegatedWorkError('admission_rejection', 'delegation requires one or more tasks')
      }
      if (requests.some((request) => typeof request.name !== 'string')) {
        throw new DelegatedWorkError(
          'admission_rejection',
          'delegation requires an explicit delegate name; provide a 1–48-code-point non-emoji name and retry'
        )
      }
      if (
        requests.some(
          (request) => request.profile !== undefined && request.profile.trim().length === 0
        )
      ) {
        throw new DelegatedWorkError('admission_rejection', 'an explicit profile cannot be empty')
      }
      const created = await state.admit(async () => {
        let names: readonly string[]
        try {
          names = allocateDelegateNames(
            requests.map((request) => request.name),
            state.children
              .filter(
                (child) =>
                  sameSession(child.session, caller.session) &&
                  child.parentFrameId === caller.frameId
              )
              .map((child) => child.title)
          )
        } catch (error) {
          if (error instanceof DurableDelegatedWorkError) {
            throw new DelegatedWorkError(error.code, error.message)
          }
          throw error
        }
        let reservation: DelegateCapacityReservation
        try {
          reservation = await options.execution.reserve(requests.length)
        } catch (error) {
          if (error instanceof DelegateExecutionError) {
            throw new DelegatedWorkError(error.code, error.message)
          }
          throw new DelegatedWorkError(
            'capacity',
            error instanceof Error ? error.message : String(error)
          )
        }
        return requests.map((request, index) => {
          const frameId = `frame-${state.nextFrame++}`
          const attempt: AttemptRecord = {
            id: `attempt-${state.nextAttempt++}`,
            status: 'running',
            waiters: []
          }
          const child: ChildRecord = {
            session: caller.session,
            frameId,
            parentFrameId: caller.frameId,
            title: names[index],
            request: { ...request, name: names[index] },
            attempts: [attempt],
            awaitingPermission: false
          }
          state.children.push(child)
          run(child, attempt, reservation, reservation.slotIds[index], false)
          return child
        })
      })
      const receipts = created.map((child): DelegateReceipt => ({
        frameId: child.frameId,
        attemptId: currentAttempt(child).id,
        name: child.title,
        status: 'running'
      }))
      if (delegateOptions.wait === false) return { kind: 'receipts', children: receipts }
      return { kind: 'results', children: await Promise.all(created.map(collectOne)) }
    },
    async children(caller, frameIds) {
      const children = frameIds
        ? frameIds.map((frameId) => findAuthorizedChild(caller, frameId))
        : state.children.filter(
            (child) =>
              sameSession(child.session, caller.session) && child.parentFrameId === caller.frameId
          )
      if (caller.role !== 'main') {
        throw new DelegatedWorkError('authorization', 'only the Main Agent can inspect children')
      }
      return children.map((child): ChildSummary => {
        const attempt = currentAttempt(child)
        return {
          frameId: child.frameId,
          attemptId: attempt.id,
          title: child.title,
          status: attempt.status,
          ...(attempt.status === 'running' && child.awaitingPermission
            ? { awaitingPermission: true }
            : {})
        }
      })
    },
    async collect(caller, frameIds) {
      if (frameIds.length === 0) {
        throw new DelegatedWorkError('admission_rejection', 'collect requires at least one child')
      }
      return Promise.all(
        frameIds.map((frameId) => collectOne(findAuthorizedChild(caller, frameId)))
      )
    },
    async sendMessage(caller, target, message) {
      if (message.trim().length === 0) {
        throw new DelegatedWorkError('admission_rejection', 'message cannot be empty')
      }
      if (target === 'parent') {
        if (caller.role !== 'delegate') {
          throw new DelegatedWorkError('authorization', 'only a delegate can address its parent')
        }
        const source = state.children.find(
          (child) => sameSession(child.session, caller.session) && child.frameId === caller.frameId
        )
        if (!source || currentAttempt(source).status !== 'running') {
          throw new DelegatedWorkError('conflict', 'only a running delegate can message its parent')
        }
        return {
          kind: 'queued',
          targetFrameId: source.parentFrameId,
          attemptId: currentAttempt(source).id
        }
      }
      const child = findAuthorizedChild(caller, target)
      const attempt = currentAttempt(child)
      if (attempt.status === 'running') {
        await attempt.execution?.sendMessage(message)
        return { kind: 'queued', targetFrameId: child.frameId, attemptId: attempt.id }
      }
      let reservation: DelegateCapacityReservation
      try {
        reservation = await options.execution.reserve(1)
      } catch (error) {
        if (error instanceof DelegateExecutionError)
          throw new DelegatedWorkError(error.code, error.message)
        throw new DelegatedWorkError(
          'capacity',
          error instanceof Error ? error.message : String(error)
        )
      }
      if (currentAttempt(child) !== attempt) {
        await reservation.releaseAll()
        throw new DelegatedWorkError('conflict', 'child changed while continuation was admitted')
      }
      const continued: AttemptRecord = {
        id: `attempt-${state.nextAttempt++}`,
        status: 'running',
        waiters: []
      }
      child.request = { ...child.request, task: message }
      child.attempts.push(continued)
      run(child, continued, reservation, reservation.slotIds[0], true)
      return {
        kind: 'continued',
        child: {
          frameId: child.frameId,
          attemptId: continued.id,
          name: child.title,
          status: 'running'
        }
      }
    },
    async stop(caller, frameIds) {
      return Promise.all(
        frameIds.map((frameId) =>
          stopChild(findAuthorizedChild(caller, frameId), 'main_agent_stop')
        )
      )
    },
    async stopSession(session) {
      return Promise.all(
        state.children
          .filter(
            (child) =>
              sameSession(child.session, session) && currentAttempt(child).status === 'running'
          )
          .map((child) => stopChild(child, 'session_stop'))
      )
    },
    async recoverInterrupted() {
      const interrupted: DelegateResult[] = []
      for (const child of state.children) {
        const attempt = currentAttempt(child)
        const result: Omit<DelegateResult, 'name'> = {
          frameId: child.frameId,
          attemptId: attempt.id,
          status: 'cancelled',
          cancellationReason: 'runtime_interrupted'
        }
        if (terminalize(child, attempt, result)) interrupted.push(attempt.result!)
      }
      return { interrupted }
    }
  }
  return module
}

export { DelegatedWorkError, createDelegatedWork, createDelegatedWorkMemoryState }
export type {
  AgentCaller,
  CancellationReason,
  ChildSummary,
  DelegateOutcome,
  DelegateReceipt,
  DelegateRequest,
  DelegateResult,
  DelegatedWork,
  DelegatedWorkErrorCode,
  DelegatedWorkMemoryState,
  MessageOutcome,
  RecoveryOutcome,
  SessionKey,
  StopOutcome
}
