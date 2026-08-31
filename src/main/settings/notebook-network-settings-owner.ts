import {
  normalizeNotebookNetworkSettings,
  type NotebookNetworkSettings
} from '../../shared/notebook-network'
import type { SetNotebookNetworkRequest } from '../../shared/settings'
import type { SettingsRepository } from './repository'

type NotebookNetworkSettingsOwnerOptions = Readonly<{
  repository: Pick<SettingsRepository, 'getSettings' | 'setNotebookNetwork'>
  apply: (settings: NotebookNetworkSettings) => Promise<void>
}>

class NotebookNetworkSettingsOwner {
  private writeTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: NotebookNetworkSettingsOwnerOptions) {}

  async get(): Promise<NotebookNetworkSettings> {
    return normalizeNotebookNetworkSettings(
      (await this.options.repository.getSettings()).notebookNetwork
    )
  }

  set(request: SetNotebookNetworkRequest): Promise<NotebookNetworkSettings> {
    return this.enqueue((current) => this.mergeRequest(current, request))
  }

  allowDomain(hostname: string): Promise<NotebookNetworkSettings> {
    return this.enqueue((current) => ({
      ...current,
      allowedDomains: [...new Set([...current.allowedDomains, hostname])]
    }))
  }

  private enqueue(
    update: (current: NotebookNetworkSettings) => NotebookNetworkSettings
  ): Promise<NotebookNetworkSettings> {
    const operation = this.writeTail.then(() => this.commit(update))
    this.writeTail = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  private mergeRequest(
    current: NotebookNetworkSettings,
    request: SetNotebookNetworkRequest
  ): NotebookNetworkSettings {
    const requested = normalizeNotebookNetworkSettings(request)
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
    update: (current: NotebookNetworkSettings) => NotebookNetworkSettings
  ): Promise<NotebookNetworkSettings> {
    const previous = await this.get()
    const stored = await this.options.repository.setNotebookNetwork(update(previous))
    const notebookNetwork = normalizeNotebookNetworkSettings(stored.notebookNetwork)
    try {
      await this.options.apply(notebookNetwork)
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
