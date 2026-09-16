export type IdentityProbeResult = Readonly<{
  status: 'exists' | 'not-found' | 'access-blocked' | 'error' | 'unsupported'
  reason?: string
}>

export type CredentialIdentity = Readonly<
  | { backend: 'mac-keychain'; appName: string; exists: boolean }
  | { backend: 'windows-dpapi' | 'file'; appName: string }
>

export class CredentialIdentityError extends Error {
  constructor(readonly reason: string) {
    // Native startup recovery translates this stable message before displaying it.
    super(
      'Credential storage needs recovery. Existing credentials and profile data have been preserved.'
    )
    this.name = 'CredentialIdentityError'
  }
}

// This function has no cache, storage, secret access, or creation capability. Each process starts
// with the new identity; only an authoritative absence permits the next metadata query.
export const selectCredentialIdentity = (options: {
  platform: NodeJS.Platform
  packaged: boolean
  credentialStore?: 'os' | 'file'
  probe: (appName: string) => IdentityProbeResult
}): CredentialIdentity => {
  const suffix = options.packaged ? '' : ' (DEV)'
  const current = `Open-Science${suffix}`
  const legacy = `Open Science${suffix}`
  if (options.platform === 'win32') {
    // Windows OSCrypt belongs to Local State + the DPAPI user context, not an app-name item.
    return Object.freeze({ backend: 'windows-dpapi', appName: current })
  }
  if (options.platform === 'linux' && options.credentialStore === 'file') {
    return Object.freeze({ backend: 'file', appName: current })
  }
  if (options.platform !== 'darwin') throw new CredentialIdentityError('unsupported-backend')

  for (const appName of [current, legacy]) {
    let result: IdentityProbeResult
    try {
      result = options.probe(appName)
    } catch {
      throw new CredentialIdentityError('probe-error')
    }
    if (result.status === 'exists')
      return Object.freeze({ backend: 'mac-keychain', appName, exists: true })
    if (result.status !== 'not-found') throw new CredentialIdentityError(`probe-${result.status}`)
  }
  return Object.freeze({ backend: 'mac-keychain', appName: current, exists: false })
}
