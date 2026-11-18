import { basename } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_BUNDLE_VERSION, DEFAULT_PYTHON_SPEC, DEFAULT_R_SPEC } from '@aipoch/environment'
import {
  readDefaultEnvVersion,
  buildLockFromSolve,
  derivePackPathBudget,
  packageFilesFromLock,
  packId,
  packArchiveFile,
  packMatrix,
  solveArgv,
  verifyBundleComplete,
  VERSIONS
} from './stage-default-envs.mjs'

it('uses the public environment version when staging bundles', () => {
  expect(readDefaultEnvVersion()).toBe(DEFAULT_BUNDLE_VERSION)
})

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
    expect(VERSIONS.python).toEqual(['3.12'])
    expect(VERSIONS.r).toEqual(['4.4'])
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
    expect(matrix.map((p) => p.id)).toEqual(['python-3.12', 'r-4.4'])
    const python = matrix.find((p) => p.id === 'python-3.12')
    expect(python).toMatchObject({ language: 'python', version: '3.12' })
    expect(python?.packages).toEqual(DEFAULT_PYTHON_SPEC.packages)
    const r = matrix.find((p) => p.id === 'r-4.4')
    expect(r?.packages).toEqual(['r-base=4.4', 'r-jsonlite', 'r-biocmanager', 'r-ggplot2'])
  })
})

describe('solveArgv', () => {
  it('is a dry-run json create with the target --platform and the version-pinned floor', () => {
    const argv = solveArgv('/tmp/staging/python-3.12', DEFAULT_PYTHON_SPEC.packages, 'osx-64')
    expect(argv).toContain('create')
    expect(argv).toContain('--dry-run')
    expect(argv).toContain('--json')
    // --platform immediately precedes the target subdir.
    expect(argv[argv.indexOf('--platform') + 1]).toBe('osx-64')
    expect(argv).toContain('python=3.12')
    expect(argv).toContain('matplotlib-base')
    expect(argv).toContain('nomkl')
  })

  it('omits --platform when no target subdir is given (native solve)', () => {
    const argv = solveArgv('/tmp/x', DEFAULT_R_SPEC.packages, '')
    expect(argv).not.toContain('--platform')
    expect(argv).toContain('r-base=4.4')
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
        md5: (p: string) => md5s[basename(p)]
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

describe('derivePackPathBudget', () => {
  it('derives cache and env maxima from URL layout plus package contents', () => {
    const lock = [
      '@EXPLICIT',
      'https://conda.anaconda.org/conda-forge/noarch/demo-1.0-0.conda#aaa',
      'https://mirror.example.org/channel/win-64/short-1.0-0.tar.bz2#bbb',
      ''
    ].join('\n')
    const budget = derivePackPathBudget(lock, {
      'demo-1.0-0.conda': ['Library/bin/demo.exe', 'Library/include/a/deeper/header.hpp'],
      'short-1.0-0.tar.bz2': ['bin/short.exe']
    })

    expect(budget.maxEnvRelativePath).toBe('Library/include/a/deeper/header.hpp'.length + 1)
    expect(budget.maxCacheRelativePath).toBeGreaterThan(budget.maxEnvRelativePath)
    expect(budget.maxCacheRelativePath).not.toBe(87 + 138)
  })

  it('fails closed when a lock package was not inspected', () => {
    expect(() =>
      derivePackPathBudget('https://conda.example/conda-forge/noarch/missing-1.0-0.conda#aaa\n', {})
    ).toThrow(/missing package contents/i)
  })
})
