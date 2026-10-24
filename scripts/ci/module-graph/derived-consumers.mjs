/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import {
  loadModuleImpactManifest,
  loadModuleImpactManifestAtRevision
} from '../load-module-impact.mjs'
import assert from 'node:assert/strict'
import { dependencyBoundaryViolations } from './boundary-evidence.mjs'
import {
  derivedConsumersPath,
  loadDerivedConsumers,
  validateDerivedConsumers,
  withDerivedConsumers
} from './derived-index.mjs'
import { createDependencyReader } from './dependency-reader.mjs'
import { isSourcePath, sourceSnapshot, workingTreeSource } from './source.mjs'

const isTest = (path) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) && !path.startsWith('e2e/')

// The derived consumer index follows runtime edges only. A test that reaches a contract
// solely through erased type imports cannot observe its behavior at runtime; typecheck
// enforces the type contract independently.
export function consumerDependencyGraph(source, runtimeEdges) {
  for (const [target, consumers] of runtimeEdges) {
    if (
      !source.files.has(target) ||
      !Array.isArray(consumers) ||
      consumers.some((p) => !source.files.has(p))
    )
      throw Error(`Invalid runtime consumer edge: ${target}`)
  }
  const inspect = createDependencyReader(source, runtimeEdges, { runtimeOnly: true })
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
  const runtimeEdges = Object.entries(
    JSON.parse(source.read('scripts/ci/module-runtime-consumers.json'))
  )
  const graph = consumerDependencyGraph(source, runtimeEdges)
  const text = source.read(derivedConsumersPath)
  if (text === undefined) {
    // Distinguish genuinely absent from a tracked non-regular entry (e.g. a symlink).
    // source.files includes every tracked path regardless of mode; read() returns undefined
    // only for non-regular entries. A symlink must be rejected, not treated as absent.
    if (source.files.has(derivedConsumersPath))
      throw Error('Derived consumer index must be a regular file')
    // Index absent (runtime-generated, not committed). Validate the graph itself is correct
    // so integrity is not a no-op: the generated result must pass schema validation.
    const expected = generateDerivedConsumers(manifest, graph.reverse)
    validateDerivedConsumers(expected, manifest)
  } else {
    const actual = validateDerivedConsumers(JSON.parse(text), manifest)
    const expected = generateDerivedConsumers(manifest, graph.reverse)
    if (!isDeepStrictEqual(actual, expected))
      throw Error('Stale derived consumer index; run npm run generate:module-consumers')
  }
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
  if (!paths.length || paths.some(isSourcePath)) return false

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

// Older bases without an index remain supported. The index may be deleted once generation
// moves to runtime; CI Integrity only validates staleness when it exists at the head revision.
export function checkDerivedConsumerRevisions(base, head, cwd = process.cwd()) {
  const hasIndex = (revision) =>
    execFileSync('git', ['ls-tree', '--name-only', revision, '--', derivedConsumersPath], {
      cwd,
      encoding: 'utf8'
    }).trim() === derivedConsumersPath
  if (!hasIndex(head)) return
  const mergeBase = execFileSync('git', ['merge-base', base, head], {
    cwd,
    encoding: 'utf8'
  }).trim()
  if (derivedConsumerInputsUnchanged(mergeBase, head, cwd)) return
  checkDerivedConsumersAtRevision(head, cwd)
}

// This guard supplements the explicit IPC/behavioral contracts in the manifest. It does not
// claim that imports can discover event dispatch, filesystem protocols or dynamic strings.
export function checkModuleConsumerCoverage({
  source = workingTreeSource(),
  manifest = loadModuleImpactManifest(),
  derived = loadDerivedConsumers()
} = {}) {
  assert.deepEqual(
    dependencyBoundaryViolations(source, manifest),
    [],
    'Source-derived module boundary changed'
  )
  const { reverse } = checkDerivedConsumers(source, manifest)
  // When the committed index is absent (runtime generation), derive coverage from the graph so
  // the whole-tree guard still proves every reachable test has a home in explicit or derived evidence.
  const effectiveDerived = Object.keys(derived.modules).length
    ? derived
    : generateDerivedConsumers(manifest, reverse)
  const { modules } = withDerivedConsumers(manifest, effectiveDerived)
  for (const [path, consumers] of reverse) {
    if (!isTest(path) || consumers.size === 0 || !/^(src|packages)\//.test(path)) continue
    assert.ok(
      Object.values(modules).some(
        (module) => module.ownerPaths.includes(path) && module.interfacePaths.includes(path)
      ),
      `${path} exports shared test contracts; register it as an interface to retain consumers`
    )
  }
  const missing = []
  for (const [id, module] of Object.entries(modules)) {
    if (module.fullTestReason || id === 'i18n_catalog') continue
    const visited = new Set(
      module.ownerPaths.filter((path) => !isTest(path) || module.interfacePaths.includes(path))
    )
    const pending = [...visited]
    while (pending.length) {
      for (const consumer of reverse.get(pending.pop()) ?? []) {
        if (visited.has(consumer)) continue
        visited.add(consumer)
        pending.push(consumer)
      }
    }
    // Require complete coverage, not minimal coverage. Only trusted base/head evidence can
    // authorize retirement; current independence alone cannot remove historical host contracts.
    const declared = new Set(Object.values(module.testFiles).flat())
    for (const path of visited)
      if (isTest(path) && !declared.has(path)) missing.push(`${id} -> ${path}`)
  }
  assert.deepEqual(missing, [], 'Regenerate derived consumers or add explicit behavioral contracts')
}

// The index is formatted like every other committed JSON file, so that regenerating it can never
// fail the repository format check. Prettier is a devDependency, never part of trusted preflight.
function formatIndexJson(text) {
  // Format as the repository path, not the destination: a checkout under /tmp would otherwise
  // match the `tmp` .prettierignore entry and Prettier would echo the input unformatted.
  const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
  const prettier = resolve(repositoryRoot, 'node_modules/prettier/bin/prettier.cjs')
  return execFileSync(process.execPath, [prettier, '--stdin-filepath', derivedConsumersPath], {
    cwd: repositoryRoot,
    input: text,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
}

// --write regenerates the index; --check validates it; --coverage runs the whole-tree guard.
export function runDerivedConsumersCli(args = process.argv.slice(2), cwd = process.cwd()) {
  if (args.length === 1 && args[0] === '--coverage') return checkModuleConsumerCoverage()
  if (args.length !== 1 || !['--write', '--check'].includes(args[0]))
    throw Error('Use --write or --check')
  const source = workingTreeSource(cwd)
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
    writeFileSync(destination, formatIndexJson(JSON.stringify(index, null, 2) + '\n'))
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
