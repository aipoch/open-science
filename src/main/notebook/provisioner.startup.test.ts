import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { PROD_SESSION_DIR_NAME } from '../session-persistence/repository'
import {
  DEFAULT_ENV_VERSION,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  pythonBin,
  writeReadyMarker
} from './runtime-paths'
import {
  createFetchBundleAdapter,
  createProductionProvisioner,
  DEFAULT_PYTHON_SPEC,
  planStartupAction,
  type ProvisionProgress
} from './provisioner'

const makeRoot = (): string => mkdtempSync(join(tmpdir(), 'os-start-'))
const touchBin = (path: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'x')
}

describe('planStartupAction', () => {
  it('is fresh on an empty root', () => {
    expect(planStartupAction(makeRoot(), DEFAULT_ENV_VERSION)).toBe('fresh')
  })

  it('is ready when python is provisioned at the expected version', () => {
    const root = makeRoot()
    touchBin(pythonBin(envPrefix(root, DEFAULT_PY_ENV)))
    writeReadyMarker(root, DEFAULT_ENV_VERSION, 't')
    expect(planStartupAction(root, DEFAULT_ENV_VERSION)).toBe('ready')
  })

  it('is upgrade when outdated but the python bin is healthy (additive path)', () => {
    const root = makeRoot()
    touchBin(pythonBin(envPrefix(root, DEFAULT_PY_ENV)))
    writeReadyMarker(root, DEFAULT_ENV_VERSION - 1, 't')
    expect(planStartupAction(root, DEFAULT_ENV_VERSION)).toBe('upgrade')
  })

  it('is repair when a marker exists but the python bin is missing (corrupt)', () => {
    const root = makeRoot()
    writeReadyMarker(root, DEFAULT_ENV_VERSION, 't') // marker but no bin
    expect(planStartupAction(root, DEFAULT_ENV_VERSION)).toBe('repair')
  })

  it('is repair when an env dir exists without a marker', () => {
    const root = makeRoot()
    mkdirSync(envPrefix(root, DEFAULT_R_ENV), { recursive: true })
    expect(planStartupAction(root, DEFAULT_ENV_VERSION)).toBe('repair')
  })
})

describe('createFetchBundleAdapter', () => {
  it('forwards root/cdnBase/spec/version/onProgress into fetchBundle via an injected download', async () => {
    const root = makeRoot()
    const requestedUrls: string[] = []
    const download = async (url: string): Promise<void> => {
      requestedUrls.push(url)
      throw new Error('simulated 404') // no lock published -> online fallback (undefined)
    }
    const adapter = createFetchBundleAdapter(root, 'https://cdn.example/env', download)

    const events: ProvisionProgress[] = []
    const result = await adapter(DEFAULT_PYTHON_SPEC, 7, (p) => events.push(p))

    expect(result).toBeUndefined()
    expect(requestedUrls).toEqual(['https://cdn.example/env/7/default-python.lock'])
    // Onprogress is only invoked on the happy (published-lock) path; nothing to assert here beyond
    // "no events / no throw" since the download itself fails fast.
    expect(events).toEqual([])
  })

  it('uses a different cdnBase/root/version per adapter instance (no shared state leaks)', async () => {
    const rootA = makeRoot()
    const rootB = makeRoot()
    const urlsA: string[] = []
    const urlsB: string[] = []
    const adapterA = createFetchBundleAdapter(rootA, 'https://cdn-a', async (url) => {
      urlsA.push(url)
      throw new Error('404')
    })
    const adapterB = createFetchBundleAdapter(rootB, 'https://cdn-b', async (url) => {
      urlsB.push(url)
      throw new Error('404')
    })

    await adapterA(DEFAULT_PYTHON_SPEC, 1, () => {})
    await adapterB(DEFAULT_PYTHON_SPEC, 2, () => {})

    expect(urlsA).toEqual(['https://cdn-a/1/default-python.lock'])
    expect(urlsB).toEqual(['https://cdn-b/2/default-python.lock'])
  })
})

describe('createProductionProvisioner', () => {
  const micromambaBinName = process.platform === 'win32' ? 'micromamba.exe' : 'micromamba'

  it('builds a RuntimeProvisioner when micromamba resolves via the OPEN_SCIENCE_MICROMAMBA_BIN override', () => {
    const root = makeRoot()
    const mmPath = join(root, 'bin', micromambaBinName)
    touchBin(mmPath)

    const provisioner = createProductionProvisioner({
      root,
      channel: 'conda-forge',
      cdnBase: 'https://cdn.example/env',
      micromamba: { env: { OPEN_SCIENCE_MICROMAMBA_BIN: mmPath } }
    })

    expect(typeof provisioner.status).toBe('function')
    expect(typeof provisioner.provisionPython).toBe('function')
    expect(typeof provisioner.provisionR).toBe('function')
    expect(typeof provisioner.upgradeIfNeeded).toBe('function')
    expect(typeof provisioner.repair).toBe('function')
  })

  it('derives home from root (dev/prod resolved by the caller) when no explicit home is given', () => {
    // root = <home>/<PROD_SESSION_DIR_NAME>/runtime, matching resolveMicromamba's storage-root branch;
    // the factory must derive `home` back out of `root` without any env/PATH help.
    const home = mkdtempSync(join(tmpdir(), 'os-home-'))
    const root = join(home, PROD_SESSION_DIR_NAME, 'runtime')
    mkdirSync(root, { recursive: true })
    const mmPath = join(
      home,
      PROD_SESSION_DIR_NAME,
      'runtime',
      'micromamba',
      'bin',
      micromambaBinName
    )
    touchBin(mmPath)

    const provisioner = createProductionProvisioner({
      root,
      channel: 'conda-forge',
      cdnBase: 'https://cdn.example/env',
      // Isolate from the real machine's env/PATH/resourcesPath so only the derived home can resolve it.
      micromamba: { env: {} }
    })

    expect(typeof provisioner.status).toBe('function')
  })

  it('lets an explicit opts.micromamba.home override the derived one', () => {
    const wrongRootHome = mkdtempSync(join(tmpdir(), 'os-wronghome-'))
    const root = join(wrongRootHome, PROD_SESSION_DIR_NAME, 'runtime') // derived home won't have a bin
    mkdirSync(root, { recursive: true })

    const realHome = mkdtempSync(join(tmpdir(), 'os-realhome-'))
    const mmPath = join(
      realHome,
      PROD_SESSION_DIR_NAME,
      'runtime',
      'micromamba',
      'bin',
      micromambaBinName
    )
    touchBin(mmPath)

    const provisioner = createProductionProvisioner({
      root,
      channel: 'conda-forge',
      cdnBase: 'https://cdn.example/env',
      micromamba: { env: {}, home: realHome }
    })

    expect(typeof provisioner.status).toBe('function')
  })

  it('throws a clear error when micromamba cannot be resolved anywhere', () => {
    const home = mkdtempSync(join(tmpdir(), 'os-empty-home-'))
    const root = join(home, PROD_SESSION_DIR_NAME, 'runtime')
    mkdirSync(root, { recursive: true })

    expect(() =>
      createProductionProvisioner({
        root,
        channel: 'conda-forge',
        cdnBase: 'https://cdn.example/env',
        micromamba: { env: {} } // no override, no bundled bin here, no PATH
      })
    ).toThrow(/micromamba binary not found/)
  })
})
