import { createHash } from 'node:crypto'

import type { AuthenticatedDelegateCaller } from './authenticated-delegate-caller'
import { currentAttempt, sameSession } from './delegated-work-record-invariants'
import type {
  DelegatedWorkDurableRecords,
  DurableChild,
  DurableMessageCommand,
  DurablePendingMessage,
  DurableSnapshot
} from './delegated-work-record-types'
import type {
  DurableSendMessageOptions,
  DurableSendMessageOutcome,
  ParentMessageDelivery,
  SessionKey
} from './durable-delegated-work-contract'
import { DurableDelegatedWorkError } from './durable-delegated-work-error'
import {
  DelegateMessageParkedError,
  DelegateMessagePreAcceptanceError,
  type DelegateMessageAcceptanceEvidence
} from './execution-port'

type PreparedContinuation = Readonly<{
  start(): Readonly<{ accepted: Promise<DelegateMessageAcceptanceEvidence> }>
  abort(error?: unknown): Promise<void>
}>

type MessageDeliveryOwnerOptions = Readonly<{
  records: DelegatedWorkDurableRecords
  now: () => number
  admission: <Result>(operation: () => Promise<Result>) => Promise<Result>
  deliverToParent?: (delivery: ParentMessageDelivery) => Promise<DelegateMessageAcceptanceEvidence>
  runningDelivery(
    frameId: string,
    attemptId: string
  ):
    | Readonly<{
        deliver(message: DurablePendingMessage): Promise<DelegateMessageAcceptanceEvidence>
      }>
    | undefined
  prepareContinuation(
    caller: AuthenticatedDelegateCaller,
    child: DurableChild,
    command: DurableMessageCommand
  ): Promise<PreparedContinuation>
}>

const receiptOf = (command: DurableMessageCommand): DurableSendMessageOutcome => {
  const base = {
    request_id: command.requestId,
    message_id: command.messageId,
    source_frame_id: command.sourceFrameId,
    target_frame_id: command.targetFrameId,
    ...(command.replyToMessageId ? { reply_to_message_id: command.replyToMessageId } : {}),
    queued_at: command.queuedAt,
    same_request_safe: true as const
  }
  const route =
    command.direction === 'to_parent'
      ? {
          direction: 'to_parent' as const,
          disposition: 'message' as const,
          source_attempt_id: command.sourceAttemptId!,
          root_prompt_message_id: command.rootPromptMessageId!
        }
      : command.disposition === 'continued'
        ? {
            direction: 'to_child' as const,
            disposition: 'continued' as const,
            continuation_attempt_id: command.continuationAttemptId!
          }
        : {
            direction: 'to_child' as const,
            disposition: 'message' as const,
            target_attempt_id: command.targetAttemptId!
          }
  const state = command.receipt
  if (state.status === 'queued') {
    return {
      ...base,
      ...route,
      status: 'queued',
      ...(state.dispatchStartedAt === undefined
        ? {}
        : { dispatch_started_at: state.dispatchStartedAt }),
      new_request_retry_safe: false
    }
  }
  if (state.status === 'accepted') {
    return {
      ...base,
      ...route,
      status: 'accepted',
      accepted_at: state.acceptedAt,
      evidence: state.evidence,
      new_request_retry_safe: false
    }
  }
  if (state.status === 'failed') {
    return {
      ...base,
      ...route,
      status: 'failed',
      failed_at: state.failedAt,
      error: { ...state.error, delivery_may_have_occurred: false },
      new_request_retry_safe: state.error.retryable
    }
  }
  return {
    ...base,
    ...route,
    status: 'uncertain',
    uncertain_at: state.uncertainAt,
    delivery_may_have_occurred: true,
    resolution: state.resolution,
    new_request_retry_safe: false
  }
}

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

const principalOf = (caller: AuthenticatedDelegateCaller): string =>
  caller.role === 'delegate' ? `${caller.frameId}\u0000${caller.attemptId ?? ''}` : caller.frameId

const laneOf = (command: Pick<DurableMessageCommand, 'sourceFrameId' | 'targetFrameId'>): string =>
  `${command.sourceFrameId}\u0000${command.targetFrameId}`

export class ReliableMessageDeliveryOwner {
  private readonly preparedContinuations = new Map<string, PreparedContinuation>()
  private readonly lanePumps = new Map<string, Promise<void>>()
  private upwardPump?: Promise<void>

  constructor(private readonly options: MessageDeliveryOwnerOptions) {}

  private messageId(
    caller: AuthenticatedDelegateCaller,
    principal: string,
    requestId: string
  ): string {
    return `message-${digest({ session: caller.session, sourcePrincipal: principal, requestId }).slice(0, 32)}`
  }

  private async readAuthorized(
    caller: AuthenticatedDelegateCaller,
    selector: string
  ): Promise<DurableMessageCommand> {
    const snapshot = await this.options.records.snapshot()
    if (snapshot.messageCommandsQuarantined) {
      throw new DurableDelegatedWorkError(
        'durability_failure',
        'reliable message owner is quarantined'
      )
    }
    const principal = principalOf(caller)
    const command = snapshot.messageCommands.find(
      (candidate) =>
        candidate.messageId === selector ||
        (candidate.sourcePrincipal === principal && candidate.requestId === selector)
    )
    const source = command
      ? (snapshot.records.find(({ frameId }) => frameId === command.sourceFrameId) as
          DurableChild | undefined)
      : undefined
    const sourceAttempt = source && currentAttempt(source)
    const activeBinding =
      command?.rootBranchId === snapshot.rootBranchId &&
      command.rootBranchRevision === snapshot.rootBranchRevision &&
      snapshot.originMessageIds.includes(command.rootOriginMessageId)
    const delegateOwns =
      command &&
      caller.role === 'delegate' &&
      command.sourcePrincipal === principal &&
      source?.parentFrameId === snapshot.rootFrameId &&
      sourceAttempt?.status === 'running' &&
      sourceAttempt.id === caller.attemptId &&
      activeBinding
    const rootControls =
      command &&
      caller.role === 'main' &&
      caller.frameId === snapshot.rootFrameId &&
      snapshot.originMessageIds.includes(caller.originMessageId) &&
      activeBinding
    if (
      !command ||
      !sameSession(snapshot.session, caller.session) ||
      !caller.toolInvocationId.trim() ||
      (!delegateOwns && !rootControls)
    ) {
      throw new DurableDelegatedWorkError('authorization', 'message receipt is unavailable')
    }
    return command
  }

  private duplicate(
    snapshot: DurableSnapshot,
    sourcePrincipal: string,
    requestId: string,
    canonicalDigest: string
  ): DurableSendMessageOutcome | undefined {
    const command = snapshot.messageCommands.find(
      (candidate) =>
        candidate.sourcePrincipal === sourcePrincipal && candidate.requestId === requestId
    )
    if (!command) return undefined
    if (command.canonicalDigest !== canonicalDigest) {
      throw new DurableDelegatedWorkError(
        'conflict',
        'message request_id was already used for a different request'
      )
    }
    return receiptOf(command)
  }

  private validateReply(
    snapshot: DurableSnapshot,
    replyToMessageId: string | undefined,
    sourceFrameId: string,
    targetFrameId: string,
    rootOriginMessageId: string
  ): void {
    if (!replyToMessageId) return
    const opposite = snapshot.messageCommands.find(
      ({ messageId }) => messageId === replyToMessageId
    )
    if (
      !opposite ||
      opposite.kind !== 'question' ||
      opposite.sourceFrameId !== targetFrameId ||
      opposite.targetFrameId !== sourceFrameId ||
      opposite.rootOriginMessageId !== rootOriginMessageId ||
      opposite.rootBranchId !== snapshot.rootBranchId ||
      opposite.rootBranchRevision !== snapshot.rootBranchRevision
    ) {
      throw new DurableDelegatedWorkError('conflict', 'reply_to_message_id is invalid')
    }
  }

  private nextLaneSequence(snapshot: DurableSnapshot, source: string, target: string): number {
    return (
      1 +
      Math.max(
        0,
        ...snapshot.messageCommands
          .filter(
            (candidate) => candidate.sourceFrameId === source && candidate.targetFrameId === target
          )
          .map(({ laneSequence }) => laneSequence)
      )
    )
  }

  async sendMessage(
    caller: AuthenticatedDelegateCaller,
    targetFrameId: string | 'parent',
    message: string,
    sendOptions: DurableSendMessageOptions = {}
  ): Promise<DurableSendMessageOutcome> {
    const kind = sendOptions.kind ?? 'info'
    const requestId = sendOptions.requestId ?? caller.toolInvocationId
    if (!requestId.trim() || requestId.length > 256) {
      throw new DurableDelegatedWorkError('admission_rejection', 'request_id is invalid')
    }
    return this.options.admission(async () => {
      if (typeof message !== 'string' || !message.trim()) {
        throw new DurableDelegatedWorkError('admission_rejection', 'message cannot be empty')
      }
      if (kind !== 'info' && kind !== 'question') {
        throw new DurableDelegatedWorkError(
          'admission_rejection',
          'message kind must be info or question'
        )
      }
      const snapshot = await this.options.records.snapshot()
      if (snapshot.messageCommandsQuarantined) {
        throw new DurableDelegatedWorkError(
          'durability_failure',
          'reliable message owner is quarantined'
        )
      }
      return targetFrameId === 'parent'
        ? this.admitUpward(caller, snapshot, message, kind, requestId, sendOptions.replyToMessageId)
        : this.admitDownward(
            caller,
            snapshot,
            targetFrameId,
            message,
            kind,
            requestId,
            sendOptions.replyToMessageId
          )
    })
  }

  private async admitUpward(
    caller: AuthenticatedDelegateCaller,
    snapshot: DurableSnapshot,
    message: string,
    kind: 'info' | 'question',
    requestId: string,
    replyToMessageId?: string
  ): Promise<DurableSendMessageOutcome> {
    const source = snapshot.records.find(({ frameId }) => frameId === caller.frameId) as
      DurableChild | undefined
    const attempt = source && currentAttempt(source)
    if (
      caller.role !== 'delegate' ||
      !sameSession(snapshot.session, caller.session) ||
      !source ||
      source.parentFrameId !== snapshot.rootFrameId ||
      attempt?.status !== 'running' ||
      attempt.id !== caller.attemptId ||
      !caller.toolInvocationId.trim() ||
      source.originBindingState !== 'validated' ||
      !snapshot.originMessageIds.includes(source.originMessageId)
    ) {
      throw new DurableDelegatedWorkError(
        'authorization',
        'delegate message is outside its authenticated current parent relationship'
      )
    }
    const sourcePrincipal = `${source.frameId}\u0000${attempt.id}`
    const canonicalDigest = digest({
      version: 'sha256-canonical-json-v1',
      target: 'parent',
      message,
      kind,
      reply_to_message_id: replyToMessageId ?? null
    })
    const duplicate = this.duplicate(snapshot, sourcePrincipal, requestId, canonicalDigest)
    if (duplicate) return duplicate
    this.validateReply(
      snapshot,
      replyToMessageId,
      source.frameId,
      source.parentFrameId,
      source.originMessageId
    )
    const queuedAt = this.options.now()
    const messageId = this.messageId(caller, sourcePrincipal, requestId)
    const command: DurableMessageCommand = {
      messageId,
      requestId,
      sourcePrincipal,
      canonicalDigest,
      sourceFrameId: source.frameId,
      sourceAttemptId: attempt.id,
      targetFrameId: source.parentFrameId,
      rootPromptMessageId: `${messageId}-root-prompt`,
      rootOriginMessageId: source.originMessageId,
      callerRootMessageId: caller.originMessageId,
      rootBranchId: snapshot.rootBranchId,
      rootBranchRevision: snapshot.rootBranchRevision,
      direction: 'to_parent',
      disposition: 'message',
      text: message,
      kind,
      ...(replyToMessageId ? { replyToMessageId } : {}),
      laneSequence: this.nextLaneSequence(snapshot, source.frameId, source.parentFrameId),
      queuedAt,
      receipt: { status: 'queued' }
    }
    await this.options.records.admitMessage(command)
    this.wakeLane(command, caller.session)
    return receiptOf(command)
  }

  private async admitDownward(
    caller: AuthenticatedDelegateCaller,
    snapshot: DurableSnapshot,
    targetFrameId: string,
    message: string,
    kind: 'info' | 'question',
    requestId: string,
    replyToMessageId?: string
  ): Promise<DurableSendMessageOutcome> {
    if (
      caller.role !== 'main' ||
      !sameSession(snapshot.session, caller.session) ||
      caller.frameId !== snapshot.rootFrameId ||
      !snapshot.originMessageIds.includes(caller.originMessageId) ||
      !caller.toolInvocationId.trim()
    ) {
      throw new DurableDelegatedWorkError(
        'authorization',
        'continuation caller is outside the active root conversation'
      )
    }
    const child = snapshot.records.find(
      (candidate) =>
        candidate.frameId === targetFrameId && candidate.parentFrameId === caller.frameId
    ) as DurableChild | undefined
    if (
      !child ||
      child.originBindingState !== 'validated' ||
      !snapshot.originMessageIds.includes(child.originMessageId)
    ) {
      throw new DurableDelegatedWorkError(
        'authorization',
        `caller cannot access child ${targetFrameId}`
      )
    }
    const sourcePrincipal = caller.frameId
    const canonicalDigest = digest({
      version: 'sha256-canonical-json-v1',
      target: targetFrameId,
      message,
      kind,
      reply_to_message_id: replyToMessageId ?? null
    })
    const duplicate = this.duplicate(snapshot, sourcePrincipal, requestId, canonicalDigest)
    if (duplicate) return duplicate
    this.validateReply(
      snapshot,
      replyToMessageId,
      caller.frameId,
      child.frameId,
      child.originMessageId
    )
    const previous = currentAttempt(child)
    const common = {
      messageId: this.messageId(caller, sourcePrincipal, requestId),
      requestId,
      sourcePrincipal,
      canonicalDigest,
      sourceFrameId: caller.frameId,
      targetFrameId: child.frameId,
      rootOriginMessageId: child.originMessageId,
      callerRootMessageId: caller.originMessageId,
      rootBranchId: snapshot.rootBranchId,
      rootBranchRevision: snapshot.rootBranchRevision,
      direction: 'to_child' as const,
      text: message,
      kind,
      ...(replyToMessageId ? { replyToMessageId } : {}),
      laneSequence: this.nextLaneSequence(snapshot, caller.frameId, child.frameId),
      queuedAt: this.options.now(),
      receipt: { status: 'queued' as const }
    }
    if (previous.status === 'running') {
      const command: DurableMessageCommand = {
        ...common,
        targetAttemptId: previous.id,
        disposition: 'message'
      }
      await this.options.records.admitMessage(command)
      this.wakeLane(command, caller.session)
      return receiptOf(command)
    }
    const command: DurableMessageCommand = {
      ...common,
      continuationAttemptId: '',
      disposition: 'continued'
    }
    const prepared = await this.options.prepareContinuation(caller, child, command)
    try {
      const persisted = (await this.options.records.snapshot()).messageCommands.find(
        ({ sourcePrincipal: principal, requestId: id }) =>
          principal === sourcePrincipal && id === requestId
      )
      if (!persisted) {
        throw new DurableDelegatedWorkError(
          'durability_failure',
          'continuation message admission was not committed'
        )
      }
      this.preparedContinuations.set(persisted.messageId, prepared)
      this.wakeLane(persisted, caller.session)
      return receiptOf(persisted)
    } catch (error) {
      await prepared.abort(error)
      throw error
    }
  }

  private wakeLane(command: DurableMessageCommand, session: SessionKey): void {
    if (command.direction === 'to_parent') {
      if (this.upwardPump) return
      const pump = this.pumpUpward(session).finally(() => {
        if (this.upwardPump === pump) this.upwardPump = undefined
      })
      this.upwardPump = pump
      void pump.catch(() => undefined)
      return
    }
    const lane = laneOf(command)
    if (this.lanePumps.has(lane)) return
    const pump = this.pumpLane(lane, session).finally(() => {
      if (this.lanePumps.get(lane) === pump) this.lanePumps.delete(lane)
    })
    this.lanePumps.set(lane, pump)
    void pump.catch(() => undefined)
  }

  private async pumpUpward(session: SessionKey): Promise<void> {
    for (;;) {
      const snapshot = await this.options.records.snapshot()
      const candidates = snapshot.messageCommands
        .filter(
          (candidate) =>
            candidate.direction === 'to_parent' && candidate.receipt.status === 'queued'
        )
        .filter(
          (command) =>
            !snapshot.messageCommands.some(
              (candidate) =>
                laneOf(candidate) === laneOf(command) &&
                candidate.laneSequence < command.laneSequence &&
                (candidate.receipt.status === 'queued' ||
                  (candidate.receipt.status === 'uncertain' &&
                    candidate.receipt.resolution === 'pending'))
            )
        )
        .sort(
          (left, right) =>
            left.queuedAt - right.queuedAt || left.messageId.localeCompare(right.messageId)
        )
      const command = candidates[0]
      if (!command) return
      if (!(await this.dispatch(command, session))) return
    }
  }

  private async pumpLane(lane: string, session: SessionKey): Promise<void> {
    for (;;) {
      const snapshot = await this.options.records.snapshot()
      const command = snapshot.messageCommands
        .filter((candidate) => laneOf(candidate) === lane && candidate.receipt.status === 'queued')
        .sort((left, right) => left.laneSequence - right.laneSequence)[0]
      if (!command) return
      const blockedByUncertain = snapshot.messageCommands.some(
        (candidate) =>
          laneOf(candidate) === lane &&
          candidate.laneSequence < command.laneSequence &&
          candidate.receipt.status === 'uncertain' &&
          candidate.receipt.resolution === 'pending'
      )
      if (blockedByUncertain) return
      const progressed = await this.dispatch(command, session)
      if (!progressed) return
    }
  }

  private async dispatch(command: DurableMessageCommand, session: SessionKey): Promise<boolean> {
    const prepared = this.preparedContinuations.get(command.messageId)
    let dispatchStarted = false
    try {
      // A durable dispatch marker means the side effect may already have happened. Only restart
      // recovery may convert that fenced command to uncertain; ordinary wakeups must never replay it.
      if (command.receipt.status === 'queued' && command.receipt.dispatchStartedAt !== undefined) {
        return false
      }
      if (command.direction === 'to_parent') {
        if (!this.options.deliverToParent || !command.sourceAttemptId) {
          await this.fail(
            command.messageId,
            'root_runtime_unavailable',
            'parent app-owned message delivery is unavailable'
          )
          return true
        }
        let evidence: DelegateMessageAcceptanceEvidence
        try {
          evidence = await this.options.deliverToParent({
            messageId: command.messageId,
            session,
            sourceFrameId: command.sourceFrameId,
            sourceAttemptId: command.sourceAttemptId,
            targetFrameId: command.targetFrameId,
            originMessageId: command.rootOriginMessageId,
            rootPromptMessageId: command.rootPromptMessageId!,
            rootBranchId: command.rootBranchId,
            rootBranchRevision: command.rootBranchRevision,
            text: command.text,
            kind: command.kind,
            startDispatch: async () => {
              const started = await this.options.records.markMessageDispatchStarted(
                command.messageId,
                this.options.now(),
                `${command.messageId}-dispatch`,
                command.rootBranchId,
                command.rootBranchRevision
              )
              dispatchStarted = started === 'started'
              return started
            }
          })
        } catch (error) {
          if (error instanceof DelegateMessageParkedError) return false
          if (error instanceof DelegateMessagePreAcceptanceError) {
            await this.fail(command.messageId, 'root_pre_accept_failure', error.message)
            return true
          }
          throw error
        }
        await this.accept(command.messageId, evidence)
        return true
      }
      const started = await this.options.records.markMessageDispatchStarted(
        command.messageId,
        this.options.now(),
        `${command.messageId}-dispatch`,
        command.rootBranchId,
        command.rootBranchRevision
      )
      if (started === 'terminal') return true
      if (started !== 'started') return false
      dispatchStarted = true
      if (command.disposition === 'continued') {
        if (!prepared) {
          await this.fail(
            command.messageId,
            'target_attempt_unavailable',
            'continuation is unavailable after restart'
          )
          return true
        }
        const launch = prepared.start()
        let evidence: DelegateMessageAcceptanceEvidence
        try {
          evidence = await launch.accepted
        } catch (error) {
          if (error instanceof DelegateMessagePreAcceptanceError) {
            await this.fail(
              command.messageId,
              'continuation_start_failed',
              'continuation runtime did not accept the message'
            )
            return true
          }
          throw error
        } finally {
          this.preparedContinuations.delete(command.messageId)
        }
        await this.accept(command.messageId, evidence)
        return true
      }
      const active = command.targetAttemptId
        ? this.options.runningDelivery(command.targetFrameId, command.targetAttemptId)
        : undefined
      if (!active || !command.targetAttemptId) {
        await this.fail(
          command.messageId,
          'target_attempt_unavailable',
          'target Attempt is unavailable'
        )
        return true
      }
      let evidence: DelegateMessageAcceptanceEvidence
      try {
        evidence = await active.deliver({
          id: command.messageId,
          sourceFrameId: command.sourceFrameId,
          targetFrameId: command.targetFrameId,
          targetAttemptId: command.targetAttemptId,
          text: command.text,
          kind: command.kind,
          createdAt: command.queuedAt
        })
      } catch (error) {
        if (error instanceof DelegateMessagePreAcceptanceError) {
          await this.fail(command.messageId, 'provider_pre_accept_failure', error.message)
          return true
        }
        throw error
      }
      await this.accept(command.messageId, evidence)
      return true
    } catch {
      if (!dispatchStarted) return false
      // The dispatch fence exists, so any post-fence failure is conservatively uncertain.
      await this.options.records.settleMessage(command.messageId, {
        status: 'uncertain',
        uncertainAt: this.options.now(),
        resolution: 'pending'
      })
      return false
    }
  }

  private async accept(
    messageId: string,
    evidence: DelegateMessageAcceptanceEvidence
  ): Promise<void> {
    await this.options.records.settleMessage(messageId, {
      status: 'accepted',
      acceptedAt: this.options.now(),
      evidence
    })
  }

  private async fail(messageId: string, code: string, message: string): Promise<void> {
    await this.options.records.settleMessage(messageId, {
      status: 'failed',
      failedAt: this.options.now(),
      error: { code, message, retryable: true }
    })
  }

  async messageReceipt(
    caller: AuthenticatedDelegateCaller,
    selector: string,
    options: Readonly<{ timeoutSeconds?: number }> = {}
  ): Promise<DurableSendMessageOutcome> {
    const timeoutSeconds = options.timeoutSeconds ?? 30
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 1800) {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'message_receipt timeout_seconds must be a finite number from 0 through 1800'
      )
    }
    const startedAt = performance.now()
    for (;;) {
      const command = await this.readAuthorized(caller, selector)
      if (command.receipt.status !== 'queued' || timeoutSeconds === 0) return receiptOf(command)
      if (performance.now() - startedAt >= timeoutSeconds * 1000) {
        return receiptOf(await this.readAuthorized(caller, selector))
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, timeoutSeconds * 1000)))
    }
  }

  async resolveMessage(
    caller: AuthenticatedDelegateCaller,
    messageId: string,
    options: Readonly<{ action: 'acknowledge_uncertain' }>
  ): Promise<DurableSendMessageOutcome> {
    if (options.action !== 'acknowledge_uncertain') {
      throw new DurableDelegatedWorkError(
        'admission_rejection',
        'resolve_message action is invalid'
      )
    }
    const command = await this.readAuthorized(caller, messageId)
    if (caller.role !== 'main') {
      throw new DurableDelegatedWorkError('authorization', 'only root Main can resolve a message')
    }
    if (command.receipt.status !== 'uncertain') {
      throw new DurableDelegatedWorkError('conflict', 'message is not uncertain')
    }
    await this.options.records.acknowledgeUncertain(command.messageId)
    this.wakeLane(command, caller.session)
    return receiptOf(await this.readAuthorized(caller, messageId))
  }

  async recover(snapshot: DurableSnapshot): Promise<void> {
    for (const command of snapshot.messageCommands) {
      if (command.receipt.status !== 'queued') continue
      if (command.receipt.dispatchStartedAt !== undefined) {
        await this.options.records.settleMessage(command.messageId, {
          status: 'uncertain',
          uncertainAt: this.options.now(),
          resolution: 'pending'
        })
      } else if (command.direction === 'to_child') {
        await this.fail(
          command.messageId,
          'target_attempt_unavailable',
          'target Attempt is unavailable after restart'
        )
      } else if (snapshot.originMessageIds.includes(command.rootOriginMessageId)) {
        this.wakeLane(command, snapshot.session)
      }
    }
  }

  wake(snapshot: DurableSnapshot): void {
    for (const command of snapshot.messageCommands) {
      if (command.receipt.status === 'queued') this.wakeLane(command, snapshot.session)
    }
  }
}
