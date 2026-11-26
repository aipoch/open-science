import { createLogger } from '@aipoch/diagnostics/node'
import { callLinuxCredentialMetadata, LinuxMetadataCallError } from './linux-dbus'
import type { IdentityProbeResult } from './probe-contract'

const log = createLogger('credential-identity')
const reportFailure = (method: string, category: string, exitCode?: number): void => {
  log.warn('Secret Service metadata probe failed', { method, category, exitCode })
}

const service = 'org.freedesktop.secrets'
const servicePath = '/org/freedesktop/secrets'
const serviceInterface = 'org.freedesktop.Secret.Service'
const objectPath = (value: unknown): value is string =>
  typeof value === 'string' && /^\/(?:[A-Za-z0-9_]+\/)*[A-Za-z0-9_]+$/.test(value)

const call = (
  path: string,
  iface: string,
  method: string,
  signature: string,
  args: string[]
): unknown[] => {
  return callLinuxCredentialMetadata(
    service,
    path,
    iface,
    method,
    signature,
    args,
    method === 'SearchItems' ? 'aoao' : method === 'ReadAlias' ? 'o' : 'v'
  )
}

// SearchItems returns locked/unlocked paths without requesting secrets. ReadAlias/Locked verify
// an available, unlocked default collection: libsecret initializes it even for an existing key.
// Never invoke Unlock, OpenSession, GetSecrets, CreateItem or any write from this metadata probe.
export const probeLinuxCredentialIdentity = (appName: string): IdentityProbeResult => {
  try {
    const result = call(servicePath, serviceInterface, 'SearchItems', 'a{ss}', [
      '1',
      'application',
      appName
    ])
    if (
      result.length !== 2 ||
      !result.every((list) => Array.isArray(list) && list.every(objectPath))
    ) {
      reportFailure('SearchItems', 'invalid-response')
      return { status: 'error' }
    }
    const [unlocked, locked] = result as string[][]
    if (locked.length) {
      reportFailure('SearchItems', 'locked-items')
      return { status: 'access-blocked' }
    }
    if (unlocked.length > 1) {
      reportFailure('SearchItems', 'multiple-unlocked-items')
      return { status: 'error' }
    }
    const alias = call(servicePath, serviceInterface, 'ReadAlias', 's', ['default'])
    if (alias.length !== 1 || !objectPath(alias[0])) {
      reportFailure('ReadAlias', 'default-collection-unavailable')
      return { status: 'access-blocked' }
    }
    const property = call(alias[0], 'org.freedesktop.DBus.Properties', 'Get', 'ss', [
      'org.freedesktop.Secret.Collection',
      'Locked'
    ])
    const lockedValue = property[0] as { type?: unknown; data?: unknown } | undefined
    if (
      property.length !== 1 ||
      lockedValue?.type !== 'b' ||
      typeof lockedValue.data !== 'boolean'
    ) {
      reportFailure('Get', 'invalid-response')
      return { status: 'error' }
    }
    if (lockedValue.data) {
      reportFailure('Get', 'collection-locked')
      return { status: 'access-blocked' }
    }
    return { status: unlocked.length ? 'exists' : 'not-found' }
  } catch (error) {
    if (error instanceof LinuxMetadataCallError)
      reportFailure(error.method, error.message, error.exitCode)
    return { status: 'error', reason: 'linux-secret-service-metadata-unavailable' }
  }
}
