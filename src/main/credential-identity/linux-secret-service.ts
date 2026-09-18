import { spawnSync } from 'node:child_process'
import { CredentialIdentityError, type IdentityProbeResult } from './selection'

// Electron 39 passes app.getName() as libsecret's exact `application` attribute. Keep main's
// technical name, independent of display branding. No macOS-style new/old name search is used.
// Only this backend currently has a non-mutating metadata adapter. Do not force Electron to select
// it: an explicit password-store or the desktop's automatic choice remains authoritative.
export const assertLinuxSecretServiceConfiguration = (passwordStore = ''): void => {
  if (passwordStore === 'gnome-libsecret') return
  if (passwordStore) throw new CredentialIdentityError(`linux-backend-unsupported:${passwordStore}`)
  const desktops = (process.env.XDG_CURRENT_DESKTOP ?? '').split(':').map((name) => name.trim())
  const supported = new Set([
    'GNOME',
    'Unity',
    'X-Cinnamon',
    'Deepin',
    'Pantheon',
    'UKUI',
    'XFCE',
    'COSMIC'
  ])
  for (const desktop of desktops) {
    if (desktop === 'KDE' || desktop === 'LXQt')
      throw new CredentialIdentityError(`linux-backend-unsupported:${desktop}`)
    if (supported.has(desktop)) return
  }
  // Match Chromium's ordered DESKTOP_SESSION checks before its legacy presence-only signals.
  const session = process.env.DESKTOP_SESSION ?? ''
  if (['deepin', 'gnome', 'mate', 'ukui', 'xubuntu'].includes(session) || session.includes('xfce'))
    return
  if (['kde4', 'kde-plasma', 'kde'].includes(session))
    throw new CredentialIdentityError('linux-backend-unsupported:KWallet')
  if (process.env.GNOME_DESKTOP_SESSION_ID !== undefined) return
  if (process.env.KDE_FULL_SESSION !== undefined)
    throw new CredentialIdentityError('linux-backend-unsupported:KWallet')
  throw new CredentialIdentityError('linux-backend-unsupported:desktop-selection')
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
  const result = spawnSync(
    '/usr/bin/busctl',
    [
      '--user',
      '--json=short',
      '--timeout=5s',
      '--allow-interactive-authorization=no',
      'call',
      service,
      path,
      iface,
      method,
      signature,
      ...args
    ],
    { encoding: 'utf8', timeout: 6_000, maxBuffer: 16_384, stdio: ['ignore', 'pipe', 'ignore'] }
  )
  if (result.error || result.status !== 0 || result.signal) throw new Error('metadata-unavailable')
  const value: unknown = JSON.parse(result.stdout)
  if (!value || typeof value !== 'object') throw new Error('invalid-response')
  const response = value as { type?: unknown; data?: unknown }
  const expected = method === 'SearchItems' ? 'aoao' : method === 'ReadAlias' ? 'o' : 'v'
  if (response.type !== expected || !Array.isArray(response.data))
    throw new Error('invalid-response')
  return response.data
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
