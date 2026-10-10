import type { ProxyConfig } from 'electron'

export type RuntimeNetwork = Readonly<{
  fetch: typeof fetch
  fetchWithManualRedirect: typeof fetch
  resolveProxy: (url: string) => Promise<string>
  setProxy: (config: ProxyConfig) => Promise<void>
}>
let network: RuntimeNetwork | undefined
export function configureRuntimeNetwork(value: RuntimeNetwork): void {
  if (network) throw new Error('Runtime network is already configured.')
  network = value
}
export function runtimeNetwork(): RuntimeNetwork {
  if (!network) throw new Error('Runtime network must be configured by the host entry.')
  return network
}
