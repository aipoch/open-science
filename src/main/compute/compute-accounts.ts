import {
  assertCredentialAccessAllowed,
  assertCredentialReadAllowed
} from '../credential-identity/runtime'
import { join } from 'node:path'
import { readDurableJsonFile, writeDurableJsonFile } from '@aipoch/durable-files'
import { z } from 'zod'
import {
  COMPUTE_ACCOUNT_CONNECTION_REQUIRED,
  type ComputeAccountProvider,
  type ComputeAccountStatus
} from '../../shared/compute-accounts'
import {
  computeAccountFileNames,
  decodeComputeAccountDocument,
  type ComputeAccountDocument as RecordData
} from '../credential-identity/compute-account-document'
import { OptionalSecureStorageStringProtection } from '../secure-storage'
import {
  AccountAuthError,
  type AccountMaterial,
  type ComputeAccountAdapter,
  type ModalMaterial,
  type HfMaterial
} from './compute-account-adapter'
import {
  hfAccountAdapter,
  hfMaterialSchema,
  readLocalHfToken,
  refreshHf
} from './compute-account-hf'
import { modalAccountAdapter } from './modal-account-auth'

const modalMaterialSchema = z.strictObject({
  tokenId: z.string().min(1),
  tokenSecret: z.string().min(1)
})
type Options = {
  configRoot: () => string
  openExternal: (url: string) => Promise<void>
  protection?: Pick<OptionalSecureStorageStringProtection, 'protect' | 'reveal' | 'isAvailable'>
  adapters?: Record<ComputeAccountProvider, ComputeAccountAdapter>
  refreshHf?: (material: HfMaterial, signal: AbortSignal) => Promise<HfMaterial>
}
function failStatus(
  provider: ComputeAccountProvider,
  error: unknown,
  source?: 'managed' | 'local'
): ComputeAccountStatus {
  const reason = error instanceof AccountAuthError ? error.reason : 'network'
  if (reason === 'missing') return { provider, state: 'disconnected', localAvailable: false }
  return {
    provider,
    source,
    state:
      reason === 'authorization'
        ? 'expired'
        : reason === 'cancelled'
          ? 'disconnected'
          : 'unavailable',
    reason
  }
}
type Flow = { controller: AbortController; status: ComputeAccountStatus }
export class ComputeAccounts {
  private readonly protection
  private readonly adapters
  private readonly queues = new Map<ComputeAccountProvider, Promise<unknown>>()
  private readonly flows = new Map<ComputeAccountProvider, Flow>()
  private readonly cached = new Map<
    ComputeAccountProvider,
    { status: ComputeAccountStatus; until: number }
  >()
  constructor(private readonly options: Options) {
    this.adapters = options.adapters ?? {
      'hugging-face': hfAccountAdapter,
      modal: modalAccountAdapter
    }
    this.protection = options.protection ?? new OptionalSecureStorageStringProtection()
  }
  private queue<T>(provider: ComputeAccountProvider, fn: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(provider) ?? Promise.resolve()).then(fn)
    this.queues.set(
      provider,
      next.catch(() => {})
    )
    return next
  }
  private path(provider: ComputeAccountProvider): string {
    if (provider !== 'hugging-face' && provider !== 'modal')
      throw new AccountAuthError('authorization')
    return join(this.options.configRoot(), computeAccountFileNames[provider])
  }
  private async load(provider: ComputeAccountProvider): Promise<RecordData | undefined> {
    try {
      assertCredentialAccessAllowed()
      const r = await readDurableJsonFile(
        this.path(provider),
        decodeComputeAccountDocument,
        {},
        { maxBytes: 256 * 1024 }
      )
      return r.status === 'found' ? r.value : undefined
    } catch {
      throw new AccountAuthError('storage')
    }
  }
  private async save(provider: ComputeAccountProvider, value: RecordData): Promise<void> {
    try {
      assertCredentialAccessAllowed()
      await writeDurableJsonFile(this.path(provider), JSON.stringify(value))
    } catch {
      throw new AccountAuthError('storage')
    }
  }
  private async storeMaterial(
    provider: ComputeAccountProvider,
    material: AccountMaterial
  ): Promise<void> {
    let sealed: string
    try {
      const validated = (
        provider === 'hugging-face' ? hfMaterialSchema : modalMaterialSchema
      ).parse(material)
      sealed = this.protection.protect(JSON.stringify(validated))
    } catch {
      throw new AccountAuthError('storage')
    }
    await this.save(provider, { version: 1, source: 'managed', sealed })
  }
  // Called under the provider queue so simultaneous Jobs cannot rotate a refresh token twice.
  private async material(
    provider: ComputeAccountProvider,
    record: RecordData | undefined,
    signal: AbortSignal
  ): Promise<AccountMaterial | undefined> {
    signal.throwIfAborted()
    if (record?.source === 'disabled') throw new AccountAuthError('missing')
    if (record?.source !== 'managed') return undefined
    let material: AccountMaterial
    try {
      assertCredentialReadAllowed()
      const raw = JSON.parse(this.protection.reveal(record.sealed))
      material = (provider === 'hugging-face' ? hfMaterialSchema : modalMaterialSchema).parse(raw)
    } catch {
      throw new AccountAuthError('storage')
    }
    if (
      'accessToken' in material &&
      material.expiresAt !== undefined &&
      material.expiresAt < Date.now() + 30000
    ) {
      // Once the issuer rotates a token the old one may be unusable, even if this job stops.
      const refresh = this.options.refreshHf ?? refreshHf
      material = await refresh(material, AbortSignal.timeout(30_000))
      await this.storeMaterial(provider, material)
      signal.throwIfAborted()
    }
    return material
  }
  private remember(status: ComputeAccountStatus): ComputeAccountStatus {
    this.cached.set(status.provider, { status, until: Date.now() + 30000 })
    return status
  }
  status(provider: ComputeAccountProvider, force = false): Promise<ComputeAccountStatus> {
    return this.queue(provider, () => this.currentStatus(provider, force))
  }
  private async currentStatus(
    provider: ComputeAccountProvider,
    force = false
  ): Promise<ComputeAccountStatus> {
    const flow = this.flows.get(provider)
    if (flow) return flow.status
    const previous = this.cached.get(provider)
    if (!force && previous && previous.until > Date.now()) return previous.status
    return this.inspect(provider)
  }
  withConnectedAccount<T>(provider: ComputeAccountProvider, save: () => Promise<T>): Promise<T> {
    return this.queue(provider, async () => {
      // A settings page can outlive its credentials. Keep account changes ordered with the save.
      const status = await this.currentStatus(provider, true)
      if (status.state !== 'connected') throw new Error(COMPUTE_ACCOUNT_CONNECTION_REQUIRED)
      return save()
    })
  }
  private async inspect(provider: ComputeAccountProvider): Promise<ComputeAccountStatus> {
    let source: 'managed' | 'local' | undefined
    try {
      const record = await this.load(provider)
      if (record?.source === 'disabled') return this.remember({ provider, state: 'disconnected' })
      source = record?.source ?? 'local'
      const signal = AbortSignal.timeout(15000)
      const material = await this.material(provider, record, signal)
      const identity = await this.adapters[provider].probe(material, signal)
      return this.remember({
        provider,
        state: 'connected',
        source,
        identity,
        localAvailable: source === 'local' || undefined
      })
    } catch (e) {
      return this.remember(failStatus(provider, e, source))
    }
  }
  private async failedChange(
    provider: ComputeAccountProvider,
    error: unknown
  ): Promise<ComputeAccountStatus> {
    const actual = await this.inspect(provider)
    const failure = failStatus(provider, error)
    return this.remember({ ...actual, reason: failure.reason ?? 'authorization' })
  }
  connect(provider: ComputeAccountProvider): Promise<ComputeAccountStatus> {
    return this.queue(provider, async () => {
      const existing = this.flows.get(provider)
      if (existing?.status.source === 'managed') return existing.status
      if (existing) this.stop(provider)
      if (!this.protection.isAvailable())
        return this.failedChange(provider, new AccountAuthError('storage'))
      const flow: Flow = {
        controller: new AbortController(),
        status: { provider, state: 'pending', source: 'managed' }
      }
      this.flows.set(provider, flow)
      void this.authorize(provider, flow)
      return flow.status
    })
  }
  private async authorize(provider: ComputeAccountProvider, flow: Flow): Promise<void> {
    const signal = AbortSignal.any([flow.controller.signal, AbortSignal.timeout(10 * 60 * 1000)])
    let expiry: ReturnType<typeof setTimeout> | undefined
    try {
      const material = await this.adapters[provider].authorize(async (url, userCode, expiresAt) => {
        signal.throwIfAborted()
        const remaining = expiresAt - Date.now()
        if (remaining <= 0) throw new AccountAuthError('timeout')
        expiry = setTimeout(() => flow.controller.abort(), Math.min(remaining, 600000))
        expiry.unref()
        flow.status = { provider, state: 'pending', source: 'managed', userCode, expiresAt }
        await this.options.openExternal(url)
      }, signal)
      signal.throwIfAborted()
      const identity = await this.adapters[provider].probe(material, signal)
      await this.queue(provider, async () => {
        if (this.flows.get(provider) !== flow) return
        signal.throwIfAborted()
        await this.storeMaterial(provider, material)
        this.flows.delete(provider)
        this.remember({ provider, state: 'connected', source: 'managed', identity })
      })
    } catch (e) {
      await this.queue(provider, async () => {
        if (this.flows.get(provider) !== flow) return
        this.flows.delete(provider)
        await this.failedChange(provider, signal.aborted ? new AccountAuthError('timeout') : e)
      })
    } finally {
      clearTimeout(expiry)
    }
  }
  private stop(provider: ComputeAccountProvider): void {
    this.flows.get(provider)?.controller.abort()
    this.flows.delete(provider)
    this.cached.delete(provider)
  }
  async cancel(provider: ComputeAccountProvider): Promise<ComputeAccountStatus> {
    await this.queue(provider, async () => this.stop(provider))
    return this.status(provider)
  }
  async useLocal(provider: ComputeAccountProvider): Promise<ComputeAccountStatus> {
    const flow: Flow = {
      controller: new AbortController(),
      status: { provider, state: 'pending', source: 'local' }
    }
    await this.queue(provider, async () => {
      this.stop(provider)
      this.flows.set(provider, flow)
    })
    const signal = AbortSignal.any([flow.controller.signal, AbortSignal.timeout(15000)])
    // Leave the queue during discovery so cancel can invalidate even a CLI response already in flight.
    const result = await this.adapters[provider]
      .probe(undefined, signal)
      .catch((error: unknown) => ({ error }))
    return this.queue(provider, async () => {
      if (this.flows.get(provider) !== flow)
        return { ...(await this.currentStatus(provider)), reason: 'cancelled' }
      this.flows.delete(provider)
      try {
        if (signal.aborted) throw new AccountAuthError('timeout')
        if (typeof result !== 'string') throw result.error
        await this.save(provider, { version: 1, source: 'local' })
        return this.remember({
          provider,
          source: 'local',
          state: 'connected',
          localAvailable: true,
          identity: result
        })
      } catch (e) {
        return this.failedChange(provider, e)
      }
    })
  }
  disconnect(provider: ComputeAccountProvider): Promise<ComputeAccountStatus> {
    return this.queue(provider, async () => {
      this.stop(provider)
      try {
        await this.save(provider, { version: 1, source: 'disabled' })
      } catch (e) {
        return this.failedChange(provider, e)
      }
      return this.remember({ provider, state: 'disconnected' })
    })
  }
  hfToken(signal = AbortSignal.timeout(15000)): Promise<string> {
    return this.queue('hugging-face', async () => {
      const saved = await this.material('hugging-face', await this.load('hugging-face'), signal)
      if (!saved) return readLocalHfToken(signal)
      return hfMaterialSchema.parse(saved).accessToken
    })
  }
  modalIdentity(signal = AbortSignal.timeout(15000)): Promise<ModalMaterial | undefined> {
    return this.queue('modal', async () => {
      const saved = await this.material('modal', await this.load('modal'), signal)
      return saved ? modalMaterialSchema.parse(saved) : undefined
    })
  }
}
