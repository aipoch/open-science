import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  acquireCredentialBootstrapLease,
  acquireRuntimeDirectorySync,
  type RuntimeDirectoryLease
} from '../runtime-ownership'
import { resolveBootstrapConfigRoot } from '../storage/config-root'
import { resolveElectronProfile } from '../storage/electron-profile'
import {
  readConfigurationCredentialCiphertexts,
  readCredentialCiphertexts,
  verifyCredentialCiphertexts
} from './ciphertext-inventory'
import { CredentialIdentityError } from './identity-contract'
import { createNodeSecureStorageCipher } from './node-cipher'
import { validateWindowsProfileKey } from './windows-profile-key'

export type DefaultCliProfileOptions = {
  home: string
  configRoot: string
  profilePath: string
  packaged: boolean
  // Pass getCredentialStore() after configureCredentialStore(), not a raw CLI flag.
  credentialStore: 'os' | 'file'
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  argv?: readonly string[]
  startupAttemptId?: string
}

export type DefaultCliProfileSelection = {
  profilePath: string
  // On fallback retain shared configuration and selected-profile evidence, then re-read the
  // selected inventory under final locks before prepareCredentialValidation.
  validationCiphertexts?: readonly Buffer[]
}

const mayTryLegacyKey = (error: unknown): boolean =>
  error instanceof CredentialIdentityError &&
  (error.reason === 'decryption-failed' ||
    (error.reason === 'windows-profile-key-unavailable' &&
      (error.diagnostic?.code === 'profile-key-missing' ||
        (error.diagnostic?.code === 'profile-read-failed' &&
          error.diagnostic.systemCode === 'ENOENT'))))

// Node-only, read-only candidate selection. The caller already owns configRoot. Candidate leases
// are temporary: final ownership, fresh inventory validation, key initialization and the sole
// global credential-access installation stay in node-entry, after this function returns.
export function selectDefaultCliCredentialProfile(
  options: DefaultCliProfileOptions
): DefaultCliProfileSelection {
  const unchanged = { profilePath: options.profilePath }
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  if (
    platform !== 'win32' ||
    options.credentialStore !== 'os' ||
    (options.argv ?? process.argv).includes('--desktop') ||
    options.startupAttemptId ||
    [
      'OPEN_SCIENCE_USER_DATA',
      'OPEN_SCIENCE_CONFIG_ROOT',
      'OPEN_SCIENCE_STORAGE_ROOT',
      'OPEN_SCIENCE_E2E_STORAGE_ROOT',
      'OPEN_SCIENCE_STARTUP_ATTEMPT',
      'OPEN_SCIENCE_CREDENTIAL_INVENTORY_PATH',
      'OPEN_SCIENCE_CREDENTIAL_INVENTORY_SHA256'
    ].some((key) => env[key]?.trim()) ||
    options.configRoot !== resolveBootstrapConfigRoot(options.home, options.packaged, {})
  )
    return unchanged

  const configurationCiphertexts = readConfigurationCredentialCiphertexts(options.configRoot)
  // A stale CLI directory or unrelated browser cookies cannot establish a shared key binding.
  if (!configurationCiphertexts.length) return unchanged
  const validateCandidate = (profilePath: string, required?: readonly Buffer[]): Buffer[] => {
    // Retain the resolver's existing validation for dangling profile links and non-directories.
    resolveElectronProfile({
      appData: options.home,
      configRoot: options.configRoot,
      packaged: options.packaged,
      env: { OPEN_SCIENCE_USER_DATA: profilePath }
    })
    const bootstrapLease = acquireCredentialBootstrapLease({
      home: options.home,
      profilePath,
      platform
    })
    let runtimeLease: RuntimeDirectoryLease | undefined
    try {
      // A profile symlink may point at the config root that the caller already owns.
      if (
        realpathSync(profilePath).toLowerCase() !== realpathSync(options.configRoot).toLowerCase()
      )
        runtimeLease = acquireRuntimeDirectorySync(profilePath)
      const inventory = readCredentialCiphertexts({ configRoot: options.configRoot, profilePath })
      const ciphertexts = required ? [...required, ...inventory] : inventory
      validateWindowsProfileKey({ profilePath, hasCiphertexts: ciphertexts.length > 0 })
      if (ciphertexts.length) {
        const cipher = createNodeSecureStorageCipher(
          { backend: 'windows-dpapi', appName: `Open-Science${options.packaged ? '' : ' (DEV)'}` },
          profilePath
        )
        try {
          verifyCredentialCiphertexts(ciphertexts, (value) => cipher.decryptString(value))
        } finally {
          cipher.dispose()
        }
      }
      return ciphertexts
    } finally {
      try {
        runtimeLease?.release()
      } finally {
        bootstrapLease.release()
      }
    }
  }
  try {
    validateCandidate(options.profilePath)
    return unchanged
  } catch (error) {
    if (!mayTryLegacyKey(error)) throw error
    const profilePath = join(options.configRoot, 'electron-profile')
    return {
      profilePath,
      validationCiphertexts: validateCandidate(profilePath, configurationCiphertexts)
    }
  }
}
