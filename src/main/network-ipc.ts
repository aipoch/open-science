import { ipcMainHandle } from './ipc-handler-registry'

import { getNetworkInfo } from './net/network-info'

import type { NetworkInfo } from '../shared/network'

type NetworkCommandOwner = Readonly<{ getInfo: () => Promise<NetworkInfo> }>

// Local network interface snapshot for the settings Network panel. Best-effort: the OS
// answers from local state, so no internet access is required and failures are unlikely.
const createNetworkCommandOwner = (): NetworkCommandOwner => ({
  getInfo: () => getNetworkInfo()
})

const registerNetworkIpcHandlers = (
  owner: NetworkCommandOwner = createNetworkCommandOwner()
): NetworkCommandOwner => {
  ipcMainHandle('network:get-info', () => owner.getInfo())
  return owner
}

export type { NetworkCommandOwner }
export { registerNetworkIpcHandlers, createNetworkCommandOwner }
