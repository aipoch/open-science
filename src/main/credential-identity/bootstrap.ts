import { validateWindowsProfileKey } from './windows-profile-key'
import type { SecureStorageCipher } from '../secure-storage'
import { readCredentialCiphertexts, verifyCredentialCiphertexts } from './ciphertext-inventory'
import { installCredentialAccess, credentialCipher } from './runtime'
import { probeCredentialIdentity } from './probe'
import {
  CredentialIdentityError,
  selectCredentialIdentity,
  type CredentialIdentity
} from './selection'

export const selectStartupCredentialIdentity = (
  options: Omit<Parameters<typeof selectCredentialIdentity>[0], 'probe'>
): CredentialIdentity => selectCredentialIdentity({ ...options, probe: probeCredentialIdentity })

// The entire inventory is read before Electron can initialize a profile or create a missing key.
export const prepareCredentialValidation = (
  identity: CredentialIdentity,
  paths: { configRoot: string; profilePath: string }
): ((cipher: SecureStorageCipher, recover: (error: CredentialIdentityError) => void) => void) => {
  const ciphertexts = identity.backend === 'file' ? [] : readCredentialCiphertexts(paths)
  if (identity.backend === 'windows-dpapi')
    validateWindowsProfileKey({
      profilePath: paths.profilePath,
      hasCiphertexts: ciphertexts.length > 0
    })
  if (identity.backend === 'mac-keychain' && !identity.exists && ciphertexts.length)
    throw new CredentialIdentityError('key-missing-for-existing-ciphertext')
  return (cipher, recover) => {
    installCredentialAccess({ identity, cipher, probe: probeCredentialIdentity, recover })
    verifyCredentialCiphertexts(ciphertexts, (value) =>
      credentialCipher(cipher).decryptString(value)
    )
  }
}
