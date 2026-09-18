import type { SecureStorageCipher } from '../secure-storage'
import { createCredentialAccess, type CredentialAccess } from './access'

let access: CredentialAccess | undefined

// Installed exactly once by the UI bootstrap, before the settings/compute graph is imported.
// Non-UI consumers and injected unit-test ciphers do not install an Electron process owner.
export const installCredentialAccess = (
  options: Parameters<typeof createCredentialAccess>[0]
): void => {
  if (access) throw new Error('Credential identity is already selected for this process.')
  access = createCredentialAccess(options)
}

export const credentialCipher = (fallback: SecureStorageCipher): SecureStorageCipher =>
  access ?? fallback

// Persistence guards never touch the OS backend. They only reject a latched recovery state.
export const assertCredentialAccessAllowed = (): void => access?.assertAccessAllowed()
export const assertCredentialReadAllowed = (): void => access?.assertReadAllowed()

export const credentialAccessInstalled = (): boolean => access !== undefined
