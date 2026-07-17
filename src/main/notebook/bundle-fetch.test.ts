import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { pkgsCache } from './runtime-paths'
import { DEFAULT_PYTHON_SPEC } from './provisioner'
import { fetchBundle, type BundleFetchDeps } from './bundle-fetch'

const makeRoot = (): string => mkdtempSync(join(tmpdir(), 'os-fetch-'))

// A fake CDN: the lock references one tarball whose content is "abc" (md5 known).
const okDownload =
  (mismatch = false): BundleFetchDeps['download'] =>
  async (url, dest) => {
    mkdirSync(dirname(dest), { recursive: true })
    if (url.endsWith('.lock')) {
      const md5 = mismatch ? 'deadbeef' : '900150983cd24fb0d6963f7d28e17f72'
      writeFileSync(
        dest,
        `@EXPLICIT\nhttps://conda.anaconda.org/conda-forge/noarch/numpy-1.0.conda#${md5}\n`
      )
    } else {
      writeFileSync(dest, 'abc') // md5("abc") = 900150983cd24fb0d6963f7d28e17f72
    }
  }

describe('fetchBundle', () => {
  it('downloads the lock + tarballs into the pkgs cache and returns the lock path', async () => {
    const root = makeRoot()
    const events: number[] = []
    const requested: string[] = []
    const deps: BundleFetchDeps = {
      cdnBase: 'https://cdn.example/envs',
      version: 1,
      download: async (url, dest) => {
        requested.push(url)
        await okDownload()(url, dest)
      }
    }
    const result = await fetchBundle(root, DEFAULT_PYTHON_SPEC, deps, (p) =>
      events.push(p.progress)
    )
    expect(result).toEqual({ lockPath: join(root, 'default-python.lock') })
    expect(readFileSync(join(pkgsCache(root), 'numpy-1.0.conda'), 'utf8')).toBe('abc')
    expect(requested[0]).toBe('https://cdn.example/envs/1/default-python.lock')
    expect(requested.some((u) => basename(u) === 'numpy-1.0.conda')).toBe(true)
    expect(events.at(-1)).toBeGreaterThan(0)
  })

  it('returns undefined when the lock is not published (online fallback)', async () => {
    const root = makeRoot()
    const deps: BundleFetchDeps = {
      cdnBase: 'https://cdn.example/envs',
      version: 1,
      download: async (url) => {
        if (url.endsWith('.lock')) throw new Error('404')
      }
    }
    expect(await fetchBundle(root, DEFAULT_PYTHON_SPEC, deps, () => {})).toBeUndefined()
  })

  it('returns undefined on a tarball md5 mismatch (online fallback) and drops the partial lock', async () => {
    const root = makeRoot()
    const deps: BundleFetchDeps = {
      cdnBase: 'https://cdn.example/envs',
      version: 1,
      download: okDownload(true)
    }
    expect(await fetchBundle(root, DEFAULT_PYTHON_SPEC, deps, () => {})).toBeUndefined()
    // The half-fetched lock must not linger — a later run should not treat it as a complete bundle.
    expect(existsSync(join(root, 'default-python.lock'))).toBe(false)
  })

  it('returns undefined when a tarball download rejects (online fallback)', async () => {
    const root = makeRoot()
    const deps: BundleFetchDeps = {
      cdnBase: 'https://cdn.example/envs',
      version: 1,
      download: async (url, dest) => {
        if (url.endsWith('.lock')) {
          await okDownload()(url, dest)
          return
        }
        throw new Error('tarball 503')
      }
    }
    expect(await fetchBundle(root, DEFAULT_PYTHON_SPEC, deps, () => {})).toBeUndefined()
    expect(existsSync(join(root, 'default-python.lock'))).toBe(false)
  })
})
