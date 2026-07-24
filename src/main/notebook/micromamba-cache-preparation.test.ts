import { win32 } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const fsMocks = vi.hoisted(() => {
  const native = vi.fn((path: string) => path)
  const realpathSync = Object.assign(
    vi.fn((path: string) => path),
    { native }
  )
  return {
    lstatSync: vi.fn(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    }),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    realpathSync,
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
      'D:\\OpenScience\\runtime',
      DEFAULT_MAX_CACHE_RELATIVE_PATH,
      deps
    )

    expect(cache.path).toMatch(/^D:\\osp[0-9a-f]{10}$/)
    expect(hardenOwnership).toHaveBeenCalledOnce()
    expect(hardenOwnership).toHaveBeenCalledWith(cache.path)
    expect(hardenOwnership.mock.invocationCallOrder[0]).toBeLessThan(
      fsMocks.writeFileSync.mock.invocationCallOrder[0]
    )
    expect(hardenOwnership.mock.invocationCallOrder[0]).toBeLessThan(
      verifyOwnership.mock.invocationCallOrder[0]
    )
  })

  it('removes newly created candidates when ACL hardening fails', () => {
    const hardenOwnership = vi.fn(() => {
      throw new Error('Set-Acl denied')
    })

    expect(() =>
      selectMicromambaCache('D:\\OpenScience\\runtime', DEFAULT_MAX_CACHE_RELATIVE_PATH, {
        platform: 'win32',
        env: { USERNAME: 'alice', USERPROFILE: 'C:\\Users\\alice' },
        canonicalize: (path) => win32.normalize(path),
        hardenOwnership,
        verifyOwnership: () => true
      })
    ).toThrow(/cache ACL could not be hardened \(Set-Acl denied\)/)

    expect(hardenOwnership).toHaveBeenCalledTimes(3)
    expect(fsMocks.rmSync).toHaveBeenCalledTimes(3)
    for (const [path, options] of fsMocks.rmSync.mock.calls) {
      expect(path).toMatch(/^(D:\\|C:\\Users\\alice\\)os/)
      expect(options).toEqual({ recursive: true, force: true })
    }
  })

  it('does not harden or take over an existing marked candidate', () => {
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
        canonicalRoot: 'd:\\openscience\\runtime',
        userIdentity: 'alice'
      })
    )
    const hardenOwnership = vi.fn()

    const cache = selectMicromambaCache(
      'D:\\OpenScience\\runtime',
      DEFAULT_MAX_CACHE_RELATIVE_PATH,
      {
        platform: 'win32',
        env: { USERNAME: 'alice', USERPROFILE: 'C:\\Users\\alice' },
        canonicalize: (path) => win32.normalize(path),
        hardenOwnership,
        verifyOwnership: () => true
      }
    )

    expect(cache.path).toMatch(/^D:\\osp/)
    expect(hardenOwnership).not.toHaveBeenCalled()
  })
})
