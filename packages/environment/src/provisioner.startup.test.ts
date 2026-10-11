import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ENV_VERSION,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  pythonBin,
  writeReadyMarker
} from './runtime-paths'

import { planStartupAction } from './provisioner'

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
