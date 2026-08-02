import type { ActiveSession } from '@agentclientprotocol/sdk'

import { AcpSessionAggregate, type AcpSessionAggregateAttachInput } from './session-aggregate'

type RegistryOptions = {
  addStartupBlocker?: (token: symbol) => void
  removeStartupBlocker?: (token: symbol) => void
  foreignIdentityCollision?: (sessionIds: readonly string[]) => Error | undefined
}
type AcpSessionAttachment = Readonly<{
  appSessionId: string
  providerSessionId: string
  generation: number
  session: ActiveSession
}>
type SessionRecord = {
  aggregate: AcpSessionAggregate
  generation: number
  attachment?: AcpSessionAttachment
}
type AcpSessionRegistryEntry = Readonly<SessionRecord & { appSessionId: string }>
type AcpPrimarySessionIdentityReservation = Readonly<{
  assertCurrent: () => void
  renew: (publishedAppSessionId?: string) => boolean
  release: () => void
}>
type ReservationRequest = {
  sessionIds: readonly string[]
  reservation?: AcpPrimarySessionIdentityReservation
  publishedAppSessionId?: string
  startupGeneration?: number
  mayRenewAfterConnectionSetup?: boolean
  blockStartup?: boolean
}
type AcpPrimarySessionIdentityReservationResult =
  | { reservation: AcpPrimarySessionIdentityReservation; collision?: never }
  | { reservation?: never; collision: Error }
type Removal = Readonly<{ removed: boolean; wasActive: boolean; currentSessionId?: string }>
type AcpSessionDeletion = Readonly<{
  finish: (target?: AcpSessionRegistryEntry) => Removal
}>
type IdentityEpoch = { value: number; deletions: number; reservations: number }
type ReservationState = {
  blocked: boolean
  deletionEpochs: Map<string, number>
  generation: number
  mayRenewAfterConnectionSetup: boolean
  token: symbol
  sessionIds: Set<string>
}
const registryEntry = (appSessionId: string, record: SessionRecord): AcpSessionRegistryEntry => ({
  appSessionId,
  ...record
})
const supersededError = (): Error => new Error('ACP session startup was superseded.')
class AcpSessionRegistry {
  private readonly records = new Map<string, SessionRecord>()
  private readonly providerAliases = new Map<string, { appSessionId: string; generation: number }>()
  private readonly pendingPrimarySessionIds = new Map<string, symbol>()
  private readonly reservationStates = new Map<
    AcpPrimarySessionIdentityReservation,
    ReservationState
  >()
  private readonly identityEpochs = new Map<string, IdentityEpoch>()
  private nextAttachmentGeneration = 0
  private startupGenerationValue = 0
  private currentSessionIdValue: string | undefined
  constructor(private readonly options: RegistryOptions = {}) {}
  get startupGeneration(): number {
    return this.startupGenerationValue
  }
  get currentSessionId(): string | undefined {
    return this.currentSessionIdValue
  }
  lookup(appSessionId: string): AcpSessionRegistryEntry | undefined {
    const record = this.records.get(appSessionId)
    return record ? registryEntry(appSessionId, record) : undefined
  }
  resolveAppSessionId(providerSessionId: string): string {
    return this.providerAliases.get(providerSessionId)?.appSessionId ?? providerSessionId
  }
  isIdentityClaimed(sessionId: string): boolean {
    const record = this.records.get(sessionId)
    return Boolean(
      record?.attachment ||
      this.providerAliases.has(sessionId) ||
      this.pendingPrimarySessionIds.has(sessionId)
    )
  }
  entries(activeOnly = false): AcpSessionRegistryEntry[] {
    const entries: AcpSessionRegistryEntry[] = []
    for (const [appSessionId, record] of this.records) {
      if (!activeOnly || record.attachment) entries.push(registryEntry(appSessionId, record))
    }
    return entries
  }
  ensureAffinity(appSessionId: string): AcpSessionRegistryEntry {
    const existing = this.records.get(appSessionId)
    if (existing) return registryEntry(appSessionId, existing)
    const record = { aggregate: new AcpSessionAggregate(appSessionId), generation: 0 }
    this.records.set(appSessionId, record)
    return registryEntry(appSessionId, record)
  }
  select(appSessionId: string | undefined): void {
    this.currentSessionIdValue = appSessionId
  }
  clearAppliedModels(): void {
    for (const record of this.records.values()) record.aggregate.clearAppliedModel()
  }
  reserve(request: ReservationRequest): AcpPrimarySessionIdentityReservationResult {
    const state = request.reservation ? this.reservationStates.get(request.reservation) : undefined
    const generation = state?.generation ?? request.startupGeneration ?? this.startupGenerationValue
    if ((request.reservation && !state) || generation !== this.startupGenerationValue) {
      return { collision: supersededError() }
    }
    const sessionIds = [...new Set(request.sessionIds)]
    const deleting = sessionIds.find((id) => (this.identityEpochs.get(id)?.deletions ?? 0) > 0)
    if (deleting) {
      return {
        collision: new Error(`Primary session id collision with deletion in progress: ${deleting}`)
      }
    }
    const foreignCollision = this.options.foreignIdentityCollision?.(sessionIds)
    if (foreignCollision) return { collision: foreignCollision }
    const primaryCollision = sessionIds.find((sessionId) => {
      const pendingOwner = this.pendingPrimarySessionIds.get(sessionId)
      return (
        (pendingOwner !== undefined && pendingOwner !== state?.token) ||
        (this.records.get(sessionId)?.attachment !== undefined &&
          sessionId !== request.publishedAppSessionId) ||
        this.providerAliases.has(sessionId)
      )
    })
    if (primaryCollision) {
      return { collision: new Error(`Primary session id collision: ${primaryCollision}`) }
    }
    const reservation = request.reservation ?? this.createReservation()
    const owner =
      state ??
      ({
        blocked: request.blockStartup !== false,
        deletionEpochs: new Map(),
        generation,
        mayRenewAfterConnectionSetup: request.mayRenewAfterConnectionSetup ?? false,
        token: Symbol('primary-session-identity'),
        sessionIds: new Set()
      } satisfies ReservationState)
    if (!state) {
      this.reservationStates.set(reservation, owner)
      if (owner.blocked) this.options.addStartupBlocker?.(owner.token)
    }
    for (const sessionId of sessionIds) {
      if (!owner.deletionEpochs.has(sessionId)) {
        const epoch = this.epoch(sessionId)
        owner.deletionEpochs.set(sessionId, epoch.value)
        epoch.reservations += 1
      }
      owner.sessionIds.add(sessionId)
      this.pendingPrimarySessionIds.set(sessionId, owner.token)
    }
    return { reservation }
  }
  publish(
    reservation: AcpPrimarySessionIdentityReservation,
    appSessionId: string,
    input: AcpSessionAggregateAttachInput
  ): AcpSessionRegistryEntry {
    const state = this.assertReservation(reservation)
    if (!state.sessionIds.has(appSessionId) || !state.sessionIds.has(input.session.sessionId)) {
      throw supersededError()
    }
    const record = this.records.get(appSessionId) ?? {
      aggregate: new AcpSessionAggregate(appSessionId),
      generation: 0
    }
    const wasAttached = record.attachment !== undefined
    if (record.attachment) this.deleteAlias(record.attachment)
    record.aggregate.attach(input)
    record.generation = ++this.nextAttachmentGeneration
    record.attachment = Object.freeze({
      appSessionId,
      providerSessionId: input.session.sessionId,
      generation: record.generation,
      session: input.session
    })
    if (this.records.has(appSessionId) && !wasAttached) this.records.delete(appSessionId)
    this.records.set(appSessionId, record)
    if (input.session.sessionId !== appSessionId) {
      this.providerAliases.set(input.session.sessionId, {
        appSessionId,
        generation: record.generation
      })
    }
    this.currentSessionIdValue = appSessionId
    return registryEntry(appSessionId, record)
  }
  detach(attachment: AcpSessionAttachment, mode: 'provider' | 'connection'): boolean {
    const record = this.records.get(attachment.appSessionId)
    if (!record?.attachment || record.attachment.generation !== attachment.generation) return false
    this.deleteAlias(record.attachment)
    record.attachment = undefined
    if (mode === 'provider') record.aggregate.detachProvider()
    else {
      record.aggregate.detachConnection()
      if (this.currentSessionIdValue === attachment.appSessionId) {
        this.currentSessionIdValue = undefined
      }
    }
    return true
  }
  beginDelete(appSessionId: string): AcpSessionDeletion {
    const startingGeneration = this.records.get(appSessionId)?.generation
    const wasActiveAtStart = this.records.get(appSessionId)?.attachment !== undefined
    const epoch = this.epoch(appSessionId)
    epoch.value += 1
    epoch.deletions += 1
    let result: Removal | undefined
    return Object.freeze({
      finish: (target) => {
        if (result) return result
        const record = this.records.get(appSessionId)
        const matches =
          target?.appSessionId === appSessionId &&
          target.generation === startingGeneration &&
          target.generation === record?.generation
        const wasActive = Boolean(matches && wasActiveAtStart)
        if (matches && record) {
          if (record.attachment) this.deleteAlias(record.attachment)
          this.records.delete(appSessionId)
          if (wasActive && this.currentSessionIdValue === appSessionId) {
            this.currentSessionIdValue = this.entries(true)[0]?.appSessionId
          }
        }
        this.releaseEpoch(appSessionId, 'deletions')
        result = {
          removed: Boolean(matches),
          wasActive,
          currentSessionId: this.currentSessionIdValue
        }
        return result
      }
    })
  }
  invalidatePending(): void {
    this.startupGenerationValue += 1
    this.pendingPrimarySessionIds.clear()
    for (const state of this.reservationStates.values()) this.removeBlocker(state)
  }
  private createReservation(): AcpPrimarySessionIdentityReservation {
    const reservation: AcpPrimarySessionIdentityReservation = {
      assertCurrent: () => this.assertReservation(reservation),
      renew: (publishedAppSessionId) => this.renewReservation(reservation, publishedAppSessionId),
      release: () => this.releaseReservation(reservation)
    }
    return Object.freeze(reservation)
  }
  private assertReservation(reservation: AcpPrimarySessionIdentityReservation): ReservationState {
    const state = this.reservationStates.get(reservation)
    if (
      !state ||
      state.generation !== this.startupGenerationValue ||
      this.reservationWasDeleted(state) ||
      [...state.sessionIds].some(
        (sessionId) => this.pendingPrimarySessionIds.get(sessionId) !== state.token
      )
    ) {
      throw supersededError()
    }
    return state
  }
  private renewReservation(
    reservation: AcpPrimarySessionIdentityReservation,
    publishedAppSessionId?: string
  ): boolean {
    const state = this.reservationStates.get(reservation)
    if (!state) throw supersededError()
    const previousGeneration = state.generation
    const crossedGeneration = previousGeneration !== this.startupGenerationValue
    const previousPermit = state.mayRenewAfterConnectionSetup
    if (this.reservationWasDeleted(state) || (crossedGeneration && !previousPermit)) {
      throw supersededError()
    }
    state.generation = this.startupGenerationValue
    state.mayRenewAfterConnectionSetup = false
    const result = this.reserve({
      reservation,
      sessionIds: [...state.sessionIds],
      publishedAppSessionId
    })
    if (result.collision) {
      state.generation = previousGeneration
      state.mayRenewAfterConnectionSetup = previousPermit
      throw result.collision
    }
    if (!state.blocked) {
      state.blocked = true
      this.options.addStartupBlocker?.(state.token)
    }
    return crossedGeneration
  }
  private releaseReservation(reservation: AcpPrimarySessionIdentityReservation): void {
    const state = this.reservationStates.get(reservation)
    if (!state) return
    this.removeBlocker(state)
    for (const sessionId of state.sessionIds) {
      if (this.pendingPrimarySessionIds.get(sessionId) === state.token) {
        this.pendingPrimarySessionIds.delete(sessionId)
      }
      this.releaseEpoch(sessionId, 'reservations')
    }
    this.reservationStates.delete(reservation)
  }
  private removeBlocker(state: ReservationState): void {
    if (!state.blocked) return
    state.blocked = false
    this.options.removeStartupBlocker?.(state.token)
  }
  private deleteAlias(attachment: AcpSessionAttachment): void {
    if (
      this.providerAliases.get(attachment.providerSessionId)?.generation === attachment.generation
    ) {
      this.providerAliases.delete(attachment.providerSessionId)
    }
  }
  private reservationWasDeleted(state: ReservationState): boolean {
    return [...state.deletionEpochs].some(
      ([id, value]) => value !== (this.identityEpochs.get(id)?.value ?? 0)
    )
  }
  private epoch(sessionId: string): IdentityEpoch {
    const existing = this.identityEpochs.get(sessionId)
    if (existing) return existing
    const created = { value: 0, deletions: 0, reservations: 0 }
    this.identityEpochs.set(sessionId, created)
    return created
  }
  private releaseEpoch(sessionId: string, owner: 'deletions' | 'reservations'): void {
    const epoch = this.identityEpochs.get(sessionId)
    if (!epoch) return
    epoch[owner] -= 1
    if (epoch.deletions === 0 && epoch.reservations === 0) this.identityEpochs.delete(sessionId)
  }
}
export { AcpSessionRegistry }
export type {
  AcpPrimarySessionIdentityReservation,
  AcpPrimarySessionIdentityReservationResult,
  AcpSessionAttachment,
  AcpSessionDeletion,
  AcpSessionRegistryEntry
}
