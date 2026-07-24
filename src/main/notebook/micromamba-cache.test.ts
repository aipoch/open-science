import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_MAX_CACHE_RELATIVE_PATH,
  isTrustedWindowsCacheAcl,
  micromambaCacheLockKey,
  removeMicromambaCacheForRoot,
  selectMicromambaCache,
  WINDOWS_CACHE_DANGEROUS_RIGHT_NAMES,
  WINDOWS_MAX_USABLE_PATH,
  windowsCacheAclHardeningScript,
  windowsCacheAclReadScript,
  type MicromambaCacheDeps
} from './micromamba-cache'

const windowsDeps = (overrides: Partial<MicromambaCacheDeps> = {}): MicromambaCacheDeps => ({
  platform: 'win32',
  env: { USERNAME: 'alice', USERPROFILE: 'C:\\Users\\alice' },
  canonicalize: (path) => win32.normalize(path),
  prepare: (path) => win32.normalize(path),
  ...overrides
})

describe('selectMicromambaCache', () => {
  it('keeps the physical lock identity stable when a cache is created beneath an aliased root', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'os-cache-alias-'))
    const physicalRoot = join(sandbox, 'physical')
    const aliasedRoot = join(sandbox, 'alias')
    mkdirSync(physicalRoot)
    symlinkSync(physicalRoot, aliasedRoot, process.platform === 'win32' ? 'junction' : 'dir')
    const cache = join(aliasedRoot, 'pkgs')

    const before = micromambaCacheLockKey(cache)
    mkdirSync(join(physicalRoot, 'pkgs'))
    const after = micromambaCacheLockKey(cache)

    expect(before).toBe(after)
  })

  it('chooses a deterministic same-volume cache keyed by user and canonical runtime root', () => {
    const first = selectMicromambaCache(
      'D:\\OpenScience\\runtime',
      DEFAULT_MAX_CACHE_RELATIVE_PATH,
      windowsDeps()
    )
    const repeated = selectMicromambaCache(
      'D:\\OpenScience\\runtime\\.',
      DEFAULT_MAX_CACHE_RELATIVE_PATH,
      windowsDeps()
    )
    const otherRoot = selectMicromambaCache(
      'D:\\Other\\runtime',
      DEFAULT_MAX_CACHE_RELATIVE_PATH,
      windowsDeps()
    )

    expect(first.path).toMatch(/^D:\\osp[0-9a-f]{10}$/)
    expect(repeated).toEqual(first)
    expect(otherRoot.path).not.toBe(first.path)
    expect(first.lockKey).toBe(first.path.toLowerCase())
  })

  it('uses a trusted profile fallback when the volume-root candidate cannot be prepared', () => {
    const prepare = vi.fn((path: string) =>
      path.startsWith('D:\\') ? undefined : win32.normalize(path)
    )
    const selected = selectMicromambaCache(
      'D:\\OpenScience\\runtime',
      DEFAULT_MAX_CACHE_RELATIVE_PATH,
      windowsDeps({ prepare })
    )

    expect(selected.path).toMatch(/^C:\\Users\\alice\\osp[0-9a-f]{10}$/)
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it('uses a compact profile cache when the volume root is untrusted and the legacy leaf is too long', () => {
    const prepare = vi.fn((path: string) =>
      path.startsWith('E:\\') ? undefined : win32.normalize(path)
    )
    const selected = selectMicromambaCache(
      'E:\\open science\\OpenScience\\runtime',
      DEFAULT_MAX_CACHE_RELATIVE_PATH,
      windowsDeps({
        env: {
          USERNAME: 'peipeidamowang',
          USERPROFILE: 'C:\\Users\\peipeidamowang'
        },
        prepare
      })
    )

    expect(selected.path).toMatch(/^C:\\Users\\peipeidamowang\\os[0-9a-hjkmnp-tv-z]{8}$/)
    expect(selected.path.length + DEFAULT_MAX_CACHE_RELATIVE_PATH).toBe(WINDOWS_MAX_USABLE_PATH)
    expect(prepare).toHaveBeenCalledTimes(2)
  })

  it('rejects candidates that are writable but do not fit the actual pack budget', () => {
    expect(() =>
      selectMicromambaCache(
        'D:\\OpenScience\\runtime',
        250,
        windowsDeps({ env: { USERNAME: 'alice', USERPROFILE: 'C:\\Users\\a-very-long-profile' } })
      )
    ).toThrow(/Candidate diagnostics:/i)
    expect(() =>
      selectMicromambaCache(
        'D:\\OpenScience\\runtime',
        250,
        windowsDeps({ env: { USERNAME: 'alice', USERPROFILE: 'C:\\Users\\a-very-long-profile' } })
      )
    ).not.toThrow(/LongPathsEnabled|administrator/i)
  })

  it('reports why every Windows cache candidate was rejected', () => {
    const profile = 'C:\\Users\\peipeidamowang-with-a-long-profile'
    let message = ''
    try {
      selectMicromambaCache(
        'E:\\open science\\OpenScience\\runtime',
        DEFAULT_MAX_CACHE_RELATIVE_PATH,
        windowsDeps({
          env: { USERNAME: 'peipeidamowang', USERPROFILE: profile },
          prepare: (path) => ({
            rejection: path.startsWith('E:\\')
              ? 'ownership or permissions are not trusted'
              : 'cache marker is missing or unreadable'
          })
        })
      )
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('Candidate diagnostics:')
    expect(message).toMatch(/E:\\osp[0-9a-f]{10}: ownership or permissions are not trusted/)
    expect(message).toMatch(
      /C:\\Users\\peipeidamowang-with-a-long-profile\\osp[0-9a-f]{10}: exceeds the Windows path budget/
    )
    expect(message).toMatch(
      /C:\\Users\\peipeidamowang-with-a-long-profile\\os[0-9a-hjkmnp-tv-z]{8}: exceeds the Windows path budget/
    )
    expect(message).not.toContain('unavailable, untrusted, or not writable')
    expect(message).not.toContain('restrict write access')
    expect(message).not.toMatch(/shorter data-root/i)
  })

  it('rejects an untrusted candidate and tries the profile location', () => {
    const prepare = vi.fn((path: string) =>
      path.startsWith('D:\\') ? undefined : win32.normalize(path)
    )
    const selected = selectMicromambaCache(
      'D:\\OpenScience\\runtime',
      DEFAULT_MAX_CACHE_RELATIVE_PATH,
      windowsDeps({ prepare })
    )

    expect(selected.path).toContain('C:\\Users\\alice')
  })

  it('keeps non-Windows cache behavior unchanged', () => {
    expect(
      selectMicromambaCache('/Users/alice/OpenScience/runtime', 999, {
        platform: 'darwin',
        env: {},
        canonicalize: (path) => path,
        prepare: () => {
          throw new Error('must not prepare an external cache')
        }
      })
    ).toEqual({
      path: '/Users/alice/OpenScience/runtime/pkgs',
      lockKey: '/Users/alice/OpenScience/runtime/pkgs'
    })
  })

  it('rejects a cache whose OS ownership/trust boundary cannot be verified', () => {
    const verifyOwnership = vi
      .fn<(path: string, userIdentity: string) => boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    const prepare = (path: string): string => win32.normalize(path)
    const selected = selectMicromambaCache(
      'D:\\OpenScience\\runtime',
      DEFAULT_MAX_CACHE_RELATIVE_PATH,
      windowsDeps({ prepare, verifyOwnership })
    )

    expect(selected.path).toMatch(/^C:\\Users\\alice\\osp[0-9a-f]{10}$/)
    expect(verifyOwnership).toHaveBeenCalledTimes(2)
  })
})

describe('removeMicromambaCacheForRoot', () => {
  const root = 'D:\\OpenScience\\runtime'
  const env = { USERNAME: 'alice', USERPROFILE: 'C:\\Users\\alice' }
  const marker = {
    schema: 1,
    canonicalRoot: root.toLowerCase(),
    userIdentity: 'alice'
  }

  it('removes only a correctly marked and OS-owned cache', () => {
    const removed: string[] = []
    let inspected = 0
    removeMicromambaCacheForRoot(root, {
      platform: 'win32',
      env,
      canonicalize: (path) => win32.normalize(path),
      verifyOwnership: () => true,
      inspect: () => ({
        directory: true,
        symbolicLink: false,
        marker: inspected++ === 0 ? marker : { ...marker, canonicalRoot: 'd:\\tampered' }
      }),
      remove: (path) => removed.push(path)
    })

    expect(removed).toHaveLength(1)
    expect(removed[0]).toMatch(/^D:\\osp[0-9a-f]{10}$/)
  })

  it('retains symlinked, unowned, and non-Windows candidates', () => {
    const remove = vi.fn()
    let inspected = 0
    removeMicromambaCacheForRoot(root, {
      platform: 'win32',
      env,
      canonicalize: (path) => win32.normalize(path),
      verifyOwnership: () => false,
      inspect: () => ({ directory: true, symbolicLink: inspected++ === 0, marker }),
      remove
    })
    removeMicromambaCacheForRoot(root, {
      platform: 'darwin',
      inspect: () => {
        throw new Error('must not inspect a non-Windows cache')
      },
      remove
    })

    expect(remove).not.toHaveBeenCalled()
  })

  it('removes a correctly marked compact profile cache', () => {
    const removed: string[] = []
    removeMicromambaCacheForRoot(root, {
      platform: 'win32',
      env,
      canonicalize: (path) => win32.normalize(path),
      verifyOwnership: () => true,
      inspect: () => ({ directory: true, symbolicLink: false, marker }),
      remove: (path) => removed.push(path)
    })

    expect(removed).toHaveLength(3)
    expect(removed).toContainEqual(
      expect.stringMatching(/^C:\\Users\\alice\\os[0-9a-hjkmnp-tv-z]{8}$/)
    )
  })
})

describe('isTrustedWindowsCacheAcl', () => {
  it('builds a literal-safe least-privilege ACL hardening command', () => {
    const script = windowsCacheAclHardeningScript("C:\\Users\\O'Brien\\cache")

    expect(script).toContain("$path='C:\\Users\\O''Brien\\cache'")
    expect(script).toContain('$acl.SetOwner($current)')
    expect(script).toContain('$acl.SetAccessRuleProtection($true,$false)')
    expect(script).toContain('S-1-5-18')
    expect(script).toContain('S-1-5-32-544')
    expect(script).toContain('FileSystemRights]::FullControl')
    expect(script).toContain('[System.IO.Directory]::SetAccessControl($path,$acl)')
    expect(script).not.toMatch(/Everyone|Authenticated Users|S-1-1-0|S-1-5-11/i)
    expect(script).not.toMatch(/Set-Acl/i)
  })

  it('reads ACLs without relying on PowerShell security module autoloading', () => {
    const script = windowsCacheAclReadScript("C:\\Users\\O'Brien\\cache")

    expect(script).toContain(
      "$acl=[System.IO.Directory]::GetAccessControl('C:\\Users\\O''Brien\\cache')"
    )
    expect(script).toContain('$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value')
    expect(script).toContain('$acl.GetAccessRules($true,$true,')
    expect(script).not.toMatch(/Get-Acl/i)
  })

  it('allows writes only for the current user and trusted system principals', () => {
    const current = 'S-1-5-21-1000'
    expect(
      isTrustedWindowsCacheAcl({
        OwnerSid: current,
        CurrentSid: current,
        Rules: [
          { Sid: current, Rights: 'FullControl', Type: 'Allow' },
          { Sid: 'S-1-5-18', Rights: 'FullControl', Type: 'Allow' },
          { Sid: 'S-1-5-32-545', Rights: 'ReadAndExecute', Type: 'Allow' }
        ]
      })
    ).toBe(true)
  })

  it('rejects a foreign owner or any custom group with write access', () => {
    const current = 'S-1-5-21-1000'
    expect(
      isTrustedWindowsCacheAcl({ OwnerSid: 'S-1-5-21-2000', CurrentSid: current, Rules: [] })
    ).toBe(false)
    expect(
      isTrustedWindowsCacheAcl({
        OwnerSid: current,
        CurrentSid: current,
        Rules: [{ Sid: 'S-1-5-21-3000', Rights: 'Modify, Synchronize', Type: 'Allow' }]
      })
    ).toBe(false)
  })

  it.each(['ChangePermissions', 'TakeOwnership'])(
    'rejects a foreign principal with %s',
    (rights) => {
      const current = 'S-1-5-21-1000'
      expect(
        isTrustedWindowsCacheAcl({
          OwnerSid: current,
          CurrentSid: current,
          Rules: [{ Sid: 'S-1-5-21-3000', Rights: rights, Type: 'Allow' }]
        })
      ).toBe(false)
    }
  )

  it('documents the complete dangerous-rights set used by the uninstaller', () => {
    expect(WINDOWS_CACHE_DANGEROUS_RIGHT_NAMES).toEqual([
      'Write',
      'Modify',
      'FullControl',
      'CreateFiles',
      'AppendData',
      'Delete',
      'DeleteSubdirectoriesAndFiles',
      'ChangePermissions',
      'TakeOwnership'
    ])
  })
})
