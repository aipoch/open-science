import { probeLinuxCredentialIdentity } from './linux-secret-service'
import { selectLinuxCredentialBackend } from './linux-backend'
import { probeLinuxKWalletIdentity } from './linux-kwallet'
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
  options: Omit<
    Parameters<typeof selectCredentialIdentity>[0],
    'probe' | 'linuxProbe' | 'linuxBackend'
  >
): CredentialIdentity => {
  const linuxBackend =
    options.platform === 'linux' && options.credentialStore !== 'file'
      ? selectLinuxCredentialBackend(options.linuxPasswordStore)
      : undefined
  return selectCredentialIdentity({
    ...options,
    probe: probeCredentialIdentity,
    linuxBackend,
    linuxProbe:
      linuxBackend && linuxBackend !== 'gnome_libsecret'
        ? () => probeLinuxKWalletIdentity(linuxBackend)
        : probeLinuxCredentialIdentity
  })
}

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
  if ('exists' in identity && !identity.exists && ciphertexts.length)
    throw new CredentialIdentityError('key-missing-for-existing-ciphertext')
  if (identity.backend === 'mac-keychain' && !identity.exists) {
    // Electron's native network service can use OSCrypt without going through the JS cipher.
    // Before the first await/profile write, unconfirmed selection needs metadata evidence that
    // the selected key either exists or is definitely absent. This never calls safeStorage.
    const result = probeCredentialIdentity(identity.appName)
    if (result.status !== 'exists' && result.status !== 'not-found')
      throw new CredentialIdentityError(`initialization-probe-${result.status}`, {
        appName: identity.appName,
        ...result
      })
  }
  return (cipher, recover) => {
    installCredentialAccess({
      identity,
      cipher,
      probe:
        identity.backend === 'linux-kwallet'
          ? () => probeLinuxKWalletIdentity(identity.passwordStore, identity.wallet)
          : identity.backend === 'linux-secret-service'
            ? probeLinuxCredentialIdentity
            : probeCredentialIdentity,
      recover
    })
    if (identity.backend === 'linux-secret-service' || identity.backend === 'linux-kwallet')
      credentialCipher(cipher).isEncryptionAvailable()
    verifyCredentialCiphertexts(ciphertexts, credentialCipher(cipher))
  }
}
