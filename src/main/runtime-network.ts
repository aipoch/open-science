// Shared by the Electron and Node adapters; host ports do not import an adapter's types.
export type RuntimeProxyConfig = Readonly<{
  mode?: 'direct' | 'auto_detect' | 'pac_script' | 'fixed_servers' | 'system'
  pacScript?: string
  proxyBypassRules?: string
  proxyRules?: string
}>

export type RuntimeNetwork = Readonly<{
  fetch: typeof fetch
  fetchWithManualRedirect: typeof fetch
  resolveProxy: (url: string) => Promise<string>
  setProxy: (config: RuntimeProxyConfig) => Promise<void>
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
