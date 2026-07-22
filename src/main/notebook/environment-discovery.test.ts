import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  collapseRscript,
  defaultCandidatePaths,
  defaultDiscoveryDeps,
  discoverInterpreters,
  type DiscoveryDeps
} from './environment-discovery'

describe('defaultDiscoveryDeps Windows conda R probes', () => {
  it('activates the interpreter own conda prefix for version and jsonlite probes', async () => {
    const prefix = 'C:\\Users\\HM\\OpenScience\\runtime\\envs\\default-r'
    const interpreter = `${prefix}\\Lib\\R\\bin\\R.exe`
    const exec = vi.fn(
      async (
        _file: string,
        args: readonly string[],
        options: { env?: NodeJS.ProcessEnv }
      ): Promise<{ stdout: string; stderr: string }> => {
        const expectedStart = [
          prefix,
          `${prefix}\\Library\\mingw-w64\\bin`,
          `${prefix}\\Library\\usr\\bin`,
          `${prefix}\\Library\\bin`,
          `${prefix}\\Scripts`,
          `${prefix}\\bin`
        ].join(';')
        expect(options.env?.PATH?.split(';').slice(0, 6).join(';')).toBe(expectedStart)
        return args.includes('--version')
          ? { stdout: '', stderr: 'R version 4.4.3 (2025-02-28 ucrt)' }
          : { stdout: 'TRUE', stderr: '' }
      }
    )
    const deps = defaultDiscoveryDeps('C:\\Users\\HM\\OpenScience\\runtime', undefined, {
      platform: 'win32',
      exec
    })

    await expect(deps.probeVersion(interpreter, 'r')).resolves.toBe('4.4.3')
    await expect(deps.rRunnable(interpreter)).resolves.toBe(true)
    expect(exec.mock.calls.map(([file]) => file)).toEqual([
      interpreter,
      `${prefix}\\Lib\\R\\bin\\Rscript.exe`
    ])
  })

  it('does not inject conda activation into an external Windows R installation', async () => {
    const interpreter = 'C:\\Program Files\\R\\R-4.4.3\\bin\\R.exe'
    const exec = vi.fn(
      async (
        _file: string,
        args: readonly string[],
        options: { env?: NodeJS.ProcessEnv }
      ): Promise<{ stdout: string; stderr: string }> => {
        expect(options.env).toBeUndefined()
        return args.includes('--version')
          ? { stdout: '', stderr: 'R version 4.4.3 (2025-02-28 ucrt)' }
          : { stdout: 'TRUE', stderr: '' }
      }
    )
    const deps = defaultDiscoveryDeps('C:\\Users\\HM\\OpenScience\\runtime', undefined, {
      platform: 'win32',
      exec
    })

    await expect(deps.probeVersion(interpreter, 'r')).resolves.toBe('4.4.3')
    await expect(deps.rRunnable(interpreter)).resolves.toBe(true)
  })
})

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

describe('defaultCandidatePaths Windows CRAN R detection', () => {
  it('discovers standard CRAN R installations in Program Files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-cran-'))
    const programFiles = join(root, 'Program Files', 'R')
    const r443Dir = join(programFiles, 'R-4.4.3', 'bin', 'x64')
    mkdirSync(r443Dir, { recursive: true })
    writeFileSync(join(r443Dir, 'R.exe'), 'x')
    writeFileSync(join(r443Dir, 'Rscript.exe'), 'x')

    // Override env to point to our fake Program Files and mock Windows platform
    const originalEnv = process.env.ProgramFiles
    const originalPlatform = process.platform
    process.env.ProgramFiles = join(root, 'Program Files')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const paths = await defaultCandidatePaths(root)('r')
      expect(paths).toContain(join(r443Dir, 'R.exe'))
      expect(paths).not.toContain(join(r443Dir, 'Rscript.exe'))
    } finally {
      process.env.ProgramFiles = originalEnv
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('discovers multiple R versions and prefers 64-bit over fallback layout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-multi-r-'))
    const programFiles = join(root, 'Program Files', 'R')

    // R 4.4.3 with 64-bit layout
    const r443x64 = join(programFiles, 'R-4.4.3', 'bin', 'x64')
    mkdirSync(r443x64, { recursive: true })
    writeFileSync(join(r443x64, 'R.exe'), 'x')

    // R 4.3.0 with fallback layout only
    const r430bin = join(programFiles, 'R-4.3.0', 'bin')
    mkdirSync(r430bin, { recursive: true })
    writeFileSync(join(r430bin, 'R.exe'), 'x')

    const originalEnv = process.env.ProgramFiles
    const originalPlatform = process.platform
    process.env.ProgramFiles = join(root, 'Program Files')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const paths = await defaultCandidatePaths(root)('r')
      expect(paths).toContain(join(r443x64, 'R.exe'))
      expect(paths).toContain(join(r430bin, 'R.exe'))
      expect(paths.length).toBeGreaterThanOrEqual(2)
    } finally {
      process.env.ProgramFiles = originalEnv
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('checks Program Files (x86) and LOCALAPPDATA for R installations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-r-paths-'))
    const programFilesx86 = join(root, 'Program Files (x86)', 'R')
    const localAppData = join(root, 'AppData', 'Local', 'Programs', 'R')

    // 32-bit R in Program Files (x86)
    const r32bit = join(programFilesx86, 'R-4.2.0', 'bin')
    mkdirSync(r32bit, { recursive: true })
    writeFileSync(join(r32bit, 'R.exe'), 'x')

    // User-local R in LOCALAPPDATA
    const rLocal = join(localAppData, 'R-4.4.0', 'bin', 'x64')
    mkdirSync(rLocal, { recursive: true })
    writeFileSync(join(rLocal, 'R.exe'), 'x')

    const original86 = process.env['ProgramFiles(x86)']
    const originalLocal = process.env.LOCALAPPDATA
    const originalPlatform = process.platform
    process.env['ProgramFiles(x86)'] = join(root, 'Program Files (x86)')
    process.env.LOCALAPPDATA = join(root, 'AppData', 'Local')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const paths = await defaultCandidatePaths(root)('r')
      expect(paths).toContain(join(r32bit, 'R.exe'))
      expect(paths).toContain(join(rLocal, 'R.exe'))
    } finally {
      if (original86 !== undefined) process.env['ProgramFiles(x86)'] = original86
      else delete process.env['ProgramFiles(x86)']
      if (originalLocal !== undefined) process.env.LOCALAPPDATA = originalLocal
      else delete process.env.LOCALAPPDATA
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ignores non-versioned directories in R root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-r-invalid-'))
    const programFiles = join(root, 'Program Files', 'R')

    // Valid R version
    const rValid = join(programFiles, 'R-4.4.1', 'bin', 'x64')
    mkdirSync(rValid, { recursive: true })
    writeFileSync(join(rValid, 'R.exe'), 'x')

    // Invalid directory names (should be skipped)
    mkdirSync(join(programFiles, 'docs'), { recursive: true })
    mkdirSync(join(programFiles, 'R-alpha'), { recursive: true })
    mkdirSync(join(programFiles, '4.4.1'), { recursive: true })

    const originalEnv = process.env.ProgramFiles
    const originalPlatform = process.platform
    process.env.ProgramFiles = join(root, 'Program Files')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const paths = await defaultCandidatePaths(root)('r')
      expect(paths).toContain(join(rValid, 'R.exe'))
      expect(paths.filter((p) => p.includes('docs')).length).toBe(0)
      expect(paths.filter((p) => p.includes('R-alpha')).length).toBe(0)
    } finally {
      process.env.ProgramFiles = originalEnv
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not run CRAN R detection for Python or on non-Windows platforms', async () => {
    const root = mkdtempSync(join(tmpdir(), 'os-no-r-'))
    const programFiles = join(root, 'Program Files', 'R')
    mkdirSync(join(programFiles, 'R-4.4.3', 'bin', 'x64'), { recursive: true })
    writeFileSync(join(programFiles, 'R-4.4.3', 'bin', 'x64', 'R.exe'), 'x')

    const originalEnv = process.env.ProgramFiles
    const originalPlatform = process.platform
    process.env.ProgramFiles = join(root, 'Program Files')
    try {
      // On Windows: Python should not scan R paths
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      const pythonPaths = await defaultCandidatePaths(root)('python')
      expect(pythonPaths.filter((p) => p.includes('R-4.4.3')).length).toBe(0)

      // On non-Windows: R should not enumerate CRAN Program Files roots
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      const rPaths = await defaultCandidatePaths(root)('r')
      expect(rPaths.filter((p) => p.includes('R-4.4.3')).length).toBe(0)
    } finally {
      process.env.ProgramFiles = originalEnv
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
      rmSync(root, { recursive: true, force: true })
    }
  })
})
