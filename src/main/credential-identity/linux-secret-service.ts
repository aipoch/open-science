import { callLinuxCredentialMetadata } from './linux-dbus'
import type { IdentityProbeResult } from './selection'

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
    )
      return { status: 'error' }
    const [unlocked, locked] = result as string[][]
    if (locked.length) return { status: 'access-blocked' }
    if (unlocked.length > 1) return { status: 'error' }
    const alias = call(servicePath, serviceInterface, 'ReadAlias', 's', ['default'])
    if (alias.length !== 1 || !objectPath(alias[0])) return { status: 'access-blocked' }
    const property = call(alias[0], 'org.freedesktop.DBus.Properties', 'Get', 'ss', [
      'org.freedesktop.Secret.Collection',
      'Locked'
    ])
    const lockedValue = property[0] as { type?: unknown; data?: unknown } | undefined
    if (property.length !== 1 || lockedValue?.type !== 'b' || typeof lockedValue.data !== 'boolean')
      return { status: 'error' }
    return {
      status: lockedValue.data ? 'access-blocked' : unlocked.length ? 'exists' : 'not-found'
    }
  } catch {
    return { status: 'error', reason: 'linux-secret-service-metadata-unavailable' }
  }
}
