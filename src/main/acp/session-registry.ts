import type { ActiveSession } from '@agentclientprotocol/sdk'

import { AcpSessionAggregate, type AcpSessionAggregateAttachInput } from './session-aggregate'

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

type AcpSessionRemoval = Readonly<{
  removed: boolean
  wasActive: boolean
  currentSessionId?: string
}>

const registryEntry = (appSessionId: string, record: SessionRecord): AcpSessionRegistryEntry => ({
  appSessionId,
  ...record
})

class AcpSessionRegistry {
  private readonly records = new Map<string, SessionRecord>()
  private readonly providerAliases = new Map<string, { appSessionId: string; generation: number }>()
  private nextAttachmentGeneration = 0
  private currentSessionIdValue: string | undefined

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

  hasProviderAlias(providerSessionId: string): boolean {
    return this.providerAliases.has(providerSessionId)
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

  publish(appSessionId: string, input: AcpSessionAggregateAttachInput): AcpSessionRegistryEntry {
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

  remove(target: AcpSessionRegistryEntry): AcpSessionRemoval {
    const record = this.records.get(target.appSessionId)
    const matches = record?.generation === target.generation
    const wasActive = Boolean(matches && target.attachment)
    if (matches && record) {
      if (record.attachment) this.deleteAlias(record.attachment)
      this.records.delete(target.appSessionId)
      if (wasActive && this.currentSessionIdValue === target.appSessionId) {
        this.currentSessionIdValue = this.entries(true)[0]?.appSessionId
      }
    }
    return { removed: Boolean(matches), wasActive, currentSessionId: this.currentSessionIdValue }
  }

  private deleteAlias(attachment: AcpSessionAttachment): void {
    if (
      this.providerAliases.get(attachment.providerSessionId)?.generation === attachment.generation
    ) {
      this.providerAliases.delete(attachment.providerSessionId)
    }
  }
}

export { AcpSessionRegistry }
export type { AcpSessionAttachment, AcpSessionRegistryEntry, AcpSessionRemoval }
