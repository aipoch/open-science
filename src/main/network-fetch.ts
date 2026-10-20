import { runtimeNetwork } from './runtime-network'

export const netFetch: typeof fetch = (input, init) => runtimeNetwork().fetch(input as string, init)
export const netFetchStandard: typeof fetch = (input, init) => runtimeNetwork().fetch(input, init)
export const netFetchWithManualRedirect: typeof fetch = (input, init) =>
  runtimeNetwork().fetchWithManualRedirect(input, init)
