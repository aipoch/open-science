import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, posix, resolve, win32 } from 'node:path'

import { resolveWindowsPowerShellExecutable } from '../windows-powershell'
import { DEFAULT_MAX_CACHE_RELATIVE_PATH as MANIFEST_DEFAULT_MAX_CACHE_RELATIVE_PATH } from './bundle-manifest'

export const WINDOWS_MAX_USABLE_PATH = 259
export const DEFAULT_MAX_CACHE_RELATIVE_PATH = MANIFEST_DEFAULT_MAX_CACHE_RELATIVE_PATH

export type MicromambaCache = {
  path: string
  lockKey: string
}

export type MicromambaCachePreparation = {
  path?: string
  rejection?: string
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
  hardenOwnership?: (path: string) => boolean | void
  prepare?: (
    path: string,
    ownership: CacheOwnership
  ) => string | MicromambaCachePreparation | undefined
  verifyOwnership?: (path: string, userIdentity: string) => boolean
  exists?: (path: string) => boolean
}

type CacheMarker = { schema?: number; canonicalRoot?: string; userIdentity?: string }

type TempParentMarker = { schema?: number; kind?: string; userIdentity?: string }

const WINDOWS_TEMP_PARENT = 'OpenScienceTmp'
const TEMP_PARENT_MARKER_FILE = '.open-science-temp.json'
const TEMP_PARENT_MARKER_KIND = 'micromamba-working-cache-parent'

export type MicromambaCacheCleanupDeps = Pick<
  MicromambaCacheDeps,
  'platform' | 'env' | 'canonicalize' | 'verifyOwnership'
> & {
  inspect?: (path: string) => { directory: boolean; symbolicLink: boolean; marker: CacheMarker }
  inspectParent?: (path: string) => {
    directory: boolean
    symbolicLink: boolean
    physical: string
    marker?: TempParentMarker
  }
  remove?: (path: string) => void
  preserveParent?: boolean
}

type CachePathCandidate = {
  path: string
  profileBoundary?: string
  managedParent?: boolean
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

export const windowsCacheAclHardeningScript = (path: string): string => {
  const literal = powershellLiteral(path)
  return (
    `$path='${literal}'; ` +
    '$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; ' +
    "$system=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'); " +
    "$administrators=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'); " +
    '$inheritance=[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor ' +
    '[System.Security.AccessControl.InheritanceFlags]::ObjectInherit; ' +
    '$propagation=[System.Security.AccessControl.PropagationFlags]::None; ' +
    '$allow=[System.Security.AccessControl.AccessControlType]::Allow; ' +
    '$acl=[System.IO.Directory]::GetAccessControl($path); ' +
    '$acl.SetAccessRuleProtection($true,$false); ' +
    '@($current,$system,$administrators) | ForEach-Object { ' +
    '$rule=[System.Security.AccessControl.FileSystemAccessRule]::new(' +
    '$_,[System.Security.AccessControl.FileSystemRights]::FullControl,' +
    '$inheritance,$propagation,$allow); ' +
    '[void]$acl.AddAccessRule($rule) }; ' +
    '[System.IO.Directory]::SetAccessControl($path,$acl)'
  )
}

const resolveWindowsSystemExecutable = (name: string): string => {
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR
  return windowsRoot ? win32.join(windowsRoot, 'System32', name) : name
}

const currentWindowsUserSid = (): string => {
  const raw = execFileSync(
    resolveWindowsSystemExecutable('whoami.exe'),
    ['/user', '/fo', 'csv', '/nh'],
    { encoding: 'utf8', windowsHide: true }
  )
  const sid = raw.match(/\bS-\d-(?:\d+-)+\d+\b/i)?.[0]
  if (!sid) throw new Error('Could not determine the current Windows user SID.')
  return sid
}

export const hardenWindowsCacheAclWithIcacls = (path: string): void => {
  const currentSid = currentWindowsUserSid()
  execFileSync(
    resolveWindowsSystemExecutable('icacls.exe'),
    [
      path,
      '/inheritance:r',
      '/grant:r',
      `*${currentSid}:(OI)(CI)F`,
      '*S-1-5-18:(OI)(CI)F',
      '*S-1-5-32-544:(OI)(CI)F'
    ],
    { encoding: 'utf8', windowsHide: true }
  )
}

export const hardenWindowsCacheAcl = (path: string): boolean => {
  if (process.platform !== 'win32') return false
  try {
    execFileSync(
      resolveWindowsPowerShellExecutable(),
      ['-NoProfile', '-NonInteractive', '-Command', windowsCacheAclHardeningScript(path)],
      { encoding: 'utf8', windowsHide: true }
    )
  } catch {
    // Windows PowerShell reports .NET ACL failures as a normal non-zero process exit (not always
    // EPERM/EACCES, and the localized stderr is not stable). icacls is the independent system fallback;
    // if it also fails its error propagates and cache preparation remains fail-closed.
    hardenWindowsCacheAclWithIcacls(path)
  }
  return true
}

export type WindowsCacheAcl = {
  OwnerSid?: string
  CurrentSid?: string
  Rules?: Array<{ Sid?: string; Rights?: string; Type?: string }>
}

type WindowsCacheAclRule = NonNullable<WindowsCacheAcl['Rules']>[number]

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

export const WINDOWS_CACHE_TRUSTED_OWNER_SIDS = [
  'S-1-5-18', // LocalSystem
  'S-1-5-32-544' // Builtin Administrators
] as const

const dangerousWindowsCacheRight = new RegExp(WINDOWS_CACHE_DANGEROUS_RIGHT_NAMES.join('|'), 'i')

export const isTrustedWindowsCacheAcl = (acl: WindowsCacheAcl): boolean => {
  if (!acl.OwnerSid || !acl.CurrentSid) return false
  const trustedOwnerSids = new Set([acl.CurrentSid, ...WINDOWS_CACHE_TRUSTED_OWNER_SIDS])
  if (!trustedOwnerSids.has(acl.OwnerSid)) return false
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

export const windowsCacheAclReadScript = (path: string): string => {
  const literal = powershellLiteral(path)
  return (
    `$acl=[System.IO.Directory]::GetAccessControl('${literal}'); ` +
    `$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; ` +
    `$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; ` +
    `$rules=$acl.GetAccessRules($true,$true,` +
    `[System.Security.Principal.SecurityIdentifier]) | ForEach-Object { ` +
    `[pscustomobject]@{Sid=$_.IdentityReference.Value; ` +
    `Rights=$_.FileSystemRights.ToString(); Type=$_.AccessControlType.ToString()} }; ` +
    `[pscustomobject]@{OwnerSid=$owner; CurrentSid=$current; Rules=$rules} | ` +
    'ConvertTo-Json -Compress -Depth 4'
  )
}

export const readWindowsCacheAcl = (path: string): WindowsCacheAcl => {
  const script = windowsCacheAclReadScript(path)
  const raw = execFileSync(
    resolveWindowsPowerShellExecutable(),
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true
    }
  )
  const acl = JSON.parse(raw) as Omit<WindowsCacheAcl, 'Rules'> & {
    Rules?: WindowsCacheAclRule | WindowsCacheAclRule[]
  }
  const rules = !acl.Rules ? [] : Array.isArray(acl.Rules) ? acl.Rules : [acl.Rules]
  return { ...acl, Rules: rules }
}

// A marker proves only that the marker contents are self-consistent. On Windows, a cache outside
// the profile must also be owned by the current user and must not grant broad principals write
// access. PowerShell is part of every supported Windows installation; failures fail closed.
const defaultVerifyOwnership = (path: string, userIdentity: string): boolean => {
  void userIdentity
  if (process.platform !== 'win32') return true
  try {
    return isTrustedWindowsCacheAcl(readWindowsCacheAcl(path))
  } catch {
    return false
  }
}

const defaultPrepare = (
  path: string,
  ownership: CacheOwnership,
  hardenOwnership: (path: string) => boolean | void,
  verifyOwnership: (path: string, userIdentity: string) => boolean
): MicromambaCachePreparation => {
  let created = false
  let parentCreated = false
  let parentMarkerWritten = false
  let verifiedByHardening = false
  const parent = win32.dirname(path)
  const reject = (rejection: string): MicromambaCachePreparation => {
    if (created) {
      try {
        rmSync(path, { recursive: true, force: true })
      } catch {
        // Preserve the original rejection; cleanup is best-effort for a directory this call created.
      }
    }
    if (parentCreated) {
      try {
        if (parentMarkerWritten) {
          removeEmptyManagedParent(parent, ownership.userIdentity, verifyOwnership)
        } else {
          // The marker was never published, so this call can only remove the still-empty directory it
          // created. A concurrent child makes this non-recursive removal fail safely.
          rmdirSync(parent)
        }
      } catch {
        // Preserve the original rejection. Never recurse through the shared parent: another app
        // process may already have created a sibling cache after this call created the directory.
      }
    }
    return { rejection }
  }
  const errorDetail = (error: unknown): string => {
    if (!(error instanceof Error)) return 'unknown error'
    const code = (error as NodeJS.ErrnoException).code
    return code ? `${code}: ${error.message}` : error.message
  }
  try {
    const expectedParent: Required<TempParentMarker> = {
      schema: 1,
      kind: TEMP_PARENT_MARKER_KIND,
      userIdentity: ownership.userIdentity
    }
    let parentState
    try {
      parentState = lstatSync(parent)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return reject(`temporary parent could not be inspected (${errorDetail(error)})`)
      }
    }
    if (parentState) {
      if (!parentState.isDirectory() || parentState.isSymbolicLink()) {
        return reject('temporary parent exists but is not a trusted directory')
      }
      let parentMarker: TempParentMarker
      try {
        parentMarker = JSON.parse(
          readFileSync(win32.join(parent, TEMP_PARENT_MARKER_FILE), 'utf8')
        ) as TempParentMarker
      } catch (error) {
        return reject(
          `temporary parent ownership marker is missing or unreadable (${errorDetail(error)})`
        )
      }
      if (
        parentMarker.schema !== expectedParent.schema ||
        parentMarker.kind !== expectedParent.kind ||
        parentMarker.userIdentity !== expectedParent.userIdentity
      ) {
        return reject('temporary parent ownership marker does not match the current Windows user')
      }
      if (windowsKey(realpathSync.native(parent)) !== windowsKey(parent)) {
        return reject('temporary parent resolves to an unexpected physical location')
      }
      if (!verifyOwnership(parent, ownership.userIdentity)) {
        return reject('temporary parent ownership or permissions are not trusted')
      }
    } else {
      mkdirSync(parent, { mode: 0o700 })
      parentCreated = true
      try {
        hardenOwnership(parent)
      } catch (error) {
        return reject(`temporary parent ACL could not be hardened (${errorDetail(error)})`)
      }
      writeFileSync(
        win32.join(parent, TEMP_PARENT_MARKER_FILE),
        `${JSON.stringify(expectedParent)}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' }
      )
      parentMarkerWritten = true
      if (!verifyOwnership(parent, ownership.userIdentity)) {
        return reject('temporary parent ownership or permissions are not trusted')
      }
    }

    try {
      const stat = lstatSync(path)
      if (!stat.isDirectory()) return reject('path exists but is not a directory')
      if (stat.isSymbolicLink()) return reject('path is a symbolic link or reparse point')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return reject(`path could not be inspected (${errorDetail(error)})`)
      }
      mkdirSync(path, { mode: 0o700 })
      created = true
      try {
        verifiedByHardening = hardenOwnership(path) === true
      } catch (error) {
        return reject(`cache ACL could not be hardened (${errorDetail(error)})`)
      }
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
      let marker: typeof expected
      try {
        marker = JSON.parse(readFileSync(markerPath, 'utf8')) as typeof expected
      } catch (error) {
        return reject(`cache marker is missing or unreadable (${errorDetail(error)})`)
      }
      if (
        marker.schema !== expected.schema ||
        marker.canonicalRoot !== expected.canonicalRoot ||
        marker.userIdentity !== expected.userIdentity
      ) {
        return reject('cache marker does not match the current runtime root and Windows user')
      }
    }

    const physical = realpathSync.native(path)
    if (windowsKey(physical) !== windowsKey(path)) {
      return reject(`path resolves to an unexpected physical location (${physical})`)
    }
    if (
      ownership.profileBoundary &&
      !isInside(realpathSync.native(ownership.profileBoundary), physical)
    ) {
      return reject('path resolves outside the Windows user profile')
    }
    if (!verifiedByHardening && !verifyOwnership(physical, ownership.userIdentity)) {
      return reject('ownership or permissions are not trusted')
    }

    const probe = win32.join(physical, `.write-test-${randomUUID()}`)
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    return { path: physical }
  } catch (error) {
    return reject(`cache preparation failed (${errorDetail(error)})`)
  }
}

const fitsBudget = (cacheRoot: string, maxCacheRelativePath: number): boolean =>
  cacheRoot.length + maxCacheRelativePath <= WINDOWS_MAX_USABLE_PATH

const isAsciiPath = (path: string): boolean =>
  Array.from(path).every((character) => character.charCodeAt(0) <= 0x7f)

const BASE32_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

const compactCacheHash = (digest: Buffer): string => {
  let value = 0
  let bits = 0
  let encoded = ''
  for (const byte of digest.subarray(0, 5)) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      encoded += BASE32_ALPHABET[(value >>> bits) & 31]
      value &= (1 << bits) - 1
    }
  }
  return encoded
}

const cacheIdentity = (
  root: string,
  env: NodeJS.ProcessEnv,
  canonicalize: (path: string) => string
): {
  canonicalRoot: string
  userIdentity: string
  leaf: string
  legacyLeaf: string
  legacyCompactLeaf: string
} => {
  const userIdentity = [env.USERDOMAIN, env.USERNAME].filter(Boolean).join('\\')
  if (!userIdentity) {
    throw new Error('Cannot determine the Windows user identity for the managed runtime cache.')
  }
  const canonicalRoot = win32.normalize(canonicalize(root))
  const digest = createHash('sha256')
    .update(`${userIdentity.toLowerCase()}\0${windowsKey(canonicalRoot)}`)
    .digest()
  return {
    canonicalRoot,
    userIdentity,
    leaf: `m-${compactCacheHash(digest)}`,
    legacyLeaf: `osp${digest.toString('hex').slice(0, 10)}`,
    legacyCompactLeaf: `os${compactCacheHash(digest)}`
  }
}

const candidatePaths = (
  canonicalRoot: string,
  leaf: string,
  env: NodeJS.ProcessEnv,
  canonicalize: (path: string) => string
): CachePathCandidate[] => {
  const runtimeVolume = win32.parse(canonicalRoot).root
  const seenTemporaryRoots = new Set([windowsKey(runtimeVolume)])
  const perUserTemps = [env.TEMP, env.TMP]
    .filter((path): path is string => Boolean(path))
    .map((path) => win32.normalize(canonicalize(path)))
    .filter((path) => {
      const key = windowsKey(path)
      if (seenTemporaryRoots.has(key)) return false
      seenTemporaryRoots.add(key)
      return true
    })
  const profile = env.USERPROFILE ? win32.normalize(canonicalize(env.USERPROFILE)) : undefined
  const primary = {
    path: win32.join(runtimeVolume, WINDOWS_TEMP_PARENT, leaf),
    managedParent: true
  }
  return [
    primary,
    ...perUserTemps.map((perUserTemp) => ({
      path: win32.join(perUserTemp, WINDOWS_TEMP_PARENT, leaf),
      profileBoundary: perUserTemp,
      managedParent: true
    })),
    ...(profile
      ? [
          {
            path: win32.join(profile, 'os-tmp', leaf),
            profileBoundary: profile,
            managedParent: true
          }
        ]
      : [])
  ]
}

// Released versions used these external layouts. They are never selected again, but migration and
// eligible cleanup must still remove them after applying the same marker and ACL checks as the new
// working cache; otherwise large disposable package caches remain orphaned indefinitely.
const legacyCleanupCandidatePaths = (
  canonicalRoot: string,
  legacyLeaf: string,
  legacyCompactLeaf: string,
  env: NodeJS.ProcessEnv,
  canonicalize: (path: string) => string
): CachePathCandidate[] => {
  const runtimeVolume = win32.parse(canonicalRoot).root
  const profile = env.USERPROFILE ? win32.normalize(canonicalize(env.USERPROFILE)) : undefined
  const publicRoot = env.PUBLIC ? win32.normalize(canonicalize(env.PUBLIC)) : undefined
  return [
    { path: win32.join(runtimeVolume, legacyLeaf) },
    ...(profile
      ? [
          { path: win32.join(profile, legacyLeaf), profileBoundary: profile },
          { path: win32.join(profile, legacyCompactLeaf), profileBoundary: profile }
        ]
      : []),
    ...(publicRoot ? [{ path: win32.join(publicRoot, legacyLeaf) }] : [])
  ]
}

export const micromambaWorkingCachePaths = (
  root: string,
  deps: Pick<MicromambaCacheDeps, 'platform' | 'env' | 'canonicalize'> = {}
): string[] => {
  if ((deps.platform ?? process.platform) !== 'win32') return [posix.join(root, 'pkgs')]
  const env = deps.env ?? process.env
  const canonicalize = deps.canonicalize ?? canonicalizeExisting
  const identity = cacheIdentity(root, env, canonicalize)
  return candidatePaths(identity.canonicalRoot, identity.leaf, env, canonicalize).map(
    (candidate) => candidate.path
  )
}

export const micromambaWorkingCachePath = (
  root: string,
  deps: Pick<MicromambaCacheDeps, 'platform' | 'env' | 'canonicalize'> = {}
): string => micromambaWorkingCachePaths(root, deps)[0]

export const selectMicromambaCache = (
  root: string,
  maxCacheRelativePath = DEFAULT_MAX_CACHE_RELATIVE_PATH,
  deps: MicromambaCacheDeps = {}
): MicromambaCache => {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') {
    const path = posix.join(root, 'pkgs')
    return { path, lockKey: path }
  }
  if (!Number.isSafeInteger(maxCacheRelativePath) || maxCacheRelativePath <= 0) {
    throw new Error('Managed runtime pack has an invalid Windows package-cache path budget.')
  }

  const env = deps.env ?? process.env
  const canonicalize = deps.canonicalize ?? canonicalizeExisting
  const { canonicalRoot, userIdentity, leaf } = cacheIdentity(root, env, canonicalize)
  const hardenOwnership = deps.hardenOwnership ?? hardenWindowsCacheAcl
  const verifyOwnership = deps.verifyOwnership ?? defaultVerifyOwnership
  const prepare =
    deps.prepare ??
    ((path: string, ownership: CacheOwnership) =>
      defaultPrepare(path, ownership, hardenOwnership, verifyOwnership))
  const candidates = candidatePaths(canonicalRoot, leaf, env, canonicalize)
  const rejections: string[] = []

  for (const candidate of candidates) {
    if (!isAsciiPath(candidate.path)) {
      rejections.push(
        `${candidate.path}: contains non-ASCII characters unsupported by micromamba package extraction on Windows`
      )
      continue
    }
    if (!fitsBudget(candidate.path, maxCacheRelativePath)) {
      const excess = candidate.path.length + maxCacheRelativePath - WINDOWS_MAX_USABLE_PATH
      rejections.push(`${candidate.path}: exceeds the Windows path budget by ${excess} characters`)
      continue
    }
    const prepared = prepare(candidate.path, {
      canonicalRoot,
      userIdentity,
      profileBoundary: candidate.profileBoundary,
      platform
    })
    const preparation = typeof prepared === 'string' ? { path: prepared } : prepared
    const physical = preparation?.path
    if (!physical) {
      rejections.push(
        `${candidate.path}: ${preparation?.rejection ?? 'cache preparation returned no usable path'}`
      )
      continue
    }
    if (!isAsciiPath(physical)) {
      rejections.push(
        `${physical}: physical path contains non-ASCII characters unsupported by micromamba package extraction on Windows`
      )
      continue
    }
    if (!fitsBudget(physical, maxCacheRelativePath)) {
      const excess = physical.length + maxCacheRelativePath - WINDOWS_MAX_USABLE_PATH
      rejections.push(
        `${physical}: physical path exceeds the Windows path budget by ${excess} characters`
      )
      continue
    }
    if (deps.prepare !== undefined && !verifyOwnership(physical, userIdentity)) {
      rejections.push(`${physical}: ownership or permissions are not trusted`)
      continue
    }
    return { path: physical, lockKey: micromambaCacheLockKey(physical, { platform, canonicalize }) }
  }

  throw new Error(
    'No trusted writable package cache fits the managed runtime path budget. ' +
      `Candidate diagnostics: ${rejections.join('; ')}.`
  )
}

// Recovery reads an exact working-cache path from the operation journal. Revalidate that persisted
// path without creating it before any recursive scan: a damaged journal must not turn archive
// publication into an arbitrary-directory traversal, and a cache parent may have been replaced by a
// reparse point while the app was stopped. The marker-bound OpenScienceTmp form remains valid even if
// TEMP changed between runs; the fixed profile fallback must remain inside the current profile.
export const isTrustedMicromambaWorkingCacheForRoot = (
  root: string,
  path: string,
  deps: MicromambaCacheCleanupDeps = {}
): boolean => {
  const platform = deps.platform ?? process.platform
  const canonicalize = deps.canonicalize ?? canonicalizeExisting
  if (platform !== 'win32') {
    try {
      const expected = posix.join(root, 'pkgs')
      const state = lstatSync(path)
      return (
        state.isDirectory() &&
        !state.isSymbolicLink() &&
        canonicalize(path) === canonicalize(expected)
      )
    } catch {
      return false
    }
  }

  const env = deps.env ?? process.env
  let identity: ReturnType<typeof cacheIdentity>
  try {
    identity = cacheIdentity(root, env, canonicalize)
  } catch {
    return false
  }
  const normalized = win32.normalize(path)
  if (!win32.isAbsolute(normalized) || !isAsciiPath(normalized)) return false
  if (windowsKey(win32.basename(normalized)) !== windowsKey(identity.leaf)) return false

  const parent = win32.dirname(normalized)
  const parentLeaf = win32.basename(parent).toLowerCase()
  if (parentLeaf !== WINDOWS_TEMP_PARENT.toLowerCase() && parentLeaf !== 'os-tmp') return false
  const profile = env.USERPROFILE ? win32.normalize(canonicalize(env.USERPROFILE)) : undefined
  if (parentLeaf === 'os-tmp' && (!profile || !isInside(profile, parent))) return false

  const verifyOwnership = deps.verifyOwnership ?? defaultVerifyOwnership
  const inspectParent =
    deps.inspectParent ??
    ((candidate: string) => {
      const stat = lstatSync(candidate)
      return {
        directory: stat.isDirectory(),
        symbolicLink: stat.isSymbolicLink(),
        physical: realpathSync.native(candidate),
        marker: JSON.parse(
          readFileSync(win32.join(candidate, TEMP_PARENT_MARKER_FILE), 'utf8')
        ) as TempParentMarker
      }
    })
  const inspect =
    deps.inspect ??
    ((candidate: string): { directory: boolean; symbolicLink: boolean; marker: CacheMarker } => {
      const stat = lstatSync(candidate)
      return {
        directory: stat.isDirectory(),
        symbolicLink: stat.isSymbolicLink(),
        marker: JSON.parse(
          readFileSync(win32.join(candidate, '.open-science-cache.json'), 'utf8')
        ) as CacheMarker
      }
    })

  try {
    const parentState = inspectParent(parent)
    if (
      !parentState.directory ||
      parentState.symbolicLink ||
      windowsKey(parentState.physical) !== windowsKey(parent) ||
      parentState.marker?.schema !== 1 ||
      parentState.marker.kind !== TEMP_PARENT_MARKER_KIND ||
      parentState.marker.userIdentity !== identity.userIdentity ||
      !verifyOwnership(parentState.physical, identity.userIdentity)
    ) {
      return false
    }
    const state = inspect(normalized)
    return (
      state.directory &&
      !state.symbolicLink &&
      windowsKey(canonicalize(normalized)) === windowsKey(normalized) &&
      state.marker.schema === 1 &&
      state.marker.canonicalRoot === windowsKey(identity.canonicalRoot) &&
      state.marker.userIdentity === identity.userIdentity &&
      verifyOwnership(normalized, identity.userIdentity)
    )
  } catch {
    return false
  }
}

type EmptyManagedParentRemovalDeps = {
  readMarker?: (path: string) => string
  list?: (path: string) => string[]
  removeMarker?: (path: string) => void
  removeParent?: (path: string) => void
  restoreMarker?: (path: string, raw: string) => void
}

export const removeEmptyManagedParent = (
  parent: string,
  userIdentity: string,
  verifyOwnership: (path: string, userIdentity: string) => boolean,
  deps: EmptyManagedParentRemovalDeps = {}
): void => {
  const markerPath = win32.join(parent, TEMP_PARENT_MARKER_FILE)
  const raw = (deps.readMarker ?? ((path: string) => readFileSync(path, 'utf8')))(markerPath)
  const marker = JSON.parse(raw) as TempParentMarker
  if (
    marker.schema !== 1 ||
    marker.kind !== TEMP_PARENT_MARKER_KIND ||
    marker.userIdentity !== userIdentity ||
    !verifyOwnership(parent, userIdentity) ||
    !(deps.list ?? readdirSync)(parent).every((entry) => entry === TEMP_PARENT_MARKER_FILE)
  ) {
    return
  }

  // Remove the marker first, then use a non-recursive directory removal. If another app process adds a
  // child after the emptiness check, rmdir fails instead of recursively deleting that active cache. Put
  // the marker back best-effort so the surviving parent remains recognizable on the next startup.
  ;(deps.removeMarker ?? ((path: string) => rmSync(path)))(markerPath)
  try {
    ;(deps.removeParent ?? rmdirSync)(parent)
  } catch (error) {
    try {
      ;(
        deps.restoreMarker ??
        ((path: string, contents: string) =>
          writeFileSync(path, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' }))
      )(markerPath, raw)
    } catch {
      // Preserve the non-destructive outcome; a concurrent owner may already have restored the marker.
    }
    throw error
  }
}

export const removeTrustedMicromambaWorkingCacheForRoot = (
  root: string,
  path: string,
  deps: MicromambaCacheCleanupDeps = {}
): boolean => {
  if ((deps.platform ?? process.platform) !== 'win32') return false
  if (!isTrustedMicromambaWorkingCacheForRoot(root, path, deps)) return false
  const env = deps.env ?? process.env
  const canonicalize = deps.canonicalize ?? canonicalizeExisting
  let identity: ReturnType<typeof cacheIdentity>
  try {
    identity = cacheIdentity(root, env, canonicalize)
  } catch {
    return false
  }
  const parent = win32.dirname(win32.normalize(path))
  const verifyOwnership = deps.verifyOwnership ?? defaultVerifyOwnership
  try {
    ;(deps.remove ?? ((candidate: string) => rmSync(candidate, { recursive: true, force: true })))(
      path
    )
    if (!deps.remove && !deps.preserveParent) {
      removeEmptyManagedParent(parent, identity.userIdentity, verifyOwnership)
    }
    return true
  } catch {
    return false
  }
}

// Removes only the app-owned cache for a previous runtime root. This is used after a successful data
// root migration because the physical cache intentionally lives outside the data tree. Marker and
// ownership checks are repeated here so a stale or tampered path is left untouched.
export const removeMicromambaCacheForRoot = (
  root: string,
  deps: MicromambaCacheCleanupDeps = {}
): boolean => {
  if ((deps.platform ?? process.platform) !== 'win32') return true
  const env = deps.env ?? process.env
  const canonicalize = deps.canonicalize ?? canonicalizeExisting
  let identity: ReturnType<typeof cacheIdentity>
  try {
    identity = cacheIdentity(root, env, canonicalize)
  } catch {
    return false
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
  const inspectParent =
    deps.inspectParent ??
    ((path: string) => {
      const stat = lstatSync(path)
      let marker: TempParentMarker | undefined
      try {
        marker = JSON.parse(
          readFileSync(win32.join(path, TEMP_PARENT_MARKER_FILE), 'utf8')
        ) as TempParentMarker
      } catch {
        // Released legacy layouts did not own their parent, while managed parents are rejected below.
      }
      return {
        directory: stat.isDirectory(),
        symbolicLink: stat.isSymbolicLink(),
        physical: realpathSync.native(path),
        marker
      }
    })
  const remove =
    deps.remove ?? ((path: string): void => rmSync(path, { recursive: true, force: true }))
  const cleanupCandidates = [
    ...candidatePaths(identity.canonicalRoot, identity.leaf, env, canonicalize),
    ...legacyCleanupCandidatePaths(
      identity.canonicalRoot,
      identity.legacyLeaf,
      identity.legacyCompactLeaf,
      env,
      canonicalize
    )
  ]
  let completed = true
  for (const candidate of cleanupCandidates) {
    try {
      const parent = win32.dirname(candidate.path)
      const parentState = inspectParent(parent)
      if (
        !parentState.directory ||
        parentState.symbolicLink ||
        windowsKey(parentState.physical) !== windowsKey(parent) ||
        (candidate.profileBoundary && !isInside(candidate.profileBoundary, parentState.physical))
      )
        continue
      if (
        candidate.managedParent &&
        (parentState.marker?.schema !== 1 ||
          parentState.marker.kind !== TEMP_PARENT_MARKER_KIND ||
          parentState.marker.userIdentity !== identity.userIdentity ||
          !verifyOwnership(parentState.physical, identity.userIdentity))
      )
        continue
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
      if (!deps.remove && !deps.preserveParent) {
        removeEmptyManagedParent(parent, identity.userIdentity, verifyOwnership)
      }
    } catch (error) {
      // A missing candidate or marker means there is nothing app-owned to remove. Preserve every other
      // failure so operation journals can retain the exact cleanup evidence for a later retry.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') completed = false
    }
  }
  return completed
}
