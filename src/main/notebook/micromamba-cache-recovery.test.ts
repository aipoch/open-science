import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  recoverWindowsMaxPathPackage,
  removeOverBudgetUrlPackages,
  removeIncompleteExtractedPackages
} from './micromamba-cache-recovery'

const makeRoot = (): string => mkdtempSync(join(tmpdir(), 'os-cache-recovery-'))
const markComplete = (packageDir: string): void => {
  mkdirSync(join(packageDir, 'info'), { recursive: true })
  writeFileSync(
    join(packageDir, 'info', 'repodata_record.json'),
    JSON.stringify({ url: `https://host/channel/noarch/${basename(packageDir)}.conda` })
  )
}

describe('removeIncompleteExtractedPackages', () => {
  it('uses repodata_record.json and repairs both flat and URL-derived package leaves', () => {
    const cache = makeRoot()
    const flatComplete = join(cache, 'complete-flat')
    const flatIncomplete = join(cache, 'incomplete-flat')
    const urlComplete = join(
      cache,
      'https',
      'conda.example',
      'conda-forge',
      'noarch',
      'complete-url-1.0-0'
    )
    const urlIncomplete = join(
      cache,
      'https',
      'conda.example',
      'conda-forge',
      'win-64',
      'incomplete-url-1.0-0'
    )
    const urlEmpty = join(
      cache,
      'https',
      'conda.example',
      'conda-forge',
      'win-64',
      'empty-url-1.0-0'
    )
    for (const dir of [flatComplete, flatIncomplete, urlComplete, urlIncomplete, urlEmpty]) {
      mkdirSync(join(dir, 'info'), { recursive: true })
    }
    rmSync(join(urlEmpty, 'info'), { recursive: true })
    writeFileSync(join(flatComplete, 'info', 'repodata_record.json'), '{}')
    writeFileSync(join(flatIncomplete, 'info', 'index.json'), '{}')
    writeFileSync(join(urlComplete, 'info', 'repodata_record.json'), '{}')
    writeFileSync(join(urlIncomplete, 'partial'), 'x')
    mkdirSync(join(cache, 'cache', 'repodata'), { recursive: true })
    writeFileSync(join(cache, 'cache', 'repodata', 'state.json'), '{}')

    expect(removeIncompleteExtractedPackages([cache])).toBe(true)
    expect(existsSync(flatComplete)).toBe(true)
    expect(existsSync(flatIncomplete)).toBe(false)
    expect(existsSync(urlComplete)).toBe(true)
    expect(existsSync(urlIncomplete)).toBe(false)
    expect(existsSync(urlEmpty)).toBe(false)
    expect(existsSync(join(cache, 'cache', 'repodata', 'state.json'))).toBe(true)
  })

  it('does not mistake a channel segment named win-64 for the package subdir', () => {
    const cache = makeRoot()
    const channelRoot = join(cache, 'https', 'host', 'win-64', 'release-2026-0', 'forge')
    const complete = join(channelRoot, 'noarch', 'complete-package-1.0-0')
    const incomplete = join(channelRoot, 'noarch', 'incomplete-package-1.0-0')
    markComplete(complete)
    mkdirSync(incomplete, { recursive: true })
    writeFileSync(join(incomplete, 'partial'), 'x')

    expect(removeIncompleteExtractedPackages([cache])).toBe(true)
    expect(existsSync(channelRoot)).toBe(true)
    expect(existsSync(complete)).toBe(true)
    expect(existsSync(incomplete)).toBe(false)
  })
})

describe('recoverWindowsMaxPathPackage', () => {
  it('deletes only the parsed package leaf contained by an allowed cache root', () => {
    const cache = makeRoot()
    const leaf = 'libstdcxx-devel_win-64-15.2.0-h0a72980_119'
    const packageDir = join(cache, 'https', 'conda.anaconda.org', 'conda-forge', 'noarch', leaf)
    const sibling = join(cache, 'https', 'conda.anaconda.org', 'conda-forge', 'noarch', 'keep-me')
    mkdirSync(packageDir, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    const missing = join(packageDir, 'Library', 'x'.repeat(280))
    const error = new Error(
      `warning Invalid package cache, file '${missing}' is missing\n` +
        `Cannot find a valid extracted directory cache for '${leaf}.conda'\n` +
        'critical Package cache error.'
    )

    expect(recoverWindowsMaxPathPackage(error, [cache], { platform: 'win32' })).toBe(true)
    expect(existsSync(packageDir)).toBe(false)
    expect(existsSync(sibling)).toBe(true)
  })

  it('refuses traversal, cache-root targets, and ambiguous cache errors', () => {
    const cache = makeRoot()
    const outside = makeRoot()
    const leaf = 'outside-package-1.0-0'
    const outsidePackage = join(outside, 'https', 'host', 'channel', 'noarch', leaf)
    mkdirSync(outsidePackage, { recursive: true })
    const longOutsidePath = join(outsidePackage, 'x'.repeat(280))

    expect(
      recoverWindowsMaxPathPackage(
        new Error(
          `Invalid package cache, file '${longOutsidePath}' is missing for '${leaf}.conda'; Package cache error`
        ),
        [cache],
        { platform: 'win32' }
      )
    ).toBe(false)
    expect(
      recoverWindowsMaxPathPackage(
        new Error(`Error when extracting package: remove_all: not empty: "${cache}"`),
        [cache],
        { platform: 'win32' }
      )
    ).toBe(false)
    expect(
      recoverWindowsMaxPathPackage(new Error('Invalid package cache'), [cache], {
        platform: 'win32'
      })
    ).toBe(false)
    expect(existsSync(outsidePackage)).toBe(true)
  })

  it('requires an actual over-budget quoted path before classifying remove_all evidence', () => {
    const cache = makeRoot()
    const leaf = 'libstdcxx-devel_win-64-15.2.0-h0a72980_119'
    const packageDir = join(cache, 'https', 'host', 'channel', 'win-64', leaf)
    mkdirSync(packageDir, { recursive: true })
    const error = new Error(`Error when extracting package: remove_all: not empty: "${packageDir}"`)

    expect(recoverWindowsMaxPathPackage(error, [cache], { platform: 'win32' })).toBe(false)
    expect(existsSync(packageDir)).toBe(true)
  })

  it('recovers remove_all evidence for any package when the quoted target is actually over budget', () => {
    const cache = makeRoot()
    const leaf = 'future-deep-package-1.0-0'
    const packageDir = join(cache, 'https', 'host', 'channel', 'win-64', leaf)
    const overBudgetTarget = join(
      packageDir,
      'Library',
      'a'.repeat(100),
      'b'.repeat(100),
      'file.hpp'
    )
    mkdirSync(join(overBudgetTarget, '..'), { recursive: true })
    writeFileSync(overBudgetTarget, 'x')
    markComplete(packageDir)

    expect(
      recoverWindowsMaxPathPackage(
        new Error(`Error when extracting package: remove_all: not empty: "${overBudgetTarget}"`),
        [cache],
        { platform: 'win32' }
      )
    ).toBe(true)
    expect(existsSync(packageDir)).toBe(false)
  })

  it('uses the deepest matching subdir when a channel segment is also named win-64', () => {
    const cache = makeRoot()
    const leaf = 'future-deep-package-1.0-0'
    const channelRoot = join(cache, 'https', 'host', 'win-64', 'label', leaf, 'forge')
    const packageDir = join(channelRoot, 'noarch', leaf)
    const overBudgetTarget = join(
      packageDir,
      'Library',
      'a'.repeat(100),
      'b'.repeat(100),
      'file.hpp'
    )
    mkdirSync(join(overBudgetTarget, '..'), { recursive: true })
    writeFileSync(overBudgetTarget, 'x')

    expect(
      recoverWindowsMaxPathPackage(
        new Error(
          `Invalid package cache, file '${overBudgetTarget}' is missing for '${leaf}.conda'; ` +
            'Package cache error'
        ),
        [cache],
        { platform: 'win32' }
      )
    ).toBe(true)
    expect(existsSync(channelRoot)).toBe(true)
    expect(existsSync(packageDir)).toBe(false)
  })

  it('does not classify the same evidence on non-Windows platforms', () => {
    const cache = makeRoot()
    const leaf = join(cache, 'https', 'host', 'channel', 'noarch', 'pkg-1.0-0')
    mkdirSync(leaf, { recursive: true })
    expect(
      recoverWindowsMaxPathPackage(
        new Error(`Error when extracting package: remove_all: not empty: "${leaf}"`),
        [cache],
        { platform: 'darwin' }
      )
    ).toBe(false)
  })
})

describe('removeOverBudgetUrlPackages', () => {
  it('removes only URL-cache package leaves with an actual over-budget descendant', () => {
    const cache = makeRoot()
    const deepLeaf = join(cache, 'https', 'host', 'channel', 'win-64', 'deep-package-1.0-0')
    const deepFile = join(deepLeaf, 'Library', 'a'.repeat(100), 'b'.repeat(100), 'file.hpp')
    const sibling = join(cache, 'https', 'host', 'channel', 'win-64', 'keep-package-1.0-0')
    const flat = join(cache, 'flat-package-1.0-0')
    mkdirSync(join(deepFile, '..'), { recursive: true })
    writeFileSync(deepFile, 'x')
    markComplete(deepLeaf)
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, 'short.txt'), 'x')
    mkdirSync(flat, { recursive: true })
    writeFileSync(join(flat, 'short.txt'), 'x')

    expect(removeOverBudgetUrlPackages(cache, { platform: 'win32' })).toBe(true)
    expect(existsSync(deepLeaf)).toBe(false)
    expect(existsSync(sibling)).toBe(true)
    expect(existsSync(flat)).toBe(true)
  })

  it('does nothing outside Windows', () => {
    const cache = makeRoot()
    const leaf = join(cache, 'https', 'host', 'channel', 'win-64', 'deep-package-1.0-0')
    const deepFile = join(leaf, 'a'.repeat(100), 'b'.repeat(100), 'file.hpp')
    mkdirSync(join(deepFile, '..'), { recursive: true })
    writeFileSync(deepFile, 'x')
    markComplete(leaf)

    expect(removeOverBudgetUrlPackages(cache, { platform: 'darwin' })).toBe(false)
    expect(existsSync(leaf)).toBe(true)
  })

  it('does not mistake a channel segment named win-64 for the package subdir', () => {
    const cache = makeRoot()
    const channelRoot = join(cache, 'https', 'host', 'win-64', 'release-2026-0', 'forge')
    const leaf = join(channelRoot, 'noarch', 'deep-package-1.0-0')
    const deepFile = join(leaf, 'Library', 'a'.repeat(100), 'b'.repeat(100), 'file.hpp')
    const sibling = join(channelRoot, 'noarch', 'keep-package-1.0-0')
    mkdirSync(join(deepFile, '..'), { recursive: true })
    writeFileSync(deepFile, 'x')
    markComplete(leaf)
    mkdirSync(sibling, { recursive: true })

    expect(removeOverBudgetUrlPackages(cache, { platform: 'win32' })).toBe(true)
    expect(existsSync(channelRoot)).toBe(true)
    expect(existsSync(leaf)).toBe(false)
    expect(existsSync(sibling)).toBe(true)
  })
})
