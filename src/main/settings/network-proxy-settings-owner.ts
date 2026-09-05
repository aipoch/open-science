import type { NetworkProxySettings } from '../../shared/network-proxy'
import { resolveNetworkProxySettings } from '../../shared/network-proxy'
import type { SetNetworkProxyRequest } from '../../shared/settings'
import type { SettingsRepository } from './repository'

type NetworkProxySettingsOwnerOptions = Readonly<{
  repository: Pick<SettingsRepository, 'getSettings' | 'setNetworkProxy'>
  apply: (settings: NetworkProxySettings) => Promise<void>
}>

// Owns the full persist-and-apply transaction so concurrent Settings saves cannot leave the
// stored preference and the live Electron proxy in different orders.
class NetworkProxySettingsOwner {
  private writeTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: NetworkProxySettingsOwnerOptions) {}

  set(request: SetNetworkProxyRequest): Promise<NetworkProxySettings> {
    const operation = this.writeTail.then(() => this.commit(request))
    this.writeTail = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  private async commit(request: SetNetworkProxyRequest): Promise<NetworkProxySettings> {
    const previous = resolveNetworkProxySettings(
      (await this.options.repository.getSettings()).networkProxy
    )
    const stored = await this.options.repository.setNetworkProxy(request)
    const networkProxy = resolveNetworkProxySettings(stored.networkProxy)

    try {
      await this.options.apply(networkProxy)
    } catch (error) {
      const rollbackErrors: unknown[] = []
      try {
        await this.options.repository.setNetworkProxy(previous)
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
          'Could not apply or restore the proxy configuration.'
        )
      }
      throw error
    }

    return networkProxy
  }
}

export { NetworkProxySettingsOwner }
