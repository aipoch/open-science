import { ipcMainHandle } from './ipc-handler-registry'

import { checkInternetReachability, getNetworkInfo } from './net/network-info'

import type { NetworkInfo } from '../shared/network'

type NetworkCommandOwner = Readonly<{
  getInfo: () => Promise<NetworkInfo>
  checkConnectivity: () => Promise<boolean>
}>

// Network status for the settings Network panel. getInfo answers from local OS state (no
// internet required); checkConnectivity is a real end-to-end HTTPS probe reused from the
// onboarding environment check, so it can tell "internet broken" apart from "link is up".
const createNetworkCommandOwner = (): NetworkCommandOwner => ({
  getInfo: getNetworkInfo,
  checkConnectivity: checkInternetReachability
})

const registerNetworkIpcHandlers = (
  owner: NetworkCommandOwner = createNetworkCommandOwner()
): NetworkCommandOwner => {
  ipcMainHandle('network:get-info', () => owner.getInfo())
  ipcMainHandle('network:check-connectivity', () => owner.checkConnectivity())
  return owner
}

export type { NetworkCommandOwner }
export { registerNetworkIpcHandlers, createNetworkCommandOwner }
