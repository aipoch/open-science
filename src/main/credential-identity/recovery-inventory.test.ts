import { describe, expect, it } from 'vitest'
import { CREDENTIAL_INVENTORY_MAX_AGE_MS } from './inventory-handoff'
import { recoveryCredentialInventoryOptions } from './recovery-inventory'

describe('recovery credential inventory handoff', () => {
  it('reuses a fresh pre-Chromium snapshot for backend recovery', () => {
    const ciphertexts = [Buffer.from('ciphertext')]
    expect(recoveryCredentialInventoryOptions(ciphertexts, 10_000, 10_000)).toEqual({
      credentialInventory: ciphertexts,
      credentialInventoryCapturedAt: 10_000
    })
  })

  it('does not reuse an expired snapshot', () => {
    expect(
      recoveryCredentialInventoryOptions(
        [Buffer.from('ciphertext')],
        10_000,
        10_000 + CREDENTIAL_INVENTORY_MAX_AGE_MS + 1
      )
    ).toEqual({})
  })
})
