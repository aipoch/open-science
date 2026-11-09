import { CREDENTIAL_INVENTORY_MAX_AGE_MS } from './inventory-handoff'

export type CredentialInventoryLaunchOptions = {
  credentialInventory?: readonly Buffer[]
  credentialInventoryCapturedAt?: number
}

/** Reuse the pre-Chromium inventory only while it is still a bounded startup snapshot. */
export function recoveryCredentialInventoryOptions(
  ciphertexts: readonly Buffer[] | undefined,
  capturedAt: number | undefined,
  now = Date.now()
): CredentialInventoryLaunchOptions {
  if (
    !ciphertexts ||
    capturedAt === undefined ||
    now < capturedAt ||
    now - capturedAt > CREDENTIAL_INVENTORY_MAX_AGE_MS
  )
    return {}
  return {
    credentialInventory: ciphertexts,
    credentialInventoryCapturedAt: capturedAt
  }
}
