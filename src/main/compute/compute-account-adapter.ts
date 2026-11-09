export type HfMaterial = { accessToken: string; refreshToken?: string; expiresAt?: number }
export type ModalMaterial = { tokenId: string; tokenSecret: string }
export type AccountMaterial = HfMaterial | ModalMaterial
export type AccountAuthReason =
  'authorization' | 'missing' | 'dependency' | 'network' | 'timeout' | 'storage' | 'cancelled'
export class AccountAuthError extends Error {
  constructor(readonly reason: AccountAuthReason) {
    super('Compute account: ' + reason)
  }
}
export type AccountChallenge = (
  url: string,
  userCode: string | undefined,
  expiresAt: number
) => Promise<void>
export interface ComputeAccountAdapter {
  probe(material: AccountMaterial | undefined, signal: AbortSignal): Promise<string>
  authorize(challenge: AccountChallenge, signal: AbortSignal): Promise<AccountMaterial>
}
