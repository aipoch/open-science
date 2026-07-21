import { describe, expect, it, vi } from 'vitest'

import type { NotebookLanguage } from '../../shared/notebook'
import type { RuntimeSelection } from '../../shared/notebook-runtime'
import {
  RuntimeRegistry,
  computePackageMutability,
  planPackageInstall,
  type DetectionResult,
  type EnvironmentAdapter
} from './runtime-registry'

// A fake adapter that returns a fixed detection and records what it was asked.
const fakeAdapter = (
  source: EnvironmentAdapter['source'],
  result: DetectionResult
): EnvironmentAdapter & {
  calls: Array<{ language: NotebookLanguage; selection?: RuntimeSelection }>
} => {
  const calls: Array<{ language: NotebookLanguage; selection?: RuntimeSelection }> = []
  return {
    source,
    calls,
    detect: vi.fn(async (language, selection) => {
      calls.push({ language, selection: selection ?? undefined })
      return result
    })
  }
}

describe('computePackageMutability', () => {
  it('is read-only when no runtime is selected', () => {
    expect(computePackageMutability('python', undefined)).toEqual({
      mutable: false,
      reason: expect.stringContaining('No runtime is selected')
    })
  })

  it('makes managed envs mutable via micromamba', () => {
    expect(computePackageMutability('python', { source: 'managed' })).toEqual({
      mutable: true,
      via: 'micromamba'
    })
    expect(computePackageMutability('r', { source: 'managed' })).toEqual({
      mutable: true,
      via: 'micromamba'
    })
  })

  it("keeps the user's own external env read-only until installs are authorized", () => {
    const external: RuntimeSelection = {
      source: 'external',
      interpreterPath: '/usr/bin/python3',
      appOwnedOverlay: false,
      packageInstallAuthorized: false
    }
    const result = computePackageMutability('python', external)
    expect(result.mutable).toBe(false)
    expect(result).toMatchObject({ reason: expect.stringContaining('not authorized') })
  })

  it('installs into an authorized external env via pip (Python) or the R library (R)', () => {
    expect(
      computePackageMutability('python', {
        source: 'external',
        interpreterPath: '/usr/bin/python3',
        appOwnedOverlay: false,
        packageInstallAuthorized: true
      })
    ).toEqual({ mutable: true, via: 'pip' })
    expect(
      computePackageMutability('r', {
        source: 'external',
        interpreterPath: '/usr/bin/Rscript',
        appOwnedOverlay: false,
        packageInstallAuthorized: true
      })
    ).toEqual({ mutable: true, via: 'r-library' })
  })

  it('allows installs into an app-owned overlay venv even without the authorization toggle', () => {
    // register + create (--system-site-packages) → Open Science owns this venv, so it is writable by
    // design (the authorization gate only guards a user's pre-existing environment).
    expect(
      computePackageMutability('python', {
        source: 'external',
        interpreterPath: '/runtime/venvs/user-py/bin/python',
        appOwnedOverlay: true,
        packageInstallAuthorized: false
      })
    ).toEqual({ mutable: true, via: 'pip' })
  })
})

describe('planPackageInstall', () => {
  it('refuses when the env is read-only (agent must not silently mutate)', () => {
    expect(planPackageInstall('python', undefined)).toMatchObject({ action: 'refuse' })
    expect(
      planPackageInstall('python', {
        source: 'external',
        interpreterPath: '/usr/bin/python3',
        appOwnedOverlay: false,
        packageInstallAuthorized: false
      })
    ).toMatchObject({ action: 'refuse', reason: expect.stringContaining('not authorized') })
  })

  it('uses micromamba for managed, pip for authorized external Python, r-library for external R', () => {
    expect(planPackageInstall('python', { source: 'managed' })).toEqual({ action: 'micromamba' })
    expect(
      planPackageInstall('python', {
        source: 'external',
        interpreterPath: '/py',
        appOwnedOverlay: true,
        packageInstallAuthorized: false
      })
    ).toEqual({ action: 'pip' })
    expect(
      planPackageInstall('r', {
        source: 'external',
        interpreterPath: '/Rscript',
        appOwnedOverlay: false,
        packageInstallAuthorized: true
      })
    ).toEqual({ action: 'r-library' })
  })
})

describe('RuntimeRegistry.readiness', () => {
  const managedReady: DetectionResult = {
    detected: true,
    runnable: true,
    interpreterPath: '/runtime/envs/default-python/bin/python',
    version: '3.12.4'
  }
  const externalReady: DetectionResult = {
    detected: true,
    runnable: true,
    interpreterPath: '/usr/bin/python3',
    version: '3.11.2'
  }

  it('routes an unselected language to the managed adapter (managed is the default source)', async () => {
    const managed = fakeAdapter('managed', managedReady)
    const external = fakeAdapter('external', externalReady)
    const registry = new RuntimeRegistry({ managed, external })

    const readiness = await registry.readiness('python', undefined)

    expect(managed.detect).toHaveBeenCalledOnce()
    expect(external.detect).not.toHaveBeenCalled()
    expect(readiness).toMatchObject({
      source: 'managed',
      detected: true,
      selected: false,
      runnable: true,
      packageMutable: false, // no selection → not mutable
      detail: 'No runtime selected yet.'
    })
  })

  it('routes an external selection to the external adapter and reflects authorization', async () => {
    const managed = fakeAdapter('managed', managedReady)
    const external = fakeAdapter('external', externalReady)
    const registry = new RuntimeRegistry({ managed, external })
    const selection: RuntimeSelection = {
      source: 'external',
      interpreterPath: '/usr/bin/python3',
      appOwnedOverlay: false,
      packageInstallAuthorized: true
    }

    const readiness = await registry.readiness('python', selection)

    expect(external.detect).toHaveBeenCalledOnce()
    expect(managed.detect).not.toHaveBeenCalled()
    expect(readiness).toMatchObject({
      source: 'external',
      selected: true,
      runnable: true,
      packageMutable: true,
      interpreterPath: '/usr/bin/python3',
      version: '3.11.2'
    })
  })

  it('reports selected-but-not-runnable (e.g. external R without jsonlite)', async () => {
    const managed = fakeAdapter('managed', managedReady)
    const external = fakeAdapter('external', {
      detected: true,
      runnable: false,
      interpreterPath: '/usr/bin/Rscript',
      version: 'R 4.4.1',
      detail: 'jsonlite is not installed'
    })
    const registry = new RuntimeRegistry({ managed, external })

    const readiness = await registry.readiness('r', {
      source: 'external',
      interpreterPath: '/usr/bin/Rscript',
      appOwnedOverlay: false,
      packageInstallAuthorized: false
    })

    expect(readiness).toMatchObject({
      detected: true,
      runnable: false,
      packageMutable: false,
      detail: 'jsonlite is not installed'
    })
  })
})

describe('RuntimeRegistry.survey', () => {
  it('probes both sources with nothing selected so onboarding can offer the choice', async () => {
    const managed = fakeAdapter('managed', {
      detected: false,
      runnable: false,
      detail: 'Not built'
    })
    const external = fakeAdapter('external', {
      detected: true,
      runnable: true,
      interpreterPath: '/usr/bin/python3',
      version: '3.11.2'
    })
    const registry = new RuntimeRegistry({ managed, external })

    const { managed: m, external: e } = await registry.survey('python')

    expect(m).toMatchObject({
      source: 'managed',
      detected: false,
      selected: false,
      packageMutable: true
    })
    expect(e).toMatchObject({
      source: 'external',
      detected: true,
      selected: false,
      packageMutable: false, // survey shows external's read-only floor until selected + authorized
      interpreterPath: '/usr/bin/python3'
    })
  })
})
