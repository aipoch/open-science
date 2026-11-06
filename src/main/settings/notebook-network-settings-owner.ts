import type { NetworkDestinationGrant } from '../../shared/network-destination-grants'
import { isDeepStrictEqual } from 'node:util'
import { reviewPrivateDestination, validPrivateDestination } from '@aipoch/notebook-network-sandbox'
import {
  type PrivateDestinationRequest,
  type PrivateDestinationReview,
  type NotebookNetworkSettings
} from '../../shared/notebook-network-settings'
import {
  normalizeNotebookNetworkSettings,
  normalizeTrustedPrivateDestinations
} from '../../shared/notebook-network'
import type { SetNotebookNetworkRequest } from '../../shared/settings'
import type { SettingsRepository } from './repository'

const sameManagedRule = (
  left: NonNullable<NotebookNetworkSettings['trustedPrivateDestinations']>[number],
  right: NonNullable<NotebookNetworkSettings['trustedPrivateDestinations']>[number]
): boolean => isDeepStrictEqual(left, right)

const syncManagedDestinationRules = (
  settings: NotebookNetworkSettings
): NotebookNetworkSettings => {
  const grants = settings.destinationGrants ?? []
  const activeGlobalGrants = grants.filter(
    (grant) => grant.scope === 'global' && grant.revokedAt === undefined
  )
  const currentRules = settings.trustedPrivateDestinations
  const manualRules = (currentRules ?? []).filter((rule) => rule.managedGrantId === undefined)
  const activeGrantIds = new Set(activeGlobalGrants.map((grant) => grant.id))
  // New persistent approvals stay in destinationGrants. Keep only already-materialized managed
  // rules for backwards compatibility; Settings remains the writer of manual trust entries.
  const managedRules = (currentRules ?? [])
    .filter((rule) => rule.managedGrantId !== undefined && activeGrantIds.has(rule.managedGrantId))
    .filter(validPrivateDestination)
  const rules = [...manualRules, ...managedRules].sort(
    (left, right) =>
      left.hostname.localeCompare(right.hostname) ||
      left.port - right.port ||
      (left.managedGrantId ?? '').localeCompare(right.managedGrantId ?? '')
  )
  if (!rules.length && currentRules === undefined) {
    const withoutRules = { ...settings }
    delete (withoutRules as { trustedPrivateDestinations?: unknown }).trustedPrivateDestinations
    return withoutRules
  }
  return { ...settings, trustedPrivateDestinations: rules }
}

type NotebookNetworkSettingsOwnerOptions = Readonly<{
  repository: Pick<SettingsRepository, 'getSettings' | 'setNotebookNetwork'>
  apply: (settings: NotebookNetworkSettings) => Promise<void>
}>

class NotebookNetworkSettingsOwner {
  private writeTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: NotebookNetworkSettingsOwnerOptions) {}

  get(): Promise<NotebookNetworkSettings> {
    const operation = this.writeTail.then(() => this.readAndReconcile())
    this.writeTail = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  private async readAndReconcile(): Promise<NotebookNetworkSettings> {
    const current = normalizeNotebookNetworkSettings(
      (await this.options.repository.getSettings()).notebookNetwork
    )
    const reconciled = syncManagedDestinationRules(current)
    if (!isDeepStrictEqual(current, reconciled)) {
      const stored = await this.options.repository.setNotebookNetwork(reconciled)
      return normalizeNotebookNetworkSettings(stored.notebookNetwork)
    }
    return current
  }

  review(request: PrivateDestinationRequest): Promise<PrivateDestinationReview> {
    return reviewPrivateDestination(request)
  }

  set(request: SetNotebookNetworkRequest): Promise<NotebookNetworkSettings> {
    return this.enqueue((current) => this.mergeRequest(current, request))
  }

  allowDomain(
    hostname: string,
    assertCurrent?: () => Promise<void>,
    finalize?: () => Promise<void>
  ): Promise<NotebookNetworkSettings> {
    return this.enqueue(
      (current) => ({
        ...current,
        allowedDomains: [...new Set([...current.allowedDomains, hostname])]
      }),
      assertCurrent,
      finalize
    )
  }

  allowDestination(
    grant: NetworkDestinationGrant,
    assertCurrent?: () => Promise<void>,
    finalize?: () => Promise<void>
  ): Promise<NotebookNetworkSettings> {
    return this.enqueue(
      async (current) => {
        if (
          current.destinationGrants?.some(
            (entry) => entry.id === grant.id && entry.revokedAt !== undefined
          )
        )
          throw Object.assign(new Error('Network grant was revoked.'), {
            code: 'network-grant-revoked'
          })
        return syncManagedDestinationRules({
          ...current,
          destinationGrants: [
            ...(current.destinationGrants ?? []).filter((entry) => entry.id !== grant.id),
            grant
          ]
        })
      },
      assertCurrent,
      finalize
    )
  }

  private enqueue(
    update: (
      current: NotebookNetworkSettings
    ) => NotebookNetworkSettings | Promise<NotebookNetworkSettings>,
    assertCurrent?: () => Promise<void>,
    finalize?: () => Promise<void>
  ): Promise<NotebookNetworkSettings> {
    const operation = this.writeTail.then(() => this.commit(update, assertCurrent, finalize))
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
    // Settings can revoke existing authority; only the conversation approval owner can add it.
    const revoked = request.revokeNetworkGrantIds ?? []
    if (!Array.isArray(revoked) || revoked.some((id) => typeof id !== 'string'))
      throw new Error('Invalid network grant revocation.')
    const revokedIds = new Set(revoked)
    requested = {
      ...requested,
      destinationGrants: (current.destinationGrants ?? []).map((entry) =>
        revokedIds.has(entry.id) ? { ...entry, revokedAt: entry.revokedAt ?? Date.now() } : entry
      ),
      trustedPrivateDestinations: current.trustedPrivateDestinations
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
      const currentRules = current.trustedPrivateDestinations ?? []
      const removedManagedIds = currentRules
        .filter(
          (rule) =>
            rule.managedGrantId !== undefined &&
            !rules.some((candidate) => candidate.managedGrantId === rule.managedGrantId)
        )
        .map((rule) => rule.managedGrantId!)
      for (const id of removedManagedIds) revokedIds.add(id)
      for (const rule of rules) {
        if (rule.managedGrantId !== undefined) {
          const currentManaged = currentRules.find(
            (candidate) => candidate.managedGrantId === rule.managedGrantId
          )
          if (!currentManaged || !sameManagedRule(currentManaged, rule))
            throw new Error('Managed private services are controlled by network approvals.')
          continue
        }
        if (currentRules.some((saved) => isDeepStrictEqual(saved, rule))) continue
      }
      requested = {
        ...requested,
        trustedPrivateDestinations: rules
      }
    }
    requested = {
      ...requested,
      destinationGrants: (current.destinationGrants ?? []).map((entry) =>
        revokedIds.has(entry.id) ? { ...entry, revokedAt: entry.revokedAt ?? Date.now() } : entry
      )
    }
    requested = syncManagedDestinationRules(requested)
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
    ) => NotebookNetworkSettings | Promise<NotebookNetworkSettings>,
    assertCurrent?: () => Promise<void>,
    finalize?: () => Promise<void>
  ): Promise<NotebookNetworkSettings> {
    const previous = await this.readAndReconcile()
    const next = await update(previous)
    await assertCurrent?.()
    const stored = await this.options.repository.setNotebookNetwork(next)
    const notebookNetwork = normalizeNotebookNetworkSettings(stored.notebookNetwork)
    try {
      await assertCurrent?.()
      await this.options.apply(notebookNetwork)
      await assertCurrent?.()
      // Keep approval finalization inside the same serialized rollback scope.
      await finalize?.()
    } catch (error) {
      const rollbackErrors: unknown[] = []
      try {
        await this.options.repository.setNotebookNetwork(previous)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
      try {
        await this.options.apply(previous)
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
  }
}

export { NotebookNetworkSettingsOwner }
