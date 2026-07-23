import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, win32 } from 'node:path'

import { DEFAULT_MAX_CACHE_RELATIVE_PATH as MANIFEST_DEFAULT_MAX_CACHE_RELATIVE_PATH } from './bundle-manifest'

export const WINDOWS_MAX_USABLE_PATH = 259
export const DEFAULT_MAX_CACHE_RELATIVE_PATH = MANIFEST_DEFAULT_MAX_CACHE_RELATIVE_PATH

export type MicromambaCache = {
  path: string
  lockKey: string
}

type CacheOwnership = {
  canonicalRoot: string
  userIdentity: string
  profileBoundary?: string
  platform: NodeJS.Platform
}

export type MicromambaCacheDeps = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  canonicalize?: (path: string) => string
  prepare?: (path: string, ownership: CacheOwnership) => string | undefined
  verifyOwnership?: (path: string, userIdentity: string) => boolean
}

type CacheMarker = { schema?: number; canonicalRoot?: string; userIdentity?: string }

export type MicromambaCacheCleanupDeps = Pick<
  MicromambaCacheDeps,
  'platform' | 'env' | 'canonicalize' | 'verifyOwnership'
> & {
  inspect?: (path: string) => { directory: boolean; symbolicLink: boolean; marker: CacheMarker }
  remove?: (path: string) => void
}

const windowsKey = (path: string): string => win32.normalize(path).toLowerCase()

const isInside = (parent: string, child: string): boolean => {
  const relative = win32.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !win32.isAbsolute(relative))
}

const canonicalizeExisting = (path: string): string => {
  let current = resolve(path)
  const missing: string[] = []
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing)
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      missing.unshift(basename(current))
      current = parent
    }
  }
}

export const micromambaCacheLockKey = (
  path: string,
  deps: Pick<MicromambaCacheDeps, 'platform' | 'canonicalize'> = {}
): string => {
  const physical = (deps.canonicalize ?? canonicalizeExisting)(path)
  return (deps.platform ?? process.platform) === 'win32' ? windowsKey(physical) : physical
}

const powershellLiteral = (value: string): string => value.replaceAll("'", "''")

export type WindowsCacheAcl = {
  OwnerSid?: string
  CurrentSid?: string
  Rules?: Array<{ Sid?: string; Rights?: string; Type?: string }>
}

// Keep this complete dangerous-rights set in sync with windows-runtime-cache-uninstall.ps1.
// A foreign principal that can write, delete, change permissions, or take ownership can replace
// the cache contents or grant itself full control.
export const WINDOWS_CACHE_DANGEROUS_RIGHT_NAMES = [
  'Write',
  'Modify',
  'FullControl',
  'CreateFiles',
  'AppendData',
  'Delete',
  'DeleteSubdirectoriesAndFiles',
  'ChangePermissions',
  'TakeOwnership'
] as const

const dangerousWindowsCacheRight = new RegExp(WINDOWS_CACHE_DANGEROUS_RIGHT_NAMES.join('|'), 'i')

export const isTrustedWindowsCacheAcl = (acl: WindowsCacheAcl): boolean => {
  if (!acl.OwnerSid || acl.OwnerSid !== acl.CurrentSid) return false
  const trustedWriteSids = new Set([
    acl.CurrentSid,
    'S-1-5-18', // LocalSystem
    'S-1-5-32-544', // Builtin Administrators
    'S-1-3-0' // Creator Owner (applies to children created by the current user)
  ])
  return !(acl.Rules ?? []).some(
    (rule) =>
      rule.Type?.toLowerCase() === 'allow' &&
      !trustedWriteSids.has(rule.Sid ?? '') &&
      dangerousWindowsCacheRight.test(rule.Rights ?? '')
  )
}

// A marker proves only that the marker contents are self-consistent. On Windows, a cache outside
// the profile must also be owned by the current user and must not grant broad principals write
// access. PowerShell is part of every supported Windows installation; failures fail closed.
const defaultVerifyOwnership = (path: string, userIdentity: string): boolean => {
  void userIdentity
  if (process.platform !== 'win32') return true
  try {
    const literal = powershellLiteral(path)
    const script =
      `$acl=Get-Acl -LiteralPath '${literal}'; ` +
      `$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ` +
      `$owner=([System.Security.Principal.NTAccount]$acl.Owner).Translate(` +
      `[System.Security.Principal.SecurityIdentifier]).Value; ` +
      `$rules=$acl.Access | ForEach-Object { $sid=''; try { $sid=$_.IdentityReference.Translate(` +
      `[System.Security.Principal.SecurityIdentifier]).Value } catch {}; ` +
      `[pscustomobject]@{Sid=$sid; ` +
      `Rights=$_.FileSystemRights.ToString(); Type=$_.AccessControlType.ToString()} }; ` +
      `[pscustomobject]@{OwnerSid=$owner; CurrentSid=$current; Rules=$rules} | ` +
      'ConvertTo-Json -Compress -Depth 4'
    const raw = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        windowsHide: true
      }
    )
    const acl = JSON.parse(raw) as {
      OwnerSid?: string
      CurrentSid?: string
      Rules?:
        | { Sid?: string; Rights?: string; Type?: string }
        | Array<{ Sid?: string; Rights?: string; Type?: string }>
    }
    const rules = !acl.Rules ? [] : Array.isArray(acl.Rules) ? acl.Rules : [acl.Rules]
    return isTrustedWindowsCacheAcl({ ...acl, Rules: rules })
  } catch {
    return false
  }
}

const defaultPrepare = (
  path: string,
  ownership: CacheOwnership,
  verifyOwnership: (path: string, userIdentity: string) => boolean
): string | undefined => {
  let created = false
  try {
    try {
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
      mkdirSync(path, { mode: 0o700 })
      created = true
    }

    const markerPath = win32.join(path, '.open-science-cache.json')
    const expected = {
      schema: 1,
      canonicalRoot: windowsKey(ownership.canonicalRoot),
      userIdentity: ownership.userIdentity
    }
    if (created) {
      writeFileSync(markerPath, `${JSON.stringify(expected)}\n`, { encoding: 'utf8', mode: 0o600 })
    } else {
      const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as typeof expected
      if (
        marker.schema !== expected.schema ||
        marker.canonicalRoot !== expected.canonicalRoot ||
        marker.userIdentity !== expected.userIdentity
      ) {
        return undefined
      }
    }

    const physical = realpathSync.native(path)
    if (windowsKey(physical) !== windowsKey(path)) return undefined
    if (
      ownership.profileBoundary &&
      !isInside(realpathSync.native(ownership.profileBoundary), physical)
    ) {
      return undefined
    }
    if (!verifyOwnership(physical, ownership.userIdentity)) {
      throw new Error('Managed runtime cache ownership is not trusted.')
    }

    const probe = win32.join(physical, `.write-test-${randomUUID()}`)
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    return physical
  } catch {
    if (created) rmSync(path, { recursive: true, force: true })
    return undefined
  }
}

const fitsBudget = (cacheRoot: string, maxCacheRelativePath: number): boolean =>
  cacheRoot.length + maxCacheRelativePath <= WINDOWS_MAX_USABLE_PATH

const cacheIdentity = (
  root: string,
  env: NodeJS.ProcessEnv,
  canonicalize: (path: string) => string
): { canonicalRoot: string; userIdentity: string; leaf: string } => {
  const userIdentity = [env.USERDOMAIN, env.USERNAME].filter(Boolean).join('\\')
  if (!userIdentity) {
    throw new Error('Cannot determine the Windows user identity for the managed runtime cache.')
  }
  const canonicalRoot = win32.normalize(canonicalize(root))
  const hash = createHash('sha256')
    .update(`${userIdentity.toLowerCase()}\0${windowsKey(canonicalRoot)}`)
    .digest('hex')
    .slice(0, 10)
  return { canonicalRoot, userIdentity, leaf: `osp${hash}` }
}

const candidatePaths = (
  canonicalRoot: string,
  leaf: string,
  env: NodeJS.ProcessEnv,
  canonicalize: (path: string) => string
): Array<{ path: string; profileBoundary?: string }> => {
  const profile = env.USERPROFILE ? win32.normalize(canonicalize(env.USERPROFILE)) : undefined
  return [
    { path: win32.join(win32.parse(canonicalRoot).root, leaf) },
    ...(profile ? [{ path: win32.join(profile, leaf), profileBoundary: profile }] : [])
  ]
}

export const selectMicromambaCache = (
  root: string,
  maxCacheRelativePath = DEFAULT_MAX_CACHE_RELATIVE_PATH,
  deps: MicromambaCacheDeps = {}
): MicromambaCache => {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') {
    const path = join(root, 'pkgs')
    return { path, lockKey: path }
  }
  if (!Number.isSafeInteger(maxCacheRelativePath) || maxCacheRelativePath <= 0) {
    throw new Error('Managed runtime pack has an invalid Windows package-cache path budget.')
  }

  const env = deps.env ?? process.env
  const canonicalize = deps.canonicalize ?? canonicalizeExisting
  const { canonicalRoot, userIdentity, leaf } = cacheIdentity(root, env, canonicalize)
  const verifyOwnership = deps.verifyOwnership ?? defaultVerifyOwnership
  const prepare =
    deps.prepare ??
    ((path: string, ownership: CacheOwnership) => defaultPrepare(path, ownership, verifyOwnership))
  const candidates = candidatePaths(canonicalRoot, leaf, env, canonicalize)

  for (const candidate of candidates) {
    if (!fitsBudget(candidate.path, maxCacheRelativePath)) continue
    const physical = prepare(candidate.path, {
      canonicalRoot,
      userIdentity,
      profileBoundary: candidate.profileBoundary,
      platform
    })
    if (
      !physical ||
      !fitsBudget(physical, maxCacheRelativePath) ||
      (deps.prepare !== undefined && !verifyOwnership(physical, userIdentity))
    )
      continue
    return { path: physical, lockKey: micromambaCacheLockKey(physical, { platform, canonicalize }) }
  }

  throw new Error(
    'No trusted writable package cache fits the managed runtime path budget. ' +
      'Choose a shorter Windows user profile or data-root path.'
  )
}

// Removes only the app-owned cache for a previous runtime root. This is used after a successful data
// root migration because the physical cache intentionally lives outside the data tree. Marker and
// ownership checks are repeated here so a stale or tampered path is left untouched.
export const removeMicromambaCacheForRoot = (
  root: string,
  deps: MicromambaCacheCleanupDeps = {}
): void => {
  if ((deps.platform ?? process.platform) !== 'win32') return
  const env = deps.env ?? process.env
  const canonicalize = deps.canonicalize ?? canonicalizeExisting
  let identity: ReturnType<typeof cacheIdentity>
  try {
    identity = cacheIdentity(root, env, canonicalize)
  } catch {
    return
  }
  const verifyOwnership = deps.verifyOwnership ?? defaultVerifyOwnership
  const inspect =
    deps.inspect ??
    ((path: string): { directory: boolean; symbolicLink: boolean; marker: CacheMarker } => {
      const stat = lstatSync(path)
      return {
        directory: stat.isDirectory(),
        symbolicLink: stat.isSymbolicLink(),
        marker: JSON.parse(
          readFileSync(win32.join(path, '.open-science-cache.json'), 'utf8')
        ) as CacheMarker
      }
    })
  const remove =
    deps.remove ?? ((path: string): void => rmSync(path, { recursive: true, force: true }))
  for (const candidate of candidatePaths(
    identity.canonicalRoot,
    identity.leaf,
    env,
    canonicalize
  )) {
    try {
      const state = inspect(candidate.path)
      if (!state.directory || state.symbolicLink) continue
      const marker = state.marker
      if (
        marker.schema !== 1 ||
        marker.canonicalRoot !== windowsKey(identity.canonicalRoot) ||
        marker.userIdentity !== identity.userIdentity ||
        !verifyOwnership(candidate.path, identity.userIdentity)
      )
        continue
      remove(candidate.path)
    } catch {
      // Cleanup is best-effort; migration success must not be turned into a failure by stale cache I/O.
    }
  }
}
