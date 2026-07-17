import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  effectiveMirrorAsync,
  type MirrorCandidate,
  pickFastestMirror,
  resetAutoMirrorCache
} from './mirror-probe'

const candidates: MirrorCandidate[] = [
  { name: 'public', mirror: {}, probeUrl: 'https://public/repodata.json' },
  {
    name: 'tuna',
    mirror: { condaChannel: 'https://tuna/conda-forge/', pypiIndex: 'https://tuna/pypi' },
    probeUrl: 'https://tuna/repodata.json'
  },
  {
    name: 'aliyun',
    mirror: { condaChannel: 'https://aliyun/conda-forge/' },
    probeUrl: 'https://aliyun/repodata.json'
  }
]

// A probe that returns per-URL latencies from a table; a missing/`null` entry rejects (unreachable).
const probeFrom =
  (latency: Record<string, number | null>) =>
  async (url: string): Promise<number> => {
    const ms = latency[url]
    if (ms == null) throw new Error('unreachable')
    return ms
  }

afterEach(() => resetAutoMirrorCache())

describe('pickFastestMirror', () => {
  it('returns the mirror of the fastest reachable candidate', async () => {
    const result = await pickFastestMirror({
      candidates,
      probe: probeFrom({
        'https://public/repodata.json': 300,
        'https://tuna/repodata.json': 40,
        'https://aliyun/repodata.json': 120
      })
    })
    expect(result).toEqual({
      condaChannel: 'https://tuna/conda-forge/',
      pypiIndex: 'https://tuna/pypi'
    })
  })

  it('skips unreachable candidates and picks the fastest that responds', async () => {
    const result = await pickFastestMirror({
      candidates,
      probe: probeFrom({
        'https://public/repodata.json': null, // unreachable
        'https://tuna/repodata.json': null, // unreachable
        'https://aliyun/repodata.json': 120
      })
    })
    expect(result).toEqual({ condaChannel: 'https://aliyun/conda-forge/' })
  })

  it('returns undefined when nothing responds', async () => {
    const result = await pickFastestMirror({
      candidates,
      probe: probeFrom({})
    })
    expect(result).toBeUndefined()
  })
})

describe('effectiveMirrorAsync', () => {
  it('returns the user override without probing', async () => {
    const probe = vi.fn()
    const result = await effectiveMirrorAsync({ condaChannel: 'https://corp/conda' }, 'en-US', {
      candidates,
      probe
    })
    expect(result).toEqual({ condaChannel: 'https://corp/conda' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('uses the fastest-probed mirror when there is no override', async () => {
    const result = await effectiveMirrorAsync(undefined, 'en-US', {
      candidates,
      probe: probeFrom({
        'https://public/repodata.json': 300,
        'https://tuna/repodata.json': 40,
        'https://aliyun/repodata.json': 120
      })
    })
    expect(result.condaChannel).toBe('https://tuna/conda-forge/')
  })

  it('falls back to the locale default when the probe finds nothing', async () => {
    const result = await effectiveMirrorAsync(undefined, 'zh-CN', {
      candidates,
      probe: probeFrom({})
    })
    // No reachable mirror -> zh-CN locale default (TUNA) from the sync effectiveMirror.
    expect(result.condaChannel).toContain('tuna')
  })

  it('preserves a caBundle-only config while still using the fastest-probed channel', async () => {
    const result = await effectiveMirrorAsync({ caBundle: '/etc/corp-ca.pem' }, 'en-US', {
      candidates,
      probe: probeFrom({
        'https://public/repodata.json': 300,
        'https://tuna/repodata.json': 40,
        'https://aliyun/repodata.json': 120
      })
    })
    expect(result.condaChannel).toBe('https://tuna/conda-forge/')
    expect(result.caBundle).toBe('/etc/corp-ca.pem')
  })

  it('preserves a caBundle-only config on the locale fallback when the probe finds nothing', async () => {
    const result = await effectiveMirrorAsync({ caBundle: '/etc/corp-ca.pem' }, 'zh-CN', {
      candidates,
      probe: probeFrom({})
    })
    expect(result.caBundle).toBe('/etc/corp-ca.pem')
  })

  it('keeps caBundle on a configured channel override', async () => {
    const probe = vi.fn()
    const result = await effectiveMirrorAsync(
      { condaChannel: 'https://corp/conda', caBundle: '/etc/corp-ca.pem' },
      'en-US',
      { candidates, probe }
    )
    expect(result).toEqual({ condaChannel: 'https://corp/conda', caBundle: '/etc/corp-ca.pem' })
    expect(probe).not.toHaveBeenCalled()
  })
})
