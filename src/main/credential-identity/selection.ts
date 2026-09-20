import { createLogger } from '../logger'
import { safeCredentialProbeResult } from './probe'

const log = createLogger('credential-identity')

export type IdentityProbeResult = Readonly<{
  status: 'exists' | 'not-found' | 'access-blocked' | 'error' | 'unsupported'
  reason?: string
  osStatus?: number
}>

export type CredentialIdentity = Readonly<
  | { backend: 'mac-keychain' | 'linux-secret-service'; appName: string; exists: boolean }
  | { backend: 'windows-dpapi' | 'file'; appName: string }
>

export class CredentialIdentityError extends Error {
  constructor(
    readonly reason: string,
    readonly probe?: IdentityProbeResult & Readonly<{ appName: string }>
  ) {
    // Native startup recovery translates this stable message before displaying it.
    super(
      'Credential storage needs recovery. Existing credentials and profile data have been preserved.'
    )
    this.name = 'CredentialIdentityError'
  }
}

// Selection never reads or creates a secret. macOS prefers the first confirmed identity;
// unconfirmed selection is not permission to create a key. Linux retains its own policy.
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

  const probes: Array<IdentityProbeResult & { order: number; appName: string }> = []
  const select = (appName: string, exists: boolean, reason: string): CredentialIdentity => {
    log.info('identity selection completed', {
      outcome: 'selected',
      appName,
      exists,
      reason,
      probes,
      ...(probes.length === 1
        ? {
            skippedProbe: { appName: legacy, reason: 'preferred-identity-present' }
          }
        : {})
    })
    return Object.freeze({ backend: 'mac-keychain', appName, exists })
  }
  for (const appName of [current, legacy]) {
    let result: IdentityProbeResult
    try {
      result = safeCredentialProbeResult(options.probe(appName))
    } catch {
      // Keep a fixed diagnostic code, never the thrown value or arbitrary error message.
      result = { status: 'error', reason: 'probe-exception' }
    }
    probes.push({ order: probes.length + 1, appName, ...result })
    if (result.status === 'exists')
      return select(
        appName,
        true,
        appName === current ? 'preferred-identity-present' : 'legacy-identity-present'
      )
  }
  // False means unconfirmed, not authoritative absence. Inventory and access guards still apply.
  return select(current, false, 'no-identity-confirmed')
}
