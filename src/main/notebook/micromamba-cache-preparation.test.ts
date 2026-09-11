import { win32 } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const fsMocks = vi.hoisted(() => {
  const native = vi.fn((path: string) => path)
  const realpathSync = Object.assign(
    vi.fn((path: string) => path),
    { native }
  )
  return {
    existsSync: vi.fn(() => false),
    lstatSync: vi.fn(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    }),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    realpathSync,
    rmdirSync: vi.fn(),
    rmSync: vi.fn(),
    writeFileSync: vi.fn()
  }
})

vi.mock('node:fs', () => fsMocks)

import {
  DEFAULT_MAX_CACHE_RELATIVE_PATH,
  selectMicromambaCache,
  type MicromambaCacheDeps
} from './micromamba-cache'

describe('Windows micromamba cache preparation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('hardens a newly created candidate before verifying its ownership and permissions', () => {
    const hardenOwnership = vi.fn()
    const verifyOwnership = vi.fn(() => hardenOwnership.mock.calls.length > 0)
    const deps = {
      platform: 'win32',
      env: { USERNAME: 'alice', USERPROFILE: 'C:\\Users\\alice' },
      canonicalize: (path: string) => win32.normalize(path),
      hardenOwnership,
      verifyOwnership
    } as MicromambaCacheDeps

    const cache = selectMicromambaCache(
      'D:\\Open-Science\\runtime',
      DEFAULT_MAX_CACHE_RELATIVE_PATH,
      deps
    )

    expect(cache.path).toMatch(/^D:\\Open-ScienceTmp\\m-[0-9a-hjkmnp-tv-z]{8}$/)
    expect(hardenOwnership).toHaveBeenCalledTimes(2)
    expect(hardenOwnership).toHaveBeenNthCalledWith(1, 'D:\\Open-ScienceTmp')
    expect(hardenOwnership).toHaveBeenNthCalledWith(2, cache.path)
    expect(hardenOwnership.mock.invocationCallOrder[0]).toBeLessThan(
      fsMocks.writeFileSync.mock.invocationCallOrder[0]
    )
    expect(hardenOwnership.mock.invocationCallOrder[0]).toBeLessThan(
      verifyOwnership.mock.invocationCallOrder[0]
    )
  })

  it('verifies the shared parent but skips a second ACL read for a securely hardened cache child', () => {
    const hardenOwnership = vi.fn(() => true)
    const verifyOwnership = vi.fn((path: string) => path === 'D:\\Open-ScienceTmp')

    const cache = selectMicromambaCache(
      'D:\\Open-Science\\runtime',
      DEFAULT_MAX_CACHE_RELATIVE_PATH,
      {
        platform: 'win32',
        env: { USERNAME: 'alice', USERPROFILE: 'C:\\Users\\alice' },
        canonicalize: (path) => win32.normalize(path),
        hardenOwnership,
        verifyOwnership
      }
    )

    expect(cache.path).toMatch(/^D:\\Open-ScienceTmp\\m-[0-9a-hjkmnp-tv-z]{8}$/)
    expect(hardenOwnership).toHaveBeenCalledTimes(2)
    expect(verifyOwnership).toHaveBeenCalledOnce()
    expect(verifyOwnership).toHaveBeenCalledWith('D:\\Open-ScienceTmp', 'alice')
  })

  it('removes newly created candidates when ACL hardening fails', () => {
    const hardenOwnership = vi.fn(() => {
      throw new Error('Set-Acl denied')
    })

    expect(() =>
      selectMicromambaCache('D:\\Open-Science\\runtime', DEFAULT_MAX_CACHE_RELATIVE_PATH, {
        platform: 'win32',
        env: { USERNAME: 'alice', USERPROFILE: 'C:\\Users\\alice' },
        canonicalize: (path) => win32.normalize(path),
        hardenOwnership,
        verifyOwnership: () => true
      })
    ).toThrow(/temporary parent ACL could not be hardened \(Set-Acl denied\)/)

    expect(hardenOwnership).toHaveBeenCalledTimes(2)
    expect(fsMocks.rmdirSync).toHaveBeenCalledWith('D:\\Open-ScienceTmp')
    expect(fsMocks.rmdirSync).toHaveBeenCalledWith('C:\\Users\\alice\\os-tmp')
    expect(fsMocks.rmSync).not.toHaveBeenCalledWith(
      expect.stringMatching(/(?:Open-ScienceTmp|os-tmp)$/),
      expect.objectContaining({ recursive: true })
    )
  })

  it('never recursively removes a newly created shared parent after a sibling appears', () => {
    const hardenOwnership = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockImplementationOnce(() => {
        throw new Error('child ACL denied')
      })
      .mockReturnValue(true)
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({
        schema: 1,
        kind: 'micromamba-working-cache-parent',
        userIdentity: 'alice'
      })
    )
    fsMocks.readdirSync.mockReturnValue([
      '.open-science-temp.json' as never,
      'm-concurrent' as never
    ])

    expect(() =>
      selectMicromambaCache('D:\\Open-Science\\runtime', DEFAULT_MAX_CACHE_RELATIVE_PATH, {
        platform: 'win32',
        env: { USERNAME: 'alice', USERPROFILE: 'C:\\Users\\alice' },
        canonicalize: (path) => win32.normalize(path),
        hardenOwnership,
        verifyOwnership: () => true
      })
    ).not.toThrow()

    expect(fsMocks.rmSync).toHaveBeenCalledWith(expect.stringMatching(/^D:\\Open-ScienceTmp\\m-/), {
      recursive: true,
      force: true
    })
    expect(fsMocks.rmSync).not.toHaveBeenCalledWith(
      'D:\\Open-ScienceTmp',
      expect.objectContaining({ recursive: true })
    )
    expect(fsMocks.rmdirSync).not.toHaveBeenCalledWith('D:\\Open-ScienceTmp')
  })

  it('does not harden or take over an existing marked candidate', () => {
    const directory = {
      isDirectory: () => true,
      isSymbolicLink: () => false
    } as never
    fsMocks.lstatSync.mockImplementationOnce(() => directory)
    fsMocks.lstatSync.mockImplementationOnce(() => directory)
    fsMocks.readFileSync.mockImplementationOnce(() =>
      JSON.stringify({
        schema: 1,
        kind: 'micromamba-working-cache-parent',
        userIdentity: 'alice'
      })
    )
    fsMocks.readFileSync.mockImplementationOnce(() =>
      JSON.stringify({
        schema: 1,
        canonicalRoot: 'd:\\open-science\\runtime',
        userIdentity: 'alice'
      })
    )
    const hardenOwnership = vi.fn()

    const cache = selectMicromambaCache(
      'D:\\Open-Science\\runtime',
      DEFAULT_MAX_CACHE_RELATIVE_PATH,
      {
        platform: 'win32',
        env: { USERNAME: 'alice', USERPROFILE: 'C:\\Users\\alice' },
        canonicalize: (path) => win32.normalize(path),
        hardenOwnership,
        verifyOwnership: () => true
      }
    )

    expect(cache.path).toMatch(/^D:\\Open-ScienceTmp\\m-/)
    expect(hardenOwnership).not.toHaveBeenCalled()
  })

  it('rejects both an untrusted primary parent and an untrusted per-user fallback', () => {
    fsMocks.lstatSync.mockImplementationOnce(
      () =>
        ({
          isDirectory: () => true,
          isSymbolicLink: () => false
        }) as never
    )
    fsMocks.readFileSync.mockImplementationOnce(() =>
      JSON.stringify({
        schema: 1,
        kind: 'micromamba-working-cache-parent',
        userIdentity: 'alice'
      })
    )
    const hardenOwnership = vi.fn(() => true)
    const verifyOwnership = vi.fn(() => false)

    expect(() =>
      selectMicromambaCache('D:\\Open-Science\\runtime', DEFAULT_MAX_CACHE_RELATIVE_PATH, {
        platform: 'win32',
        env: { USERNAME: 'alice', USERPROFILE: 'C:\\Users\\alice' },
        canonicalize: (path) => win32.normalize(path),
        hardenOwnership,
        verifyOwnership
      })
    ).toThrow(/temporary parent ownership or permissions are not trusted/i)

    // The third call is the fail-closed parent cleanup recheck; because it remains untrusted, the
    // shared parent is preserved instead of being recursively removed.
    expect(verifyOwnership).toHaveBeenCalledTimes(3)
    expect(hardenOwnership).toHaveBeenCalledOnce()
    expect(hardenOwnership).toHaveBeenCalledWith('C:\\Users\\alice\\os-tmp')
  })
})
