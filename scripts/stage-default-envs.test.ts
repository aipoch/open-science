import { describe, expect, it } from 'vitest'

import { DEFAULT_PYTHON_SPEC, DEFAULT_R_SPEC } from '../src/main/notebook/provisioner'
import { packageFilesFromLock, PY_PKGS, R_PKGS } from './stage-default-envs.mjs'

describe('packageFilesFromLock', () => {
  it('extracts the tarball filenames referenced by an @EXPLICIT lock', () => {
    const lock = [
      '@EXPLICIT',
      'https://conda.anaconda.org/conda-forge/noarch/numpy-1.0.conda#abc',
      'https://conda.anaconda.org/conda-forge/osx-arm64/python-3.12.tar.bz2#def',
      '# a comment, ignored',
      ''
    ].join('\n')
    expect(packageFilesFromLock(lock)).toEqual(['numpy-1.0.conda', 'python-3.12.tar.bz2'])
  })
})

// Guard against spec drift: the staging script duplicates provisioner.ts's default-env package lists
// (it must not import the built app). If they diverge, the CDN bundle stops matching what the app
// provisions — the offline completeness gate then fails and the app silently falls back to online.
// This test fails CI the moment the two lists disagree, so a spec edit in one place cannot ship alone.
describe('default-env spec sync', () => {
  it('stage-default-envs PY_PKGS matches DEFAULT_PYTHON_SPEC', () => {
    expect(PY_PKGS).toEqual(DEFAULT_PYTHON_SPEC.packages)
  })
  it('stage-default-envs R_PKGS matches DEFAULT_R_SPEC', () => {
    expect(R_PKGS).toEqual(DEFAULT_R_SPEC.packages)
  })
})
