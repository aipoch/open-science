import { isDeepStrictEqual } from 'node:util'
import { reviewPrivateDestination } from '@aipoch/notebook-network-sandbox'
import {
  normalizeNotebookNetworkSettings,
  normalizeTrustedPrivateDestinations,
  type PrivateDestinationRequest,
  type PrivateDestinationReview,
  type NotebookNetworkSettings
} from '../../shared/notebook-network'
import type { SetNotebookNetworkRequest } from '../../shared/settings'
import type { SettingsRepository } from './repository'

type NotebookNetworkSettingsOwnerOptions = Readonly<{
  repository: Pick<SettingsRepository, 'getSettings' | 'setNotebookNetwork'>
  apply: (settings: NotebookNetworkSettings, previous: NotebookNetworkSettings) => Promise<void>
  beforeProtectionChange?: () => Promise<(() => void) | void>
}>

class NotebookNetworkSettingsOwner {
  private writeTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: NotebookNetworkSettingsOwnerOptions) {}

  async get(): Promise<NotebookNetworkSettings> {
    return normalizeNotebookNetworkSettings(
      (await this.options.repository.getSettings()).notebookNetwork
    )
  }

  review(request: PrivateDestinationRequest): Promise<PrivateDestinationReview> {
    return reviewPrivateDestination(request)
  }

  set(request: SetNotebookNetworkRequest): Promise<NotebookNetworkSettings> {
    return this.enqueue((current) => this.mergeRequest(current, request))
  }

  setWindowsProtectionEnabled(enabled: boolean): Promise<NotebookNetworkSettings> {
    return this.enqueue((current) => ({ ...current, windowsProtectionEnabled: enabled }))
  }

  allowDomain(hostname: string): Promise<NotebookNetworkSettings> {
    return this.enqueue((current) => ({
      ...current,
      allowedDomains: [...new Set([...current.allowedDomains, hostname])]
    }))
  }

  private enqueue(
    update: (
      current: NotebookNetworkSettings
    ) => NotebookNetworkSettings | Promise<NotebookNetworkSettings>
  ): Promise<NotebookNetworkSettings> {
    const operation = this.writeTail.then(() => this.commit(update))
    this.writeTail = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  private async mergeRequest(
    current: NotebookNetworkSettings,
    request: SetNotebookNetworkRequest
  ): Promise<NotebookNetworkSettings> {
    let requested = normalizeNotebookNetworkSettings(request)
    if (request.windowsProtectionEnabled === undefined) {
      requested = {
        ...requested,
        ...(current.windowsProtectionEnabled !== undefined
          ? { windowsProtectionEnabled: current.windowsProtectionEnabled }
          : {})
      }
    }
    if (request.trustedPrivateDestinations === undefined) {
      // Public-only and historical clients must not erase independently reviewed grants.
      requested = { ...requested, trustedPrivateDestinations: current.trustedPrivateDestinations }
    } else {
      const rules = normalizeTrustedPrivateDestinations(request.trustedPrivateDestinations)
      if (!isDeepStrictEqual(rules, request.trustedPrivateDestinations))
        throw new Error('Invalid trusted private service.')
      if (
        !isDeepStrictEqual(
          request.baseTrustedPrivateDestinations ?? [],
          current.trustedPrivateDestinations ?? []
        )
      )
        throw new Error('Private services changed. Reopen this page before saving.')
      for (const rule of rules) {
        if (
          (current.trustedPrivateDestinations ?? []).some((saved) => isDeepStrictEqual(saved, rule))
        )
          continue
        const review = await this.review(rule)
        if (!review.ok || !isDeepStrictEqual(review.destination, rule))
          throw new Error('Private service addresses changed. Review the service again.')
      }
    }
    if (request.baseAllowedDomains === undefined) return requested

    const baseline = normalizeNotebookNetworkSettings({
      ...requested,
      allowedDomains: request.baseAllowedDomains
    }).allowedDomains
    const requestedDomains = new Set(requested.allowedDomains)
    const baselineDomains = new Set(baseline)
    const removed = new Set(baseline.filter((domain) => !requestedDomains.has(domain)))
    const added = requested.allowedDomains.filter((domain) => !baselineDomains.has(domain))
    return {
      ...requested,
      allowedDomains: [
        ...new Set([...current.allowedDomains.filter((domain) => !removed.has(domain)), ...added])
      ]
    }
  }

  private async commit(
    update: (
      current: NotebookNetworkSettings
    ) => NotebookNetworkSettings | Promise<NotebookNetworkSettings>
  ): Promise<NotebookNetworkSettings> {
    const previous = await this.get()
    const next = await update(previous)
    const release =
      previous.windowsProtectionEnabled !== next.windowsProtectionEnabled
        ? await this.options.beforeProtectionChange?.()
        : undefined
    try {
      const stored = await this.options.repository.setNotebookNetwork(next)
      const notebookNetwork = normalizeNotebookNetworkSettings(stored.notebookNetwork)
      try {
        await this.options.apply(notebookNetwork, previous)
      } catch (error) {
        const rollbackErrors: unknown[] = []
        try {
          await this.options.repository.setNotebookNetwork(previous)
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
        try {
          await this.options.apply(previous, notebookNetwork)
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [error, ...rollbackErrors],
            'Could not apply or restore Notebook network access.'
          )
        }
        throw error
      }
      return notebookNetwork
    } finally {
      release?.()
    }
  }
}

export { NotebookNetworkSettingsOwner }
