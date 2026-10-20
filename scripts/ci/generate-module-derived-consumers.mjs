/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import {
  createConsumerDependencyReader,
  isConsumerSourcePath,
  sourceSnapshot
} from './consumer-retirement.mjs'
import {
  loadModuleImpactManifest,
  loadModuleImpactManifestAtRevision
} from './load-module-impact.mjs'
import { derivedConsumersPath, validateDerivedConsumers } from './module-derived-consumers.mjs'

const isTest = (path) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) && !path.startsWith('e2e/')

export function consumerDependencyGraph(source, runtimeEdges) {
  for (const [target, consumers] of runtimeEdges) {
    if (
      !source.files.has(target) ||
      !Array.isArray(consumers) ||
      consumers.some((p) => !source.files.has(p))
    )
      throw Error(`Invalid runtime consumer edge: ${target}`)
  }
  const inspect = createConsumerDependencyReader(source, runtimeEdges)
  const reverse = new Map()
  for (const path of source.files) {
    if (!/\.[cm]?[jt]sx?$/.test(path)) continue
    // Discover known edges even in opaque cones. This never proves a contract can retire.
    for (const dependency of inspect.dependencies(path).paths) {
      if (!reverse.has(dependency)) reverse.set(dependency, new Set())
      reverse.get(dependency).add(path)
    }
  }
  // Runtime declarations may include native/generated intermediates, not only JS files.
  for (const [target, consumers] of runtimeEdges) {
    if (!reverse.has(target)) reverse.set(target, new Set())
    for (const consumer of consumers) reverse.get(target).add(consumer)
  }
  return { reverse, inspect }
}

export function generateDerivedConsumers(manifest, reverse) {
  const modules = {}
  for (const id of Object.keys(manifest.modules).sort()) {
    const module = manifest.modules[id]
    if (module.fullTestReason || id === 'i18n_catalog') continue
    const visited = new Set(
      module.ownerPaths.filter((p) => !isTest(p) || module.interfacePaths.includes(p))
    )
    const pending = [...visited]
    while (pending.length) {
      for (const path of reverse.get(pending.pop()) ?? []) {
        if (visited.has(path)) continue
        visited.add(path)
        pending.push(path)
      }
    }
    // Existing explicit evidence remains authoritative; store only additional derived membership.
    const explicit = new Set(Object.values(module.testFiles).flat())
    const tests = [...visited].filter((p) => isTest(p) && !explicit.has(p)).sort()
    if (tests.length) modules[id] = tests
  }
  return { schemaVersion: 1, modules }
}

export function checkDerivedConsumers(source, manifest) {
  const text = source.read(derivedConsumersPath)
  if (text === undefined) throw Error('Missing derived consumer index')
  const actual = validateDerivedConsumers(JSON.parse(text), manifest)
  const runtimeEdges = Object.entries(
    JSON.parse(source.read('scripts/ci/module-runtime-consumers.json'))
  )
  const graph = consumerDependencyGraph(source, runtimeEdges)
  const expected = generateDerivedConsumers(manifest, graph.reverse)
  if (!isDeepStrictEqual(actual, expected))
    throw Error('Stale derived consumer index; run npm run generate:module-consumers')
  return graph
}

export function checkDerivedConsumersAtRevision(revision, cwd = process.cwd()) {
  const source = sourceSnapshot(revision, cwd)
  // Older repositories/bases predate the index. A candidate cannot delete an established index.
  checkDerivedConsumers(source, loadModuleImpactManifestAtRevision(revision, { cwd }))
}

function derivedConsumerInputsUnchanged(base, head, cwd) {
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  // Disable rename detection so both the old and new paths must qualify.
  const paths = git('diff', '--no-renames', '--name-only', '-z', base, head)
    .split('\0')
    .filter(Boolean)
  if (!paths.length || paths.some(isConsumerSourcePath)) return false

  // Reuse the reader's input boundary, not a documentation directory/extension allowlist.
  // Source text, JSON configuration, registrations and the index itself are unchanged.
  const manifest = loadModuleImpactManifestAtRevision(base, { cwd })
  const runtime = JSON.parse(git('show', `${base}:scripts/ci/module-runtime-consumers.json`))

  // Resource presence still affects import resolution and runtime edges. Recompute both
  // snapshots to catch additions/deletions, including images shadowing icon.svg.ts.
  const expectedAt = (revision) =>
    generateDerivedConsumers(
      manifest,
      consumerDependencyGraph(sourceSnapshot(revision, cwd), Object.entries(runtime)).reverse
    )
  return isDeepStrictEqual(expectedAt(base), expectedAt(head))
}

// Older bases without an index remain supported; once introduced it cannot disappear.
export function checkDerivedConsumerRevisions(base, head, cwd = process.cwd()) {
  const hasIndex = (revision) =>
    execFileSync('git', ['ls-tree', '--name-only', revision, '--', derivedConsumersPath], {
      cwd,
      encoding: 'utf8'
    }).trim() === derivedConsumersPath
  const mergeBase = execFileSync('git', ['merge-base', base, head], {
    cwd,
    encoding: 'utf8'
  }).trim()
  if (hasIndex(mergeBase) || hasIndex(head)) {
    if (derivedConsumerInputsUnchanged(mergeBase, head, cwd)) return
    checkDerivedConsumersAtRevision(head, cwd)
  }
}

export function workingConsumerSource(cwd = process.cwd()) {
  const files = new Set(
    execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    })
      .split('\0')
      .filter((path) => path && existsSync(resolve(cwd, path)))
  )
  return {
    files,
    read: (path) => {
      const full = resolve(cwd, path)
      return files.has(path) && lstatSync(full).isFile() ? readFileSync(full, 'utf8') : undefined
    }
  }
}

export function runDerivedConsumersCli(args = process.argv.slice(2), cwd = process.cwd()) {
  if (args.length !== 1 || !['--write', '--check'].includes(args[0]))
    throw Error('Use --write or --check')
  const source = workingConsumerSource(cwd)
  const manifest = loadModuleImpactManifest(resolve(cwd, 'scripts/ci/module-impact.json'))
  if (args[0] === '--check') checkDerivedConsumers(source, manifest)
  else {
    const edges = Object.entries(
      JSON.parse(source.read('scripts/ci/module-runtime-consumers.json'))
    )
    const index = generateDerivedConsumers(manifest, consumerDependencyGraph(source, edges).reverse)
    const destination = resolve(cwd, derivedConsumersPath)
    if (existsSync(destination) && !lstatSync(destination).isFile())
      throw Error('Index must be a regular file')
    writeFileSync(destination, JSON.stringify(index, null, 2) + '\n')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runDerivedConsumersCli()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
