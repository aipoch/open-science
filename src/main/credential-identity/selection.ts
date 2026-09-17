export type IdentityProbeResult = Readonly<{
  status: 'exists' | 'not-found' | 'access-blocked' | 'error' | 'unsupported'
  reason?: string
}>

export type CredentialIdentity = Readonly<
  | { backend: 'mac-keychain' | 'linux-secret-service'; appName: string; exists: boolean }
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

// This function has no cache, storage, secret access, or creation capability. macOS probes the new
// identity first; Linux keeps its stable technical identity without a name fallback.
export const selectCredentialIdentity = (options: {
  platform: NodeJS.Platform
  packaged: boolean
  credentialStore?: 'os' | 'file'
  probe: (appName: string) => IdentityProbeResult
  linuxProbe?: (appName: string) => IdentityProbeResult
  linuxPasswordStore?: string
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
  if (options.platform === 'linux') {
    const result = options.linuxProbe?.(legacy)
    if (!result || !['exists', 'not-found'].includes(result.status))
      throw new CredentialIdentityError(
        result?.reason ?? `linux-secret-service-probe-${result?.status ?? 'unsupported'}`
      )
    return Object.freeze({
      backend: 'linux-secret-service',
      appName: legacy,
      exists: result.status === 'exists'
    })
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
