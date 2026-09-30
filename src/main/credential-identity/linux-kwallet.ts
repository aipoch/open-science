import type { LinuxKWalletBackend } from './linux-backend'
import { callLinuxCredentialMetadata } from './linux-dbus'
import type { IdentityProbeResult } from './selection'

export type KWalletProbeResult = IdentityProbeResult & Readonly<{ wallet?: string }>

// Electron's sync OSCrypt uses Chromium's fixed folder/key, with app.getName() only as
// the authorization identity. This is deliberately not the libsecret application attribute.
// Contract: Electron 43.7.5 revert_oscrypt_remove_sync_backend.patch and org.kde.KWallet.
export const probeLinuxKWalletIdentity = (
  backend: LinuxKWalletBackend,
  expectedWallet?: string
): KWalletProbeResult => {
  const daemon = backend === 'kwallet' ? 'kwalletd' : `kwalletd${backend.slice(-1)}`
  const call = (method: string, signature: string, args: string[], type: string): unknown => {
    const result = callLinuxCredentialMetadata(
      `org.kde.${daemon}`,
      `/modules/${daemon}`,
      'org.kde.KWallet',
      method,
      signature,
      args,
      type
    )
    if (result.length !== 1 || typeof result[0] !== (type === 'b' ? 'boolean' : 'string'))
      throw new Error('invalid-response')
    return result[0]
  }
  try {
    if (!call('isEnabled', '', [], 'b')) return { status: 'access-blocked' }
    const wallet = call('networkWallet', '', [], 's') as string
    if (!wallet || wallet.length > 1024) return { status: 'error' }
    if (expectedWallet !== undefined && wallet !== expectedWallet)
      return { status: 'error', reason: 'linux-kwallet-default-wallet-changed' }
    // keyDoesNotExist can use an on-disk hash index even when locked. Require an open wallet
    // first: absence from a locked/unavailable store is not permission to create a key.
    if (!call('isOpen', 's', [wallet], 'b')) return { status: 'access-blocked' }
    const absent = call(
      'keyDoesNotExist',
      'sss',
      [wallet, 'Chromium Keys', 'Chromium Safe Storage'],
      'b'
    )
    if (!call('isOpen', 's', [wallet], 'b') || call('networkWallet', '', [], 's') !== wallet)
      return { status: 'error', reason: 'linux-kwallet-state-changed' }
    return { status: absent ? 'not-found' : 'exists', wallet }
  } catch {
    return { status: 'error', reason: 'linux-kwallet-metadata-unavailable' }
  }
}
