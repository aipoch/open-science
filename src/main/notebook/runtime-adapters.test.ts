import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DetectionResult } from './runtime-registry'
import {
  createExternalAdapter,
  createManagedAdapter,
  defaultExternalAdapterDeps,
  type ExternalAdapterDeps
} from './runtime-adapters'
import { DEFAULT_PY_ENV, envPrefix, pythonBin } from './runtime-paths'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'os-runtime-adapters-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('createManagedAdapter', () => {
  it('reports not-built when the default env interpreter is absent', async () => {
    const adapter = createManagedAdapter({ runtimeRoot: () => root })
    const result = await adapter.detect('python', undefined)
    expect(result).toMatchObject({ detected: false, runnable: false })
    expect(result.detail).toContain('not built')
  })

  it('reports detected+runnable with the env bin once the interpreter exists', async () => {
    const bin = pythonBin(envPrefix(root, DEFAULT_PY_ENV))
    mkdirSync(dirname(bin), { recursive: true })
    writeFileSync(bin, '#!/bin/sh\n')
    const adapter = createManagedAdapter({
      runtimeRoot: () => root,
      probeVersion: async () => '3.12.4'
    })

    const result = await adapter.detect('python', undefined)
    expect(result).toMatchObject({
      detected: true,
      runnable: true,
      interpreterPath: bin,
      version: '3.12.4'
    })
  })
})

describe('createExternalAdapter', () => {
  const pyResult: DetectionResult = { detected: true, runnable: true, interpreterPath: '/py' }
  const rResult: DetectionResult = {
    detected: true,
    runnable: false,
    detail: 'jsonlite is not installed'
  }

  const deps = (): ExternalAdapterDeps => ({
    probePython: vi.fn(async () => pyResult),
    probeR: vi.fn(async () => rResult)
  })

  it('routes python to probePython and r to probeR, forwarding the selected path', async () => {
    const d = deps()
    const adapter = createExternalAdapter(d)

    await adapter.detect('python', {
      source: 'external',
      interpreterPath: '/usr/bin/python3',
      appOwnedOverlay: false,
      packageInstallAuthorized: false
    })
    expect(d.probePython).toHaveBeenCalledWith('/usr/bin/python3')

    const r = await adapter.detect('r', undefined)
    expect(d.probeR).toHaveBeenCalledWith(undefined)
    expect(r).toEqual(rResult)
  })
})

describe('defaultExternalAdapterDeps.probePython', () => {
  it('version-validates a selected interpreter path (exists but not Python 3 => not runnable)', async () => {
    const fake = join(root, 'python3')
    writeFileSync(fake, '#!/bin/sh\n')

    // Exists AND reports a Python 3 version -> runnable.
    const good = await defaultExternalAdapterDeps({
      probeVersion: async () => '3.12.4'
    }).probePython(fake)
    expect(good).toMatchObject({
      detected: true,
      runnable: true,
      interpreterPath: fake,
      version: '3.12.4'
    })

    // Exists but NOT a runnable Python 3 (e.g. python2 / not python) -> detected, not runnable.
    const notPy3 = await defaultExternalAdapterDeps({
      probeVersion: async () => undefined
    }).probePython(fake)
    expect(notPy3).toMatchObject({ detected: true, runnable: false })
    expect(notPy3.detail).toContain('not a runnable Python 3')
  })

  it('reports not-found for a missing selected path without probing a version', async () => {
    let probed = false
    const missing = await defaultExternalAdapterDeps({
      probeVersion: async () => {
        probed = true
        return '3.12'
      }
    }).probePython(join(root, 'nope'))
    expect(missing).toMatchObject({ detected: false, runnable: false })
    expect(missing.detail).toContain('not found')
    expect(probed).toBe(false)
  })

  it('auto-detect preserves the launcher selection args (e.g. Windows `py -3`)', async () => {
    const result = await defaultExternalAdapterDeps({
      findPython: async () => ({ command: 'py', baseArgs: ['-3'] }),
      probeVersion: async () => '3.12.4'
    }).probePython(undefined)
    expect(result).toMatchObject({
      detected: true,
      runnable: true,
      interpreterPath: 'py',
      interpreterArgs: ['-3'],
      version: '3.12.4'
    })
  })
})
