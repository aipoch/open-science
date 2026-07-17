import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ENV_VERSION,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  pythonBin,
  rBin,
  readReadyMarker,
  writeReadyMarker
} from './runtime-paths'
import {
  DEFAULT_PYTHON_SPEC,
  DefaultRuntimeProvisioner,
  type FetchedBundle,
  type ProvisionerDeps
} from './provisioner'

const makeRoot = (): string => mkdtempSync(join(tmpdir(), 'os-upg-'))
const touchBin = (path: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'x')
}

const baseDeps = (root: string, over: Partial<ProvisionerDeps> = {}): ProvisionerDeps => ({
  root,
  mm: '/mm',
  channel: 'mirror-forge',
  fetchBundle: async (): Promise<FetchedBundle | undefined> => undefined,
  runArgv: async (argv) => {
    const pIdx = argv.findIndex((a) => a === '--prefix' || a === '-p')
    const prefix = argv[pIdx + 1]
    touchBin(prefix.endsWith(DEFAULT_PY_ENV) ? pythonBin(prefix) : rBin(prefix))
  },
  verify: async () => undefined,
  now: () => 't2',
  ...over
})

describe('upgradeIfNeeded', () => {
  it('is a no-op when already at the expected version', async () => {
    const root = makeRoot()
    touchBin(pythonBin(envPrefix(root, DEFAULT_PY_ENV)))
    writeReadyMarker(root, DEFAULT_ENV_VERSION, 't1')
    const argvs: string[][] = []
    await new DefaultRuntimeProvisioner(
      baseDeps(root, { runArgv: async (a) => void argvs.push(a) })
    ).upgradeIfNeeded(() => {})
    expect(argvs).toHaveLength(0)
  })

  it('additively installs the default set into the existing python env and re-stamps the marker', async () => {
    const root = makeRoot()
    touchBin(pythonBin(envPrefix(root, DEFAULT_PY_ENV)))
    writeReadyMarker(root, DEFAULT_ENV_VERSION - 1, 't1') // outdated but healthy
    const argvs: string[][] = []
    await new DefaultRuntimeProvisioner(
      baseDeps(root, { runArgv: async (a) => void argvs.push(a) })
    ).upgradeIfNeeded(() => {})
    // Additive install (not create), targeting the python prefix, with the default packages last.
    expect(argvs[0][1]).toBe('install')
    expect(argvs[0]).toContain(envPrefix(root, DEFAULT_PY_ENV))
    for (const pkg of DEFAULT_PYTHON_SPEC.packages) expect(argvs[0]).toContain(pkg)
    expect(readReadyMarker(root)).toEqual({
      defaultEnvVersion: DEFAULT_ENV_VERSION,
      preparedAt: 't2'
    })
  })

  it('also upgrades R additively only when R is already materialized', async () => {
    const root = makeRoot()
    touchBin(pythonBin(envPrefix(root, DEFAULT_PY_ENV)))
    touchBin(rBin(envPrefix(root, DEFAULT_R_ENV)))
    writeReadyMarker(root, DEFAULT_ENV_VERSION - 1, 't1')
    const installedPrefixes: string[] = []
    await new DefaultRuntimeProvisioner(
      baseDeps(root, {
        runArgv: async (a) => {
          const pIdx = a.findIndex((x) => x === '--prefix' || x === '-p')
          installedPrefixes.push(a[pIdx + 1])
        }
      })
    ).upgradeIfNeeded(() => {})
    expect(installedPrefixes).toContain(envPrefix(root, DEFAULT_PY_ENV))
    expect(installedPrefixes).toContain(envPrefix(root, DEFAULT_R_ENV))
  })
})

describe('repair', () => {
  it('deletes the python env + marker then re-provisions from scratch', async () => {
    const root = makeRoot()
    const stale = envPrefix(root, DEFAULT_PY_ENV)
    touchBin(join(stale, 'stale-file'))
    writeReadyMarker(root, DEFAULT_ENV_VERSION, 't1')
    await new DefaultRuntimeProvisioner(baseDeps(root)).repair('python', () => {})
    // The stale file is gone (dir was removed), a fresh python bin exists, marker re-stamped.
    expect(existsSync(join(stale, 'stale-file'))).toBe(false)
    expect(existsSync(pythonBin(stale))).toBe(true)
    expect(readReadyMarker(root)).toEqual({
      defaultEnvVersion: DEFAULT_ENV_VERSION,
      preparedAt: 't2'
    })
  })

  it('repairs R without stamping the python marker', async () => {
    const root = makeRoot()
    await new DefaultRuntimeProvisioner(baseDeps(root)).repair('r', () => {})
    expect(existsSync(rBin(envPrefix(root, DEFAULT_R_ENV)))).toBe(true)
    expect(readReadyMarker(root)).toBeUndefined()
  })
})
