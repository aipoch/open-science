import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { describe, expect, it } from 'vitest'
import { reviewedBoundaries, validateBoundaryPolicy } from './policy.mjs'

const policy = JSON.parse(readFileSync('scripts/ci/module-boundaries.json', 'utf8'))
const staticImports = (file: string): string[] =>
  [
    ...readFileSync(file, 'utf8').matchAll(
      /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
    )
  ].map((match) => match[1] ?? match[2])
const allImports = (file: string): string[] => [
  ...staticImports(file),
  ...[...readFileSync(file, 'utf8').matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(
    (match) => match[1]
  )
]

describe('module boundary policy', () => {
  it('loads every reviewed boundary from trusted data', () => {
    expect(Object.keys(reviewedBoundaries)).toEqual(Object.keys(policy.modules))
    expect(() => validateBoundaryPolicy(structuredClone(policy))).not.toThrow()
  })

  it.each([
    ['unknown top-level key', (p: typeof policy) => (p.extra = true)],
    ['unknown boundary field', (p: typeof policy) => (p.modules.pdf_text.fullTestReason = 'x')],
    ['non-string source', (p: typeof policy) => (p.modules.pdf_text.sources = [1])],
    ['missing consumer modules', (p: typeof policy) => delete p.modules.pdf_text.consumerModules],
    ['non-boolean literal loaders', (p: typeof policy) => (p.modules.pdf_text.literalLoaders = 1)]
  ])('fails closed on %s', (_, mutate) => {
    const candidate = structuredClone(policy)
    mutate(candidate)
    expect(() => validateBoundaryPolicy(candidate)).toThrow('Invalid module boundary policy')
  })
})

describe('module graph interface', () => {
  // Trusted preflight runs from an exported tree with no installed packages. Lazy import()
  // refinements are guarded fallbacks that run only in the installed test runner.
  it.each([
    'scripts/ci/module-impact-authority.mjs',
    'scripts/ci/package-test-impact.mjs',
    'scripts/ci/windows-e2e-mainline.mjs'
  ])('keeps the trusted closure of %s dependency-free', (entry) => {
    const seen = new Set<string>()
    const bare = new Set<string>()
    const pending = [entry]
    while (pending.length) {
      const file = pending.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      for (const specifier of staticImports(file)) {
        if (specifier.startsWith('.')) pending.push(normalize(join(dirname(file), specifier)))
        else if (!specifier.startsWith('node:')) bare.add(`${file} -> ${specifier}`)
      }
    }
    expect([...bare]).toEqual([])
  })

  // The graph sits below selection and planning. An upward import made index.mjs reach the
  // planner, whose top-level await then deadlocked on its own lazy refinement import.
  it('depends only on lower-level manifest and package readers', () => {
    const lower = ['load-module-impact.mjs', 'local-package-exports.mjs', 'package-test-impact.mjs']
    const upward = execFileSync('git', ['ls-files', 'scripts/ci/module-graph/*.mjs'], {
      encoding: 'utf8'
    })
      .split('\n')
      .filter(Boolean)
      .flatMap((file) =>
        allImports(file)
          .filter((specifier) => specifier.startsWith('../'))
          .filter((specifier) => !lower.includes(specifier.slice(3)))
          .map((specifier) => `${file} -> ${specifier}`)
      )
    expect(upward).toEqual([])
  })

  it.each(['scripts/ci/module-test-impact.mjs', 'scripts/ci/package-host-test-impact.mjs'])(
    'keeps %s out of its own import closure',
    (entry) => {
      const seen = new Set<string>()
      const pending = allImports(entry)
        .filter((specifier) => specifier.startsWith('.'))
        .map((specifier) => normalize(join(dirname(entry), specifier)))
      while (pending.length) {
        const file = pending.pop()!
        if (seen.has(file)) continue
        seen.add(file)
        for (const specifier of allImports(file))
          if (specifier.startsWith('.')) pending.push(normalize(join(dirname(file), specifier)))
      }
      expect(seen.has(normalize(entry))).toBe(false)
    }
  )

  it('is consumed only through index.mjs and policy.mjs', () => {
    const files = execFileSync('git', ['ls-files', '--cached'], { encoding: 'utf8' })
      .split('\n')
      .filter((path) => /\.(?:[cm]?[jt]sx?)$/.test(path) && !path.startsWith('docs/internal/'))
      .filter((path) => !path.startsWith('scripts/ci/module-graph/'))
    const internals = files.flatMap((file) =>
      allImports(file)
        .filter((specifier) => /module-graph\/(?!(?:index|policy)\.mjs$)/.test(specifier))
        .map((specifier) => `${file} -> ${specifier}`)
    )
    expect(internals).toEqual([])
  })
})
