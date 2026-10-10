import { session } from 'electron'
import { configureRuntimeNetwork } from './runtime-network'
import { netFetchStandard, netFetchWithManualRedirect } from './skills/net-fetch-electron'

export function installElectronNetwork(): void {
  configureRuntimeNetwork({
    fetch: netFetchStandard,
    fetchWithManualRedirect: netFetchWithManualRedirect,
    resolveProxy: (url) => session.defaultSession.resolveProxy(url),
    setProxy: (config) => session.defaultSession.setProxy(config)
  })
}
