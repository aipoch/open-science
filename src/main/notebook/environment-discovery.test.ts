import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  collapseRscript,
  defaultCandidatePaths,
  discoverInterpreters,
  type DiscoveryDeps
} from './environment-discovery'

// Orchestration-only test (real enumerators are injected): dedup by realpath, provenance
// classification, and python-vs-r runnability. Uses fake paths so no real machine is touched.
const makeDeps = (
  paths: string[],
  opts: {
    versions?: Record<string, string>
    rRunnable?: Record<string, boolean>
    realpath?: Record<string, string>
  } = {}
): DiscoveryDeps => ({
  candidatePaths: async () => paths,
  probeVersion: async (p) => opts.versions?.[p],
  rRunnable: async (p) => opts.rRunnable?.[p] ?? false,
  realpath: (p) => opts.realpath?.[p] ?? p,
  runtimeRoot: '/rt'
})

describe('discoverInterpreters', () => {
  it('classifies provenance and dedupes python interpreters by real path', async () => {
    const deps = makeDeps(
      ['/usr/bin/python3', '/rt/envs/default-python/bin/python', '/a/python', '/b/python'],
      {
        versions: {
          '/usr/bin/python3': '3.9.6',
          '/rt/envs/default-python/bin/python': '3.12.4',
          '/a/python': '3.11.0'
        },
        // /a and /b are the same interpreter via symlink → one entry.
        realpath: { '/a/python': '/canon/python', '/b/python': '/canon/python' }
      }
    )
    const found = await discoverInterpreters('python', deps)

    expect(found).toHaveLength(3) // /a and /b collapsed
    const byId = Object.fromEntries(found.map((f) => [f.envId, f]))
    expect(byId['/usr/bin/python3'].provenance).toBe('user-own')
    expect(byId['/rt/envs/default-python/bin/python'].provenance).toBe('app-managed')
    expect(byId['/canon/python'].runnable).toBe(true)
    // A python that does not report a version is not runnable and carries an actionable detail.
    const notPy3 = await discoverInterpreters('python', makeDeps(['/x/python2'], {}))
    expect(notPy3[0].runnable).toBe(false)
    expect(notPy3[0].detail).toMatch(/Python 3/)
  })

  it('flags an agent-created named env and marks a conda R needing jsonlite', async () => {
    const deps = makeDeps(['/rt/envs/my-analysis/bin/R', '/opt/miniconda3/envs/bio/bin/R'], {
      versions: {
        '/rt/envs/my-analysis/bin/R': '4.4.1',
        '/opt/miniconda3/envs/bio/bin/R': '4.3.2'
      },
      rRunnable: { '/rt/envs/my-analysis/bin/R': true } // the conda one lacks jsonlite
    })
    const found = await discoverInterpreters('r', deps)
    const byId = Object.fromEntries(found.map((f) => [f.envId, f]))

    expect(byId['/rt/envs/my-analysis/bin/R'].provenance).toBe('agent-created')
    expect(byId['/rt/envs/my-analysis/bin/R'].runnable).toBe(true)
    const condaR = byId['/opt/miniconda3/envs/bio/bin/R']
    expect(condaR.provenance).toBe('user-own')
    expect(condaR.condaEnv).toBe('bio')
    expect(condaR.runnable).toBe(false)
    expect(condaR.detail).toMatch(/jsonlite/)
  })

  it('bounds probe concurrency with a worker pool yet discovers every env in input order', async () => {
    // Many distinct interpreters — enough to overflow the pool and make a spawn storm observable.
    const paths = Array.from({ length: 30 }, (_, i) => `/envs/py-${i}/bin/python`)
    let inFlight = 0
    let maxInFlight = 0
    // A probeVersion that tracks concurrent in-flight calls: overlap is only observable if each call
    // stays open across a real (tiny) delay, so the pool's cap can actually bite.
    const deps: DiscoveryDeps = {
      candidatePaths: async () => paths,
      probeVersion: async (p) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight -= 1
        return `3.${p.match(/py-(\d+)/)![1]}.0`
      },
      rRunnable: async () => false,
      realpath: (p) => p,
      runtimeRoot: '/rt'
    }

    const found = await discoverInterpreters('python', deps)

    // The delay must actually produce overlap, else the cap assertion is vacuous.
    expect(maxInFlight).toBeGreaterThan(1)
    // PROBE_CONCURRENCY is a non-exported module const (currently 8); the worker pool must never let
    // more than that many probes run at once, no matter how many envs are present.
    expect(maxInFlight).toBeLessThanOrEqual(8)
    // No candidate is dropped, and results map 1:1 to the input candidate order (written back by index).
    expect(found).toHaveLength(30)
    expect(found.map((f) => f.interpreterPath)).toEqual(paths)
    expect(found.map((f) => f.version)).toEqual(paths.map((_, i) => `3.${i}.0`))
  })
})

describe('collapseRscript', () => {
  it('drops a Rscript whose sibling R is also present (one R install = one env)', () => {
    expect(collapseRscript(['/usr/local/bin/R', '/usr/local/bin/Rscript']).sort()).toEqual([
      '/usr/local/bin/R'
    ])
  })

  it('keeps a lone Rscript with no sibling R, and never touches python/R entries', () => {
    expect(collapseRscript(['/opt/only/bin/Rscript'])).toEqual(['/opt/only/bin/Rscript'])
    expect(
      collapseRscript(['/usr/bin/python3', '/usr/local/bin/R', '/usr/local/bin/Rscript']).sort()
    ).toEqual(['/usr/bin/python3', '/usr/local/bin/R'])
  })

  it('collapses the Windows R.exe / Rscript.exe pair too', () => {
    expect(collapseRscript(['C:\\R\\bin\\R.exe', 'C:\\R\\bin\\Rscript.exe'])).toEqual([
      'C:\\R\\bin\\R.exe'
    ])
  })
})

describe('defaultCandidatePaths (targeted enumeration)', () => {
  it('includes manually-added interpreters and the app-managed default, and collapses R/Rscript', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-disc-'))
    // App-managed default-r on disk under runtime/envs.
    const rPrefix = join(root, 'envs', 'default-r', 'bin')
    mkdirSync(rPrefix, { recursive: true })
    writeFileSync(join(rPrefix, 'R'), 'x')
    writeFileSync(join(rPrefix, 'Rscript'), 'x') // sibling — must be collapsed away
    // A manually-added R that is not on PATH.
    const manualR = join(root, 'custom', 'R')
    mkdirSync(join(root, 'custom'), { recursive: true })
    writeFileSync(manualR, 'x')

    const paths = await defaultCandidatePaths(root, () => [manualR])('r')

    expect(paths).toContain(join(rPrefix, 'R'))
    expect(paths).toContain(manualR)
    // The app default's Rscript sibling is collapsed (only its R remains).
    expect(paths).not.toContain(join(rPrefix, 'Rscript'))
    rmSync(root, { recursive: true, force: true })
  })
})
