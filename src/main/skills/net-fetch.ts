import type { FetchLike } from './github-import'
import { runtimeNetwork } from '../runtime-network'

export const netFetch: FetchLike = (url, init) =>
  runtimeNetwork().fetch(url, init) as unknown as ReturnType<FetchLike>
export const netFetchStandard: typeof fetch = (input, init) => runtimeNetwork().fetch(input, init)
export const netFetchWithManualRedirect: typeof fetch = (input, init) =>
  runtimeNetwork().fetchWithManualRedirect(input, init)
