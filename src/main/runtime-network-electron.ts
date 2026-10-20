import { session } from 'electron'
import { configureRuntimeNetwork } from './runtime-network'
import { netFetchStandard, netFetchWithManualRedirect } from './network-fetch-electron'

export function installElectronNetwork(): void {
  configureRuntimeNetwork({
    fetch: netFetchStandard,
    fetchWithManualRedirect: netFetchWithManualRedirect,
    resolveProxy: (url) => session.defaultSession.resolveProxy(url),
    setProxy: (config) => session.defaultSession.setProxy(config)
  })
}
