import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  effectiveMirrorAsync,
  type MirrorCandidate,
  pickFastestMirror,
  resetAutoMirrorCache
} from './mirror-probe'

const candidates: MirrorCandidate[] = [
  {
    name: 'public',
    mirror: {},
    probeUrl: 'https://public/conda-forge/repodata.json',
    biocondaProbeUrl: 'https://public/bioconda/repodata.json'
  },
  {
    name: 'tuna',
    mirror: { condaChannel: 'https://tuna/conda-forge/', pypiIndex: 'https://tuna/pypi' },
    probeUrl: 'https://tuna/conda-forge/repodata.json',
    biocondaProbeUrl: 'https://tuna/bioconda/repodata.json'
  },
  {
    name: 'aliyun',
    mirror: { condaChannel: 'https://aliyun/conda-forge/' },
    probeUrl: 'https://aliyun/conda-forge/repodata.json',
    biocondaProbeUrl: 'https://aliyun/bioconda/repodata.json'
  }
]

const reachableLatencies = {
  'https://public/conda-forge/repodata.json': 300,
  'https://public/bioconda/repodata.json': 320,
  'https://tuna/conda-forge/repodata.json': 40,
  'https://tuna/bioconda/repodata.json': 50,
  'https://aliyun/conda-forge/repodata.json': 120,
  'https://aliyun/bioconda/repodata.json': 130
}

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
  it('returns the fastest candidate whose conda-forge and bioconda channels respond', async () => {
    const result = await pickFastestMirror({
      candidates,
      probe: probeFrom(reachableLatencies)
    })
    expect(result).toEqual({
      condaChannel: 'https://tuna/conda-forge/',
      pypiIndex: 'https://tuna/pypi'
    })
  })

  it('skips a candidate when its bioconda channel is unreachable', async () => {
    const result = await pickFastestMirror({
      candidates,
      probe: probeFrom({
        ...reachableLatencies,
        'https://tuna/bioconda/repodata.json': null
      })
    })
    expect(result).toEqual({ condaChannel: 'https://aliyun/conda-forge/' })
  })

  it('skips a candidate when its conda-forge channel is unreachable', async () => {
    const result = await pickFastestMirror({
      candidates,
      probe: probeFrom({
        ...reachableLatencies,
        'https://tuna/conda-forge/repodata.json': null
      })
    })
    expect(result).toEqual({ condaChannel: 'https://aliyun/conda-forge/' })
  })

  it('scores each candidate by its slower required channel', async () => {
    const result = await pickFastestMirror({
      candidates,
      probe: probeFrom({
        'https://public/conda-forge/repodata.json': 10,
        'https://public/bioconda/repodata.json': 300,
        'https://tuna/conda-forge/repodata.json': 100,
        'https://tuna/bioconda/repodata.json': 100,
        'https://aliyun/conda-forge/repodata.json': 120,
        'https://aliyun/bioconda/repodata.json': 120
      })
    })
    expect(result).toEqual({
      condaChannel: 'https://tuna/conda-forge/',
      pypiIndex: 'https://tuna/pypi'
    })
  })

  it('returns undefined when no candidate has a reachable bioconda channel', async () => {
    const result = await pickFastestMirror({
      candidates,
      probe: probeFrom({
        'https://public/conda-forge/repodata.json': 300,
        'https://tuna/conda-forge/repodata.json': 40,
        'https://aliyun/conda-forge/repodata.json': 120
      })
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
      probe: probeFrom(reachableLatencies)
    })
    expect(result.condaChannel).toBe('https://tuna/conda-forge/')
  })

  it('falls back to the locale default when no complete channel pair responds', async () => {
    const result = await effectiveMirrorAsync(undefined, 'zh-CN', {
      candidates,
      probe: probeFrom({
        'https://public/conda-forge/repodata.json': 300,
        'https://tuna/conda-forge/repodata.json': 40,
        'https://aliyun/conda-forge/repodata.json': 120
      })
    })
    // No candidate has a reachable bioconda channel -> zh-CN locale default (TUNA).
    expect(result.condaChannel).toContain('tuna')
  })

  it('preserves a caBundle-only config while still using the fastest-probed channel', async () => {
    const result = await effectiveMirrorAsync({ caBundle: '/etc/corp-ca.pem' }, 'en-US', {
      candidates,
      probe: probeFrom(reachableLatencies)
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
