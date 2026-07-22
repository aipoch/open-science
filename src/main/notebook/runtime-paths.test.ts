import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  assertSafeEnvName,
  DEFAULT_ENV_VERSION,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  envDirectoryName,
  legacyDefaultEnvPrefix,
  logicalEnvNameFromDirectory,
  windowsDefaultEnvPrefixReserve,
  needsRepair,
  pkgsCache,
  pipBin,
  pythonBin,
  pythonReady,
  rBin,
  rMaterialized,
  rLibraryDir,
  resolveEnvName,
  rReady,
  readRReadyMarker,
  readReadyMarker,
  readyMarkerPath,
  rScriptBin,
  writeRReadyMarker,
  resolveRuntimeCdnBase,
  runtimeSubdir,
  runtimePackDir,
  runtimeRoot,
  writeReadyMarker,
  addRepairRequired,
  clearRepairRequired,
  condaActivatedPath,
  isRepairRequired,
  readRepairRequired
} from './runtime-paths'

const tmpRoots: string[] = []
const makeRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'os-runtime-'))
  tmpRoots.push(dir)
  return dir
}
// Materializes a fake interpreter file so bin-presence checks pass.
const touchBin = (path: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'x')
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    // best-effort cleanup; ignore failures
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* noop */
    }
  }
})

describe('runtime-paths layout', () => {
  it('composes the runtime layout', () => {
    // Build expected paths with the host separator + platform-specific interpreter layout so the
    // assertions hold on Windows (Scripts\, python.exe, Lib\R\bin) as well as POSIX.
    const isWin = process.platform === 'win32'
    expect(runtimeRoot('/store')).toBe(join('/store', 'runtime'))
    expect(envPrefix('/r', DEFAULT_PY_ENV)).toBe(join('/r', 'envs', 'default-python'))
    expect(pkgsCache('/r')).toBe(join('/r', 'pkgs'))
    expect(pythonBin('/r/envs/default-python')).toBe(
      isWin
        ? join('/r/envs/default-python', 'python.exe')
        : join('/r/envs/default-python', 'bin', 'python')
    )
    expect(rBin('/r/envs/default-r')).toBe(
      isWin
        ? join('/r/envs/default-r', 'Lib', 'R', 'bin', 'R.exe')
        : join('/r/envs/default-r', 'bin', 'R')
    )
    expect(rScriptBin('/e')).toBe(
      isWin ? join('/e', 'Lib', 'R', 'bin', 'Rscript.exe') : join('/e', 'bin', 'Rscript')
    )
    expect(readyMarkerPath('/r')).toBe(join('/r', '.env-ready'))
    expect(DEFAULT_ENV_VERSION).toBe(1)
    expect(DEFAULT_R_ENV).toBe('default-r')
  })

  it('uses short reserved physical directories for Windows defaults', () => {
    expect(envDirectoryName(DEFAULT_PY_ENV, 'win32')).toBe('.p')
    expect(envDirectoryName(DEFAULT_R_ENV, 'win32')).toBe('.r')
    expect(envDirectoryName('my-analysis', 'win32')).toBe('my-analysis')
    expect(logicalEnvNameFromDirectory('.p')).toBe(DEFAULT_PY_ENV)
    expect(logicalEnvNameFromDirectory('.R')).toBe(DEFAULT_R_ENV)
    expect(logicalEnvNameFromDirectory('my-analysis')).toBe('my-analysis')
    expect(envPrefix('/runtime', DEFAULT_PY_ENV, 'win32')).toBe(join('/runtime', 'envs', '.p'))
    expect(envPrefix('/runtime', DEFAULT_R_ENV, 'win32')).toBe(join('/runtime', 'envs', '.r'))
    expect(windowsDefaultEnvPrefixReserve()).toBe('runtime\\envs\\.p'.length + 1)
  })

  it('uses marker provenance to distinguish committed legacy and short Windows prefixes', () => {
    const root = makeRoot()
    const short = join(root, 'envs', '.p')
    const legacy = legacyDefaultEnvPrefix(root, DEFAULT_PY_ENV)

    expect(envPrefix(root, DEFAULT_PY_ENV, 'win32')).toBe(short)
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'python.exe'), 'partial')
    expect(envPrefix(root, DEFAULT_PY_ENV, 'win32')).toBe(short)

    writeReadyMarker(root, DEFAULT_ENV_VERSION, 'ready')
    expect(envPrefix(root, DEFAULT_PY_ENV, 'win32')).toBe(legacy)

    mkdirSync(short, { recursive: true })
    expect(envPrefix(root, DEFAULT_PY_ENV, 'win32')).toBe(legacy)

    writeReadyMarker(root, DEFAULT_ENV_VERSION, 'short-ready', '.p')
    expect(envPrefix(root, DEFAULT_PY_ENV, 'win32')).toBe(short)
  })

  it('preserves a legacy R prefix beside a partial short directory until .r is committed', () => {
    const root = makeRoot()
    const short = join(root, 'envs', '.r')
    const legacy = legacyDefaultEnvPrefix(root, DEFAULT_R_ENV)
    touchBin(join(legacy, 'Lib', 'R', 'bin', 'R.exe'))
    mkdirSync(short, { recursive: true })

    expect(envPrefix(root, DEFAULT_R_ENV, 'win32')).toBe(legacy)

    writeRReadyMarker(root, DEFAULT_ENV_VERSION, 'short-ready', '.r')
    expect(envPrefix(root, DEFAULT_R_ENV, 'win32')).toBe(short)
  })

  it('builds the complete Windows conda DLL search path ahead of the inherited PATH', () => {
    expect(condaActivatedPath('C:\\runtime\\envs\\default-r', 'C:\\Windows', 'win32')).toBe(
      [
        'C:\\runtime\\envs\\default-r',
        'C:\\runtime\\envs\\default-r\\Library\\mingw-w64\\bin',
        'C:\\runtime\\envs\\default-r\\Library\\usr\\bin',
        'C:\\runtime\\envs\\default-r\\Library\\bin',
        'C:\\runtime\\envs\\default-r\\Scripts',
        'C:\\runtime\\envs\\default-r\\bin',
        'C:\\Windows'
      ].join(';')
    )
  })

  it('keeps the existing POSIX env bin prefix behavior', () => {
    expect(condaActivatedPath('/runtime/envs/default-r', '/usr/bin', 'darwin')).toBe(
      '/runtime/envs/default-r/bin:/usr/bin'
    )
  })
})

describe('runtime CDN platform mapping', () => {
  it.each([
    ['darwin', 'arm64', 'osx-arm64'],
    ['darwin', 'x64', 'osx-64'],
    ['linux', 'x64', 'linux-64'],
    ['win32', 'x64', 'win-64']
  ] as const)('%s/%s maps to %s', (platform, arch, expected) => {
    expect(runtimeSubdir(platform, arch)).toBe(expected)
  })

  it.each([
    ['linux', 'arm64'], // never published — must reject, not map to a 404-ing linux-aarch64
    ['win32', 'arm64'],
    ['freebsd', 'x64']
  ] as const)('rejects the unpublished platform %s/%s', (platform, arch) => {
    expect(() => runtimeSubdir(platform, arch)).toThrow(/Unsupported notebook runtime platform/)
  })

  it('trims CDN base overrides without changing the path namespace', () => {
    expect(resolveRuntimeCdnBase('https://cdn.example/open-science///')).toBe(
      'https://cdn.example/open-science'
    )
  })

  it('namespaces a pack by envVersion and subdir', () => {
    expect(runtimePackDir('/runtime', 1, 'osx-arm64', 'python-3.12')).toBe(
      join('/runtime', 'packs', '1', 'osx-arm64', 'python-3.12')
    )
    expect(runtimePackDir('/runtime', 2, 'osx-arm64', 'python-3.12')).not.toBe(
      runtimePackDir('/runtime', 1, 'osx-arm64', 'python-3.12')
    )
  })
})

describe('.env-ready marker', () => {
  it('roundtrips as camelCase JSON', () => {
    const root = makeRoot()
    writeReadyMarker(root, 3, '1720000000000')
    const body = readFileSync(readyMarkerPath(root), 'utf8')
    expect(body).toContain('"defaultEnvVersion"')
    expect(body).toContain('"preparedAt"')
    const marker = readReadyMarker(root)
    expect(marker).toEqual({ defaultEnvVersion: 3, preparedAt: '1720000000000' })
  })

  it('roundtrips optional Windows prefix provenance', () => {
    const root = makeRoot()
    writeReadyMarker(root, 3, '1720000000000', '.p')
    writeRReadyMarker(root, 3, '1720000000001', '.r')

    expect(readReadyMarker(root)).toEqual({
      defaultEnvVersion: 3,
      preparedAt: '1720000000000',
      prefixDirectory: '.p'
    })
    expect(readRReadyMarker(root)).toEqual({
      defaultEnvVersion: 3,
      preparedAt: '1720000000001',
      prefixDirectory: '.r'
    })
  })

  it('returns undefined when absent or corrupt', () => {
    const root = makeRoot()
    expect(readReadyMarker(root)).toBeUndefined()
    writeFileSync(readyMarkerPath(root), 'not json')
    expect(readReadyMarker(root)).toBeUndefined()
  })
})

describe('readiness gates', () => {
  it('pythonReady requires marker version >= expected and the python bin', () => {
    const root = makeRoot()
    expect(pythonReady(root, 1)).toBe(false)
    touchBin(pythonBin(envPrefix(root, DEFAULT_PY_ENV)))
    expect(pythonReady(root, 1)).toBe(false) // no marker
    writeReadyMarker(root, 1, 't')
    expect(pythonReady(root, 2)).toBe(false) // marker too old
    expect(pythonReady(root, 1)).toBe(true)
  })

  it('rReady requires its own current-version marker and interpreter', () => {
    const root = makeRoot()
    expect(rReady(root)).toBe(false)
    touchBin(rBin(envPrefix(root, DEFAULT_R_ENV)))
    expect(rMaterialized(root)).toBe(true)
    expect(rReady(root)).toBe(false)
    writeRReadyMarker(root, DEFAULT_ENV_VERSION - 1, 'old')
    expect(rReady(root)).toBe(false)
    writeRReadyMarker(root, DEFAULT_ENV_VERSION, 'now')
    expect(rReady(root)).toBe(true)
  })

  it('needsRepair is false on empty root and true on stale residue', () => {
    const root = makeRoot()
    expect(needsRepair(root, DEFAULT_ENV_VERSION)).toBe(false)
    writeReadyMarker(root, DEFAULT_ENV_VERSION - 1, 't')
    mkdirSync(envPrefix(root, DEFAULT_PY_ENV), { recursive: true })
    expect(needsRepair(root, DEFAULT_ENV_VERSION)).toBe(true)
  })

  it('needsRepair is false once ready', () => {
    const root = makeRoot()
    touchBin(pythonBin(envPrefix(root, DEFAULT_PY_ENV)))
    writeReadyMarker(root, DEFAULT_ENV_VERSION, 't')
    expect(existsSync(readyMarkerPath(root))).toBe(true)
    expect(needsRepair(root, DEFAULT_ENV_VERSION)).toBe(false)
  })
})

describe('resolveEnvName', () => {
  it('falls back to the default env when omitted or blank', () => {
    expect(resolveEnvName('python')).toBe(DEFAULT_PY_ENV)
    expect(resolveEnvName('python', undefined)).toBe(DEFAULT_PY_ENV)
    expect(resolveEnvName('python', '  ')).toBe(DEFAULT_PY_ENV)
    expect(resolveEnvName('r')).toBe(DEFAULT_R_ENV)
    expect(resolveEnvName('r', '')).toBe(DEFAULT_R_ENV)
  })

  it('aliases the bare spec-compat names to the matching default env', () => {
    expect(resolveEnvName('python', 'python')).toBe(DEFAULT_PY_ENV)
    expect(resolveEnvName('r', 'r')).toBe(DEFAULT_R_ENV)
  })

  it('returns a valid custom name unchanged', () => {
    expect(resolveEnvName('python', 'my-analysis')).toBe('my-analysis')
  })

  it('rejects unsafe or traversal-prone names', () => {
    // Note: '' resolves to the default env (empty is treated as omitted, not invalid) — see the
    // fallback test above; only genuinely unsafe segments throw here.
    for (const bad of ['..', '../evil', '.hidden', 'a/b']) {
      expect(() => resolveEnvName('python', bad)).toThrow(/Invalid environment name/)
    }
  })
})

describe('assertSafeEnvName (manage_environments name guard)', () => {
  it('accepts a valid custom name and returns it', () => {
    expect(assertSafeEnvName('my-analysis')).toBe('my-analysis')
  })

  it('rejects a missing/empty name', () => {
    expect(() => assertSafeEnvName(undefined)).toThrow(/name is required/)
    expect(() => assertSafeEnvName('   ')).toThrow(/name is required/)
  })

  it('rejects path traversal and unsafe segments (security: no escaping runtime/envs)', () => {
    for (const bad of ['..', '../../../../Users/eweno/Documents', 'a/b', '.hidden', 'a..b/../x']) {
      expect(() => assertSafeEnvName(bad)).toThrow(/Invalid environment name/)
    }
  })

  it('rejects reserved/alias/default names (never aliases, unlike resolveEnvName)', () => {
    for (const reserved of ['python', 'r', DEFAULT_PY_ENV, DEFAULT_R_ENV]) {
      expect(() => assertSafeEnvName(reserved)).toThrow(/reserved environment name/)
    }
  })
})

describe('platform-aware interpreter paths', () => {
  const original = process.platform
  const setPlatform = (value: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', { value, configurable: true })
  }
  afterEach(() => setPlatform(original))

  it('uses the Unix bin/ layout on darwin/linux', () => {
    setPlatform('linux')
    const p = '/root/envs/e'
    expect(pythonBin(p)).toBe(join(p, 'bin', 'python'))
    expect(pipBin(p)).toBe(join(p, 'bin', 'pip'))
    expect(rBin(p)).toBe(join(p, 'bin', 'R'))
    expect(rScriptBin(p)).toBe(join(p, 'bin', 'Rscript'))
    expect(rLibraryDir(p)).toBe(join(p, 'lib', 'R', 'library'))
  })

  it('uses the Windows conda layout on win32 (python.exe at root, Scripts\\ tools, Lib\\R)', () => {
    setPlatform('win32')
    const p = 'C:\\root\\envs\\e'
    expect(pythonBin(p)).toBe(join(p, 'python.exe'))
    expect(pipBin(p)).toBe(join(p, 'Scripts', 'pip.exe'))
    expect(rBin(p)).toBe(join(p, 'Lib', 'R', 'bin', 'R.exe'))
    expect(rScriptBin(p)).toBe(join(p, 'Lib', 'R', 'bin', 'Rscript.exe'))
    expect(rLibraryDir(p)).toBe(join(p, 'Lib', 'R', 'library'))
  })
})

describe('repair-required registry', () => {
  it('adds, reads, checks, and clears runtime ids (deduped, survives round-trips)', () => {
    const root = makeRoot()
    expect(readRepairRequired(root)).toEqual([])
    expect(isRepairRequired(root, '/usr/bin/python3')).toBe(false)

    addRepairRequired(root, '/usr/bin/python3')
    addRepairRequired(root, '/usr/bin/python3') // idempotent
    addRepairRequired(root, 'default-r')
    expect(readRepairRequired(root).sort()).toEqual(['/usr/bin/python3', 'default-r'])
    expect(isRepairRequired(root, '/usr/bin/python3')).toBe(true)

    clearRepairRequired(root, '/usr/bin/python3')
    expect(isRepairRequired(root, '/usr/bin/python3')).toBe(false)
    expect(readRepairRequired(root)).toEqual(['default-r'])
  })

  it('returns an empty list for a missing or malformed registry file', () => {
    const root = makeRoot()
    expect(readRepairRequired(root)).toEqual([])
    writeFileSync(join(root, '.repair-required.json'), 'not json', 'utf8')
    expect(readRepairRequired(root)).toEqual([])
    expect(isRepairRequired(root, 'anything')).toBe(false)
  })
})
