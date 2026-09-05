import { afterEach, describe, expect, it, vi } from 'vitest'

import { netFetchStandard } from '../skills/net-fetch'

import {
  DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
  buildNotebookNetworkPolicy,
  domainPatternMatches
} from '../../shared/notebook-network'
import {
  MIRROR_CANDIDATES,
  effectiveMirrorAsync,
  type MirrorCandidate,
  pickFastestMirror,
  resetAutoMirrorCache
} from './mirror-probe'

vi.mock('../skills/net-fetch', () => ({ netFetchStandard: vi.fn() }))

const candidates: MirrorCandidate[] = [
  {
    name: 'public',
    mirror: {},
    probeUrl: 'https://public/conda-forge/repodata.json',
    biocondaProbeUrl: 'https://public/bioconda/repodata.json',
    trustedDomains: ['public']
  },
  {
    name: 'tuna',
    mirror: { condaChannel: 'https://tuna/conda-forge/', pypiIndex: 'https://tuna/pypi' },
    probeUrl: 'https://tuna/conda-forge/repodata.json',
    biocondaProbeUrl: 'https://tuna/bioconda/repodata.json',
    trustedDomains: ['tuna']
  },
  {
    name: 'aliyun',
    mirror: { condaChannel: 'https://aliyun/conda-forge/' },
    probeUrl: 'https://aliyun/conda-forge/repodata.json',
    biocondaProbeUrl: 'https://aliyun/bioconda/repodata.json',
    trustedDomains: ['aliyun']
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
  it('keeps every automatic package mirror reachable through the default network policy', () => {
    const policy = buildNotebookNetworkPolicy(DEFAULT_NOTEBOOK_NETWORK_SETTINGS)
    const automaticMirrorHosts = MIRROR_CANDIDATES.flatMap((candidate) =>
      [
        ...candidate.trustedDomains,
        candidate.probeUrl,
        candidate.biocondaProbeUrl,
        candidate.mirror.condaChannel,
        candidate.mirror.pypiIndex,
        candidate.mirror.cranMirror
      ]
        .filter((url): url is string => Boolean(url))
        .map((url) => (url.includes('://') ? new URL(url).hostname : url))
    )

    expect(
      automaticMirrorHosts.filter(
        (hostname) =>
          !policy.allowedDomains.some((pattern) => domainPatternMatches(pattern, hostname))
      )
    ).toEqual([])
    expect(
      MIRROR_CANDIDATES.every((candidate) => candidate.probeUrl.endsWith('current_repodata.json'))
    ).toBe(true)
    expect(
      MIRROR_CANDIDATES.every((candidate) =>
        candidate.biocondaProbeUrl.endsWith('current_repodata.json')
      )
    ).toBe(true)
    expect(
      MIRROR_CANDIDATES.find((candidate) => candidate.name === 'ustc')?.trustedDomains
    ).toContain('mirrors.nju.edu.cn')
    expect(
      policy.allowedDomains.some((pattern) => domainPatternMatches(pattern, 'redirect.invalid'))
    ).toBe(false)
  })

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

  it('accepts the USTC to NJU redirect only when NJU is explicitly trusted', async () => {
    const ustc = {
      name: 'ustc',
      mirror: { condaChannel: 'https://mirrors.ustc.edu.cn/anaconda/cloud/conda-forge/' },
      probeUrl:
        'https://mirrors.ustc.edu.cn/anaconda/cloud/conda-forge/noarch/current_repodata.json',
      biocondaProbeUrl:
        'https://mirrors.ustc.edu.cn/anaconda/cloud/bioconda/noarch/current_repodata.json',
      trustedDomains: ['mirrors.ustc.edu.cn']
    }
    const official = {
      name: 'public',
      mirror: { condaChannel: 'https://conda.anaconda.org/conda-forge/' },
      probeUrl: 'https://conda.anaconda.org/conda-forge/noarch/current_repodata.json',
      biocondaProbeUrl: 'https://conda.anaconda.org/bioconda/noarch/current_repodata.json',
      trustedDomains: ['conda.anaconda.org']
    }
    vi.mocked(netFetchStandard).mockImplementation(async (url) => {
      const requested = String(url)
      const finalUrl = requested.includes('mirrors.ustc.edu.cn')
        ? requested.replace('mirrors.ustc.edu.cn', 'mirrors.nju.edu.cn')
        : requested
      return { ok: true, status: 200, url: finalUrl } as Response
    })

    await expect(pickFastestMirror({ candidates: [ustc, official] })).resolves.toEqual(
      official.mirror
    )
    await expect(
      pickFastestMirror({
        candidates: [
          { ...ustc, trustedDomains: [...ustc.trustedDomains, 'mirrors.nju.edu.cn'] },
          official
        ]
      })
    ).resolves.toEqual(ustc.mirror)
    expect(vi.mocked(netFetchStandard).mock.calls.map(([url]) => String(url))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/conda-forge/noarch/current_repodata.json'),
        expect.stringContaining('/bioconda/noarch/current_repodata.json')
      ])
    )
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
