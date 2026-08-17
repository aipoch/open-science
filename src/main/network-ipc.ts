import { ipcMainHandle } from './ipc-handler-registry'

import { startDiagnosticOperation } from './diagnostics/operation'
import { createLogger, type Logger } from './logger'
import { checkInternetReachability, getNetworkInfo } from './net/network-info'

import type { NetworkInfo } from '../shared/network'

type NetworkCommandOwner = Readonly<{
  getInfo: () => Promise<NetworkInfo>
  checkConnectivity: () => Promise<boolean>
}>

type NetworkIpcDiagnostics = Readonly<{
  log?: Logger
  now?: () => number
}>

// Network status for the settings Network panel. getInfo answers from local OS state (no
// internet required); checkConnectivity is a real end-to-end HTTPS probe reused from the
// onboarding environment check, so it can tell "internet broken" apart from "link is up".
const createNetworkCommandOwner = (): NetworkCommandOwner => ({
  getInfo: getNetworkInfo,
  checkConnectivity: checkInternetReachability
})

const registerNetworkIpcHandlers = (
  owner: NetworkCommandOwner = createNetworkCommandOwner(),
  diagnostics: NetworkIpcDiagnostics = {}
): NetworkCommandOwner => {
  const log = diagnostics.log ?? createLogger('network')
  ipcMainHandle('network:get-info', () => owner.getInfo())
  ipcMainHandle('network:check-connectivity', async () => {
    const operation = startDiagnosticOperation(log, {
      operation: 'connectivity-check',
      now: diagnostics.now
    })
    try {
      const reachable = await owner.checkConnectivity()
      operation.complete({ reachable })
      return reachable
    } catch (error) {
      operation.fail(error)
      throw error
    }
  })
  return owner
}

export type { NetworkCommandOwner }
export { registerNetworkIpcHandlers, createNetworkCommandOwner }
