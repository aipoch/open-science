import type { IdentityProbeResult } from './probe-contract'

export type KWalletProbeResult = IdentityProbeResult & Readonly<{ wallet?: string }>
