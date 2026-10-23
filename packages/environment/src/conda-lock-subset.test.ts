import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CondaEnvironmentDependencyGraph, NotebookEnvironmentLock } from './contracts'
import {
  captureCondaDependencyGraph,
  condaRuntimeSubsetPlanMatchesLock,
  deriveCondaRuntimeSubsetPlan,
  selectCondaEnvironmentLock
} from './conda-lock-subset'
import { decodeNotebookEnvironmentLock } from './environment-lock'

const fixture = (): NotebookEnvironmentLock => {
  const packages: CondaEnvironmentDependencyGraph['packages'] = [
    ['r-base', ['libpng >=1.0,<2.0a0', '__osx >=11.0', '__unix']],
    ['r-jsonlite', ['r-base >=1.0']],
    ['libpng', ['_lib_mutex 1.* build_0']],
    ['_lib_mutex', []],
    ['bioconductor-deseq2', ['r-base', 'r-unused']],
    ['r-unused', []]
  ].map(([name, depends]) => ({
    name: name as string,
    version: '1.0',
    build: 'build_0',
    url: `https://conda.example/osx-arm64/${name}-1.0-build_0.conda`,
    md5: 'a'.repeat(32),
    depends: depends as string[]
  }))
  return {
    schemaVersion: 1,
    format: 'environment-lock-bundle',
    kernelKind: 'r',
    environmentName: 'analysis-r',
    platform: 'darwin',
    architecture: 'arm64',
    components: [
      {
        ecosystem: 'conda',
        format: 'conda-explicit-md5',
        resolution: 'locked',
        explicitLock:
          '@EXPLICIT\n' +
          packages
            .map((pkg) => `${pkg.url}#${pkg.md5}`)
            .sort()
            .join('\n') +
          '\n',
        packages: packages.map((pkg) => pkg.name.replace(/[-_.]+/gu, '-')).sort(),
        dependencyGraph: { schemaVersion: 1, packages }
      }
    ]
  }
}
const conda = (
  lock: NotebookEnvironmentLock
): Extract<NotebookEnvironmentLock['components'][number], { ecosystem: 'conda' }> => {
  const component = lock.components[0]!
  if (component.ecosystem !== 'conda') throw new Error('Expected Conda fixture')
  return component
}

describe('selectCondaEnvironmentLock', () => {
  it('projects exact R ownership alongside selected archives without assuming R and Conda versions match', () => {
    const lock = fixture()
    conda(lock).dependencyGraph!.rPackageOwnership = {
      schemaVersion: 1,
      packages: [
        { name: 'base', version: '4.5.3', condaPackage: 'r-base' },
        { name: 'jsonlite', version: '2.0.0', condaPackage: 'r-jsonlite' },
        { name: 'DESeq2', version: '1.50.2', condaPackage: 'bioconductor-deseq2' }
      ]
    }
    const selected = selectCondaEnvironmentLock(lock, ['r-base', 'r-jsonlite'])!
    expect(
      conda(selected).dependencyGraph!.rPackageOwnership!.packages.map(({ name }) => name)
    ).toEqual(['base', 'jsonlite'])
    expect(decodeNotebookEnvironmentLock(JSON.stringify(selected)).status).toBe('valid')
    expect(conda(lock).dependencyGraph!.rPackageOwnership!.packages).toHaveLength(3)
  })

  it.each(['duplicate', 'owner', 'version', 'schema', 'extra'])(
    'does not certify malformed R ownership: %s',
    (scenario) => {
      const lock = fixture()
      const ownership = {
        schemaVersion: scenario === 'schema' ? 2 : 1,
        packages: [
          {
            name: 'base',
            version: scenario === 'version' ? '../bad' : '4.5.3',
            condaPackage: scenario === 'owner' ? 'absent' : 'r-base',
            ...(scenario === 'extra' ? { guessed: true } : {})
          }
        ]
      }
      if (scenario === 'duplicate') ownership.packages.push({ ...ownership.packages[0]! })
      Object.assign(conda(lock).dependencyGraph!, { rPackageOwnership: ownership })
      expect(decodeNotebookEnvironmentLock(JSON.stringify(lock)).status).toBe('corrupt')
      expect(selectCondaEnvironmentLock(lock, ['r-base', 'r-jsonlite'])).toBeUndefined()
    }
  )
  it('retains the exact transitive runtime/archive closure without unrelated R packages or mutation', () => {
    const lock = fixture()
    const original = JSON.stringify(lock)
    const selected = selectCondaEnvironmentLock(lock, ['r-base', 'r-jsonlite'])!
    expect(selected).toBeDefined()
    expect(conda(selected).packages).toEqual(['-lib-mutex', 'libpng', 'r-base', 'r-jsonlite'])
    expect(conda(selected).dependencyGraph?.packages.map((pkg) => pkg.name)).toEqual([
      '_lib_mutex',
      'libpng',
      'r-base',
      'r-jsonlite'
    ])
    expect(conda(selected).explicitLock).not.toMatch(/deseq2|unused/u)
    expect(
      conda(selected).dependencyGraph?.packages.find((pkg) => pkg.name === 'r-base')?.depends
    ).toContain('__osx >=11.0')
    expect(decodeNotebookEnvironmentLock(JSON.stringify(selected)).status).toBe('valid')
    expect(JSON.stringify(lock)).toBe(original)
    conda(selected).dependencyGraph!.packages[0]!.depends.push('changed')
    expect(JSON.stringify(lock)).toBe(original)
  })

  it('terminates dependency cycles while preserving their full closure', () => {
    const lock = fixture()
    conda(lock).dependencyGraph!.packages.find((pkg) => pkg.name === '_lib_mutex')!.depends = [
      'libpng'
    ]
    expect(
      conda(selectCondaEnvironmentLock(lock, ['r-base', 'r-jsonlite'])!).packages
    ).toHaveLength(4)
  })

  it.each([
    'legacy',
    'python',
    'native',
    'untracked',
    'omitted',
    'installer',
    'missing-root',
    'missing-protocol'
  ])('refuses unsupported or incomplete selection: %s', (scenario) => {
    const lock = fixture()
    if (scenario === 'legacy') delete conda(lock).dependencyGraph
    if (scenario === 'python') lock.kernelKind = 'python'
    if (scenario === 'native')
      lock.components.push({ ecosystem: 'r', format: 'renv-lock', resolution: 'locked', files: [] })
    if (scenario === 'untracked') lock.untrackedPackages = ['r:custom']
    if (scenario === 'omitted') lock.omittedPackages = ['r:custom']
    if (scenario === 'installer') lock.nonCondaInstallers = ['biocmanager']
    const roots =
      scenario === 'missing-root'
        ? ['r-base', 'absent']
        : scenario === 'missing-protocol'
          ? ['r-base']
          : ['r-base', 'r-jsonlite']
    expect(selectCondaEnvironmentLock(lock, roots)).toBeUndefined()
    if (scenario === 'legacy')
      expect(decodeNotebookEnvironmentLock(JSON.stringify(lock)).status).toBe('valid')
  })

  it.each([
    'url',
    'md5',
    'version',
    'build',
    'duplicate',
    'missing-node',
    'missing-dependency',
    'unsupported-spec',
    'malformed-spec',
    'packages',
    'extra-archive'
  ])('rejects graph/lock identity inconsistency: %s', (scenario) => {
    const lock = fixture()
    const component = conda(lock)
    const packages = component.dependencyGraph!.packages
    const pkg = packages[0]!
    if (scenario === 'url') pkg.url = pkg.url.replace('conda.example', 'different.example')
    if (scenario === 'md5') pkg.md5 = 'b'.repeat(32)
    if (scenario === 'version') pkg.version = '99.0'
    if (scenario === 'build') pkg.build = 'other_0'
    if (scenario === 'duplicate') packages.push({ ...pkg })
    if (scenario === 'missing-node') packages.pop()
    if (scenario === 'missing-dependency') packages.at(-1)!.depends = ['missing']
    if (scenario === 'unsupported-spec') pkg.depends.push('conda-forge::libpng[version=">=1"]')
    if (scenario === 'malformed-spec') pkg.depends.push('libpng >=')
    if (scenario === 'packages') component.packages[0] = 'different'
    if (scenario === 'extra-archive')
      component.explicitLock += 'https://conda.example/extra.conda#' + 'a'.repeat(32) + '\n'
    expect(selectCondaEnvironmentLock(lock, ['r-base', 'r-jsonlite'])).toBeUndefined()
    expect(decodeNotebookEnvironmentLock(JSON.stringify(lock)).status).toBe('corrupt')
  })
})

describe('Conda runtime subset candidates', () => {
  const sourceLockChecksum = 'a'.repeat(64)
  const scopeChecksum = 'b'.repeat(64)
  const archives = ['r-jsonlite-1.0-build_0.conda', 'r-base-1.0-build_0.conda']

  it('retains original edges and records omitted dependencies without weakening full-lock validation', () => {
    const lock = fixture()
    const original = JSON.stringify(lock)
    const plan = deriveCondaRuntimeSubsetPlan(lock, sourceLockChecksum, scopeChecksum, archives)!
    expect(plan.archiveNames).toEqual([...archives].sort())
    expect(plan.explicitLock).toBe(
      '@EXPLICIT\n' +
        plan.packages
          .map((pkg) => `${pkg.url}#${pkg.md5}`)
          .sort()
          .join('\n') +
        '\n'
    )
    expect(plan.packages.find((pkg) => pkg.name === 'r-base')!.depends).toEqual([
      'libpng >=1.0,<2.0a0',
      '__osx >=11.0',
      '__unix'
    ])
    expect(plan.missingDependencies).toEqual([
      { packageName: 'r-base', dependency: 'libpng >=1.0,<2.0a0' }
    ])
    expect(condaRuntimeSubsetPlanMatchesLock(JSON.parse(JSON.stringify(plan)), lock)).toBe(true)
    expect(decodeNotebookEnvironmentLock(original).status).toBe('valid')
    const incompleteLock = structuredClone(lock)
    Object.assign(conda(incompleteLock), {
      explicitLock: plan.explicitLock,
      packages: plan.packages.map((pkg) => pkg.name),
      dependencyGraph: { schemaVersion: 1, packages: plan.packages }
    })
    expect(decodeNotebookEnvironmentLock(JSON.stringify(incompleteLock)).status).toBe('corrupt')
    plan.packages[0]!.depends.push('changed')
    expect(JSON.stringify(lock)).toBe(original)
  })

  it('projects only captured R ownership of selected archives and canonicalizes selection order', () => {
    const lock = fixture()
    conda(lock).dependencyGraph!.rPackageOwnership = {
      schemaVersion: 1,
      packages: [
        { name: 'base', version: '4.5.3', condaPackage: 'r-base' },
        { name: 'Unused', version: '2.0', condaPackage: 'r-unused' }
      ]
    }
    const plan = deriveCondaRuntimeSubsetPlan(lock, sourceLockChecksum, scopeChecksum, archives)!
    expect(plan.rPackageOwnership!.packages).toEqual([
      { name: 'base', version: '4.5.3', condaPackage: 'r-base' }
    ])
    expect(
      deriveCondaRuntimeSubsetPlan(lock, sourceLockChecksum, scopeChecksum, [...archives].reverse())
    ).toEqual(plan)
    plan.rPackageOwnership!.packages[0]!.version = 'changed'
    expect(conda(lock).dependencyGraph!.rPackageOwnership!.packages[0]!.version).toBe('4.5.3')
  })

  it('accepts exact tar.bz2 identities and a full inventory without missing dependency edges', () => {
    const lock = fixture()
    const component = conda(lock)
    const pkg = component.dependencyGraph!.packages.find((pkg) => pkg.name === 'r-jsonlite')!
    pkg.url = pkg.url.replace('.conda', '.tar.bz2')
    component.explicitLock = component.explicitLock.replace(
      'r-jsonlite-1.0-build_0.conda',
      'r-jsonlite-1.0-build_0.tar.bz2'
    )
    const names = component.dependencyGraph!.packages.map((pkg) =>
      new URL(pkg.url).pathname.split('/').at(-1)!
    )
    const plan = deriveCondaRuntimeSubsetPlan(lock, sourceLockChecksum, scopeChecksum, names)!
    expect(plan).toBeDefined()
    expect(plan.missingDependencies).toEqual([])
    expect(plan.archiveNames).toContain('r-jsonlite-1.0-build_0.tar.bz2')
    const reordered = Object.fromEntries(Object.entries(plan).reverse())
    expect(condaRuntimeSubsetPlanMatchesLock(JSON.parse(JSON.stringify(reordered)), lock)).toBe(
      true
    )
  })

  it.each([
    'empty',
    'duplicate',
    'oversized',
    'unknown',
    'path',
    'url',
    'missing-runtime',
    'missing-protocol',
    'hash',
    'scope',
    'legacy',
    'python',
    'mixed',
    'native',
    'omitted',
    'installer',
    'external-runtime',
    'corrupt-source'
  ])('rejects unsupported candidate input: %s', (scenario) => {
    const lock = fixture()
    let names = [...archives]
    if (scenario === 'empty') names = []
    if (scenario === 'duplicate') names.push(names[0]!)
    if (scenario === 'oversized') names = Array.from({ length: 10001 }, (_, i) => `${i}.conda`)
    if (scenario === 'unknown') names.push('absent-1.0-build_0.conda')
    if (scenario === 'path') names[0] = `../${names[0]}`
    if (scenario === 'url') names[0] = `https://conda.example/${names[0]}`
    if (scenario === 'missing-runtime') names = [archives[0]!]
    if (scenario === 'missing-protocol') names = [archives[1]!]
    if (scenario === 'legacy') delete conda(lock).dependencyGraph
    if (scenario === 'python') lock.kernelKind = 'python'
    if (scenario === 'mixed') lock.untrackedPackages = ['r:custom']
    if (scenario === 'native')
      lock.components.push({ ecosystem: 'r', format: 'renv-lock', resolution: 'locked', files: [] })
    if (scenario === 'omitted') lock.omittedPackages = ['r:custom']
    if (scenario === 'installer') lock.nonCondaInstallers = ['cran']
    if (scenario === 'external-runtime')
      lock.externalRuntime = { version: '4.5.3', installerVersion: '1.0.0' }
    if (scenario === 'corrupt-source')
      conda(lock).dependencyGraph!.packages[0]!.depends.push('unknown')
    expect(
      deriveCondaRuntimeSubsetPlan(
        lock,
        scenario === 'hash' ? 'invalid' : sourceLockChecksum,
        scenario === 'scope' ? 'invalid' : scopeChecksum,
        names
      )
    ).toBeUndefined()
  })

  it.each([
    'schema',
    'format',
    'extra',
    'archive',
    'url',
    'md5',
    'version',
    'depends',
    'missing',
    'ownership',
    'scope'
  ])('rejects tampered deserialized candidate fields: %s', (scenario) => {
    const lock = fixture()
    const plan = deriveCondaRuntimeSubsetPlan(lock, sourceLockChecksum, scopeChecksum, archives)!
    const changed = JSON.parse(JSON.stringify(plan))
    if (scenario === 'schema') changed.schemaVersion = 2
    if (scenario === 'format') changed.format = 'environment-lock-bundle'
    if (scenario === 'extra') changed.certified = true
    if (scenario === 'archive') changed.archiveNames.push(changed.archiveNames[0])
    if (scenario === 'url') changed.packages[0].url = 'https://other.example/package.conda'
    if (scenario === 'md5') changed.packages[0].md5 = 'c'.repeat(32)
    if (scenario === 'version') changed.packages[0].version = '9.0'
    if (scenario === 'depends') changed.packages[0].depends = []
    if (scenario === 'missing') changed.missingDependencies = []
    if (scenario === 'ownership') changed.rPackageOwnership = { schemaVersion: 1, packages: [] }
    if (scenario === 'scope') changed.scopeChecksum = 'invalid'
    expect(condaRuntimeSubsetPlanMatchesLock(changed, lock)).toBe(false)
  })
})

describe('captureCondaDependencyGraph', () => {
  it.each([
    'complete',
    'duplicate-owner',
    'wrong-name',
    'linked-description',
    'linked-package',
    'missing-description'
  ])('binds archive ownership to ordinary installed DESCRIPTION identity: %s', async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'conda-r-ownership-'))
    try {
      const component = conda(fixture())
      const directory = join(root, 'conda-meta')
      await mkdir(directory)
      const descriptionPath = 'lib/R/library/DESeq2/DESCRIPTION'
      const description = join(root, descriptionPath)
      await mkdir(join(root, 'lib/R/library/DESeq2'), { recursive: true })
      const text = `Package: ${scenario === 'wrong-name' ? 'Different' : 'DESeq2'}\nVersion: 1.50.2\n`
      if (scenario !== 'missing-description') await writeFile(description, text)
      if (scenario === 'linked-description') {
        await rm(description)
        const target = join(root, 'elsewhere-description')
        await writeFile(target, text)
        await symlink(target, description)
      }
      if (scenario === 'linked-package') {
        const target = join(root, 'elsewhere-package')
        await mkdir(target)
        await writeFile(join(target, 'DESCRIPTION'), text)
        await rm(join(root, 'lib/R/library/DESeq2'), { recursive: true })
        await symlink(target, join(root, 'lib/R/library/DESeq2'))
      }
      for (const pkg of component.dependencyGraph!.packages) {
        await writeFile(
          join(directory, `${pkg.name}-${pkg.version}-${pkg.build}.json`),
          JSON.stringify({
            ...pkg,
            files:
              pkg.name === 'bioconductor-deseq2' ||
              (scenario === 'duplicate-owner' && pkg.name === 'r-unused')
                ? [descriptionPath]
                : []
          })
        )
      }
      const graph = await captureCondaDependencyGraph(root, component)
      expect(graph).toBeDefined()
      if (scenario === 'complete')
        expect(graph!.rPackageOwnership).toEqual({
          schemaVersion: 1,
          packages: [{ name: 'DESeq2', version: '1.50.2', condaPackage: 'bioconductor-deseq2' }]
        })
      else expect(graph!.rPackageOwnership).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it.each([
    'complete',
    'large-inventory',
    'oversized-record',
    'missing',
    'mismatch',
    'version-mismatch',
    'unsupported',
    'extra',
    'linked'
  ])('certifies only a complete ordinary-file metadata inventory: %s', async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), 'conda-graph-'))
    try {
      const component = conda(fixture())
      const directory = join(root, 'conda-meta')
      await mkdir(directory)
      for (const original of component.dependencyGraph!.packages) {
        const pkg = structuredClone(original)
        if (pkg.name === 'r-base') {
          if (scenario === 'missing') continue
          if (scenario === 'mismatch') pkg.md5 = 'b'.repeat(32)
          if (scenario === 'unsupported') pkg.depends = ['some-channel::package']
        }
        const path = join(directory, `${pkg.name}-${pkg.version}-${pkg.build}.json`)
        if (scenario === 'linked' && pkg.name === 'r-base') {
          const target = join(root, 'linked-record.json')
          await writeFile(target, JSON.stringify(pkg))
          await symlink(target, path)
        } else
          await writeFile(
            path,
            JSON.stringify({
              ...pkg,
              ...(pkg.name === 'r-base' &&
              ['large-inventory', 'oversized-record'].includes(scenario)
                ? { files: ['x'.repeat((scenario === 'large-inventory' ? 6 : 9) * 1024 * 1024)] }
                : {})
            })
          )
      }
      if (scenario === 'extra') await writeFile(join(directory, 'unregistered.json'), '{}')
      const versions = scenario === 'version-mismatch' ? new Map([['r-base', '99.0']]) : undefined
      const captured = await captureCondaDependencyGraph(root, component, versions)
      if (scenario === 'complete' || scenario === 'large-inventory')
        expect(captured).toEqual({
          schemaVersion: 1,
          packages: [...component.dependencyGraph!.packages].sort((a, b) =>
            a.name.localeCompare(b.name)
          )
        })
      else expect(captured).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
