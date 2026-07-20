import { describe, expect, it } from 'vitest'

import { BASE_PYTHON_PACKAGES, BASE_R_PACKAGES } from '../src/main/notebook/provisioner'
import {
  buildLockFromSolve,
  floorPackages,
  packageFilesFromLock,
  packId,
  packArchiveFile,
  packMatrix,
  solveArgv,
  verifyBundleComplete,
  VERSIONS
} from './stage-default-envs.mjs'

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

describe('curated version matrix', () => {
  it('publishes the confirmed Python and R versions', () => {
    expect(VERSIONS.python).toEqual(['3.11', '3.12', '3.13'])
    expect(VERSIONS.r).toEqual(['4.3', '4.4'])
  })

  it('packId is <language>-<version>', () => {
    expect(packId('python', '3.11')).toBe('python-3.11')
    expect(packId('r', '4.3')).toBe('r-4.3')
  })

  it('packArchiveFile is <packId>.tar.zst', () => {
    expect(packArchiveFile('python', '3.12')).toBe('python-3.12.tar.zst')
    expect(packArchiveFile('r', '4.4')).toBe('r-4.4.tar.zst')
  })

  it('packMatrix is the full language x version cross product with pinned floors', () => {
    const matrix = packMatrix()
    expect(matrix.map((p) => p.id)).toEqual([
      'python-3.11',
      'python-3.12',
      'python-3.13',
      'r-4.3',
      'r-4.4'
    ])
    const py311 = matrix.find((p) => p.id === 'python-3.11')
    expect(py311).toMatchObject({ language: 'python', version: '3.11' })
    expect(py311?.packages).toEqual(['python=3.11', 'matplotlib-base', 'nomkl'])
    const r43 = matrix.find((p) => p.id === 'r-4.3')
    expect(r43?.packages).toEqual(['r-base=4.3', 'r-jsonlite'])
  })
})

// Guard against spec drift: the pack floor mirrors the named-env base floor in provisioner.ts. Compare
// package NAMES (strip the version pin the packs add) so an edit to BASE_*_PACKAGES cannot silently
// diverge from what the offline packs solve.
describe('floor package sync with provisioner base floor', () => {
  const stripPin = (specs: string[]): string[] => specs.map((s) => s.split('=')[0])

  it('Python floor names match BASE_PYTHON_PACKAGES', () => {
    expect(stripPin(floorPackages('python', '3.12'))).toEqual(stripPin(BASE_PYTHON_PACKAGES))
  })
  it('R floor names match BASE_R_PACKAGES', () => {
    expect(stripPin(floorPackages('r', '4.4'))).toEqual(stripPin(BASE_R_PACKAGES))
  })
  it('the floor is minimal (no scientific stack)', () => {
    expect(floorPackages('python', '3.11')).not.toContain('numpy')
    expect(floorPackages('python', '3.11')).not.toContain('pandas')
    expect(floorPackages('python', '3.11')).not.toContain('matplotlib')
  })
})

describe('solveArgv', () => {
  it('is a dry-run json create with the target --platform and the version-pinned floor', () => {
    const argv = solveArgv('/tmp/staging/python-3.11', floorPackages('python', '3.11'), 'osx-64')
    expect(argv).toContain('create')
    expect(argv).toContain('--dry-run')
    expect(argv).toContain('--json')
    // --platform immediately precedes the target subdir.
    expect(argv[argv.indexOf('--platform') + 1]).toBe('osx-64')
    expect(argv).toContain('python=3.11')
    expect(argv).toContain('matplotlib-base')
    expect(argv).toContain('nomkl')
  })

  it('omits --platform when no target subdir is given (native solve)', () => {
    const argv = solveArgv('/tmp/x', floorPackages('r', '4.3'), '')
    expect(argv).not.toContain('--platform')
    expect(argv).toContain('r-base=4.3')
  })
})

describe('buildLockFromSolve', () => {
  it('builds an @EXPLICIT lock from actions.LINK (the complete env), not actions.FETCH', () => {
    const solved = {
      actions: {
        // FETCH is only the not-yet-cached subset; LINK is the complete resolved env.
        FETCH: [{ url: 'https://c/conda-forge/noarch/only-fetched-1.0.conda', md5: 'ff' }],
        LINK: [
          { name: 'python', url: 'https://c/conda-forge/osx-64/python-3.11.conda', md5: 'aaa' },
          { name: 'nomkl', url: 'https://c/conda-forge/noarch/nomkl-1.0.conda', md5: 'bbb' }
        ]
      }
    }
    const lock = buildLockFromSolve(solved)
    expect(lock).toBe(
      '@EXPLICIT\n' +
        'https://c/conda-forge/osx-64/python-3.11.conda#aaa\n' +
        'https://c/conda-forge/noarch/nomkl-1.0.conda#bbb\n'
    )
    // The FETCH-only tarball must NOT appear — proves we build from LINK.
    expect(lock).not.toContain('only-fetched')
  })

  it('builds the full lock from LINK even when FETCH is empty (warm cache)', () => {
    const solved = {
      actions: {
        FETCH: [],
        LINK: [{ name: 'python', url: 'https://c/conda-forge/osx-64/python-3.12.conda', md5: 'a1' }]
      }
    }
    expect(buildLockFromSolve(solved)).toBe(
      '@EXPLICIT\nhttps://c/conda-forge/osx-64/python-3.12.conda#a1\n'
    )
  })

  it('throws when LINK is empty', () => {
    expect(() =>
      buildLockFromSolve({ actions: { FETCH: [{ url: 'x', md5: 'y' }], LINK: [] } })
    ).toThrow(/no LINK actions/)
    expect(() => buildLockFromSolve({ actions: {} })).toThrow(/no LINK actions/)
  })

  it('throws when a LINK entry is missing url or md5', () => {
    expect(() =>
      buildLockFromSolve({ actions: { LINK: [{ name: 'python', url: 'https://x/p.conda' }] } })
    ).toThrow(/missing url\/md5/)
    expect(() =>
      buildLockFromSolve({ actions: { LINK: [{ name: 'python', md5: 'aaa' }] } })
    ).toThrow(/missing url\/md5/)
  })
})

describe('verifyBundleComplete', () => {
  const lock = [
    '@EXPLICIT',
    'https://c/conda-forge/osx-64/python-3.11.conda#aaa',
    'https://c/conda-forge/noarch/nomkl-1.0.conda#bbb',
    ''
  ].join('\n')

  it('passes when every referenced tarball exists with a matching md5', () => {
    const md5s: Record<string, string> = {
      'python-3.11.conda': 'aaa',
      'nomkl-1.0.conda': 'bbb'
    }
    expect(() =>
      verifyBundleComplete(lock, '/pkgs', {
        exists: () => true,
        md5: (p: string) => md5s[p.split('/').pop() as string]
      })
    ).not.toThrow()
  })

  it('throws when a referenced tarball is missing', () => {
    expect(() =>
      verifyBundleComplete(lock, '/pkgs', {
        exists: (p: string) => !p.endsWith('nomkl-1.0.conda'),
        md5: () => 'aaa'
      })
    ).toThrow(/missing tarball nomkl-1.0.conda/)
  })

  it('throws on an md5 mismatch', () => {
    expect(() =>
      verifyBundleComplete(lock, '/pkgs', {
        exists: () => true,
        md5: () => 'deadbeef'
      })
    ).toThrow(/md5 mismatch/)
  })
})
