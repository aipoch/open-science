import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import type { IdentityProbeResult } from './selection'
import { createLogger } from '../logger'

const log = createLogger('credential-identity')

// Only fixed probe reason codes may reach logs; never forward arbitrary helper output.
const nativeProbeReasons = new Set([
  'probe-exception',
  'interaction-state-unavailable',
  'interaction-disable-failed',
  'interaction-disable-unverified',
  'interaction-restore-failed',
  'keychain-search-list-empty',
  'keychain-search-list-too-large',
  'keychain-search-list-unavailable',
  'invalid-keychain-search-list',
  'keychain-status-unavailable',
  'keychain-locked',
  'keychain-search-list-changed',
  'keychain-state-changed',
  'keychain-search-incomplete',
  'invalid-item-reference',
  'item-keychain-unavailable',
  'item-keychain-outside-search-list',
  'keychain-unreadable',
  'query-allocation-failed',
  'account-not-found',
  'metadata-query-failed',
  'invalid-metadata-result',
  'ambiguous-account',
  'unexpected-secret-result',
  'account-metadata-found',
  'invalid-identity',
  'platform-backend-unsupported'
])

// Selection can also receive an injected probe; enforce the same diagnostic boundary there.
export const safeCredentialProbeResult = (result: IdentityProbeResult): IdentityProbeResult => ({
  status: result.status,
  ...(typeof result.reason === 'string' && nativeProbeReasons.has(result.reason)
    ? { reason: result.reason }
    : {}),
  ...(typeof result.osStatus === 'number' &&
  Number.isInteger(result.osStatus) &&
  result.osStatus >= -2147483648 &&
  result.osStatus <= 2147483647
    ? { osStatus: result.osStatus }
    : {})
})

// The executable isolates Security.framework's process-wide UI switch from Electron threads.
// No secret is passed in argv or returned. Unknown output, timeout, and a missing helper fail closed.
const runCredentialIdentityProbe = (appName: string): IdentityProbeResult => {
  if (process.platform !== 'darwin' || process.mas) return { status: 'unsupported' }
  try {
    const { executablePath } = createRequire(import.meta.url)(
      '@aipoch/credential-identity-probe-native'
    ) as { executablePath: string }
    const executable = executablePath.replace(/app\.asar([/\\])/u, 'app.asar.unpacked$1')
    const result = spawnSync(executable, [appName], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 4096,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    if (result.error || result.status !== 0 || result.signal) return { status: 'error' }
    const value: unknown = JSON.parse(result.stdout)
    if (!value || typeof value !== 'object') return { status: 'error' }
    const output = value as Record<string, unknown>
    if (output.schemaVersion !== 1 || output.platform !== 'darwin' || output.identity !== appName)
      return { status: 'error' }
    if (
      !['exists', 'not-found', 'access-blocked', 'error', 'unsupported'].includes(
        String(output.status)
      )
    )
      return { status: 'error' }
    return safeCredentialProbeResult(output as IdentityProbeResult)
  } catch {
    return { status: 'error' }
  }
}

// Record only query identities and the validated result, including during later access rechecks.
// Never log raw stdout/stderr, native exceptions, returned attributes, or password data.
export const probeCredentialIdentity = (appName: string): IdentityProbeResult => {
  log.info('identity probe started', {
    appName,
    service: `${appName} Safe Storage`,
    accountOrder: [`${appName} Key`, appName]
  })
  const result = runCredentialIdentityProbe(appName)
  log.info('identity probe completed', { appName, ...result })
  return result
}
