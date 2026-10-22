/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Non-authoritative shadow planner: tests reachable from each changed file through runtime
// imports plus declared dynamic edges. Module ownership never selects tests here; the plan is
// compared against the module planner in module-test-impact.mjs.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  classifyChanges,
  fixtureTestPatterns,
  matchesPath,
  parseNameStatus,
  playwrightReaderTests
} from './classify-pr-changes.mjs'
import { loadModuleImpactManifest } from './load-module-impact.mjs'
import { resolveModuleImpactInputs } from './module-impact-inputs.mjs'
import { createAffectedTestPlan } from './module-test-impact.mjs'
import {
  consumerDependencyGraph,
  loadDerivedConsumers,
  withDerivedConsumers,
  workingTreeSource
} from './module-graph/index.mjs'

const isTest = (path) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) && !path.startsWith('e2e/')
const sorted = (values) => [...new Set(values)].sort()
const workflowContractTest = 'scripts/ci/pr-gate-workflow.test.ts'

// Cross-cutting runtimes are verified at their boundary. Reaching one runs its own suites and
// stops there, so a translation edit never selects every consumer that renders a string.
export const testBoundaries = [
  {
    id: 'i18n',
    paths: ['src/shared/i18n/**', 'src/renderer/src/i18n/**'],
    tests: [
      'src/renderer/src/i18n/*.test.ts',
      'src/main/locale/*.test.ts',
      'src/shared/locale.test.ts',
      'scripts/native-locale-assets.test.ts',
      'scripts/build-backend.integration.test.ts',
      '**/*i18n*.test.ts',
      '**/*i18n*.test.tsx',
      '**/*locale*.test.ts',
      '**/*locale*.test.tsx'
    ]
  }
]

// Tests that scan production source files via fs rather than import — they must run whenever
// any file matching their glob changes, regardless of import reachability.
export const sourceReaderTests = [
  {
    // Scans all src/{main,renderer,shared}/** production source via git ls-files + readFileSync.
    paths: ['src/main/**', 'src/renderer/**', 'src/shared/**'],
    excludePattern: /\.(test|spec)\.[cm]?[jt]sx?$/,
    tests: ['src/main/host-layer-dependencies.architecture.test.ts']
  }
]

export function createFileTestPlan(
  changes,
  {
    source,
    reverse,
    classify = classifyChanges,
    boundaries = testBoundaries,
    sourceReaders = sourceReaderTests
  }
) {
  const changePlan = classify(changes)
  if (changePlan.mode === 'full')
    return { mode: 'full', testFiles: [], unresolved: [], reasonChains: changePlan.reasonChains }
  const tests = [...source.files].filter(isTest)
  const selected = new Set()
  const unresolved = []
  const reasons = []
  const boundaryOf = (path) =>
    boundaries.find((boundary) => boundary.paths.some((pattern) => matchesPath(path, pattern)))
  const reach = (start) => {
    const visited = new Set([start])
    const pending = [start]
    const crossed = new Set()
    while (pending.length) {
      const current = pending.pop()
      const boundary = boundaryOf(current)
      if (boundary) {
        crossed.add(boundary)
        continue
      }
      for (const path of reverse.get(current) ?? []) {
        if (visited.has(path)) continue
        visited.add(path)
        pending.push(path)
      }
    }
    return [
      ...[...visited].filter(isTest),
      ...[...crossed].flatMap((boundary) =>
        tests.filter((test) => boundary.tests.some((pattern) => matchesPath(test, pattern)))
      )
    ]
  }
  for (const change of changes) {
    const kind = classify([change])
    // Registration data only describes layering and lanes; it never selects tests.
    if (kind.roots?.includes('module_registration')) continue
    if (change.path === workflowContractTest) {
      selected.add(change.path)
      continue
    }
    if (kind.lanes.includes('docs') && !kind.bundles.includes('unit')) continue
    const readers = playwrightReaderTests(change.path)
    if (readers) {
      for (const test of readers) selected.add(test)
      continue
    }
    for (const path of [change.path, change.previousPath].filter(Boolean)) {
      const fixtures = fixtureTestPatterns(path)
      if (fixtures.length) {
        for (const pattern of fixtures)
          for (const test of pattern.includes('*')
            ? tests.filter((test) => matchesPath(test, pattern))
            : [pattern])
            selected.add(test)
        reasons.push(`${path} -> fixture readers`)
        continue
      }
      if (!source.files.has(path)) {
        unresolved.push(path)
        continue
      }
      // Source-scanning tests observe any production file in their glob via fs, not import.
      for (const reader of sourceReaders) {
        if (
          !reader.excludePattern?.test(path) &&
          reader.paths.some((pattern) => matchesPath(path, pattern))
        ) {
          for (const test of reader.tests) selected.add(test)
          reasons.push(`${path} -> source-reader ${reader.tests.join(', ')}`)
        }
      }
      const reached = reach(path)
      for (const test of reached) selected.add(test)
      reasons.push(`${path} -> ${reached.length} runtime-reachable tests`)
    }
  }
  return {
    mode: 'selective',
    testFiles: sorted(selected),
    unresolved: sorted(unresolved),
    reasonChains: reasons
  }
}

// Tests the module planner selects but the file planner does not, labelled by the evidence that
// put them there. Explicit entries are the candidates for declared dynamic edges.
export function compareTestPlans(modulePlan, filePlan, manifest) {
  if (modulePlan.mode !== 'selective' || filePlan.mode !== 'selective')
    return { status: 'not-comparable', module: modulePlan.mode, file: filePlan.mode }
  const fileTests = new Set(filePlan.testFiles)
  const moduleTests = new Set(modulePlan.testFiles)
  const evidence = (test) => {
    const found = []
    for (const id of modulePlan.modules ?? []) {
      const module = manifest.modules[id]
      if ((module.derivedConsumerTests ?? []).includes(test)) found.push(`${id}:derived`)
      else
        for (const kind of ['owner', 'contract', 'consumer'])
          if (module.testFiles[kind].includes(test)) found.push(`${id}:${kind}`)
    }
    return found.length ? found : ['direct']
  }
  return {
    status: 'compared',
    module: modulePlan.testFiles.length,
    file: filePlan.testFiles.length,
    missing: modulePlan.testFiles
      .filter((test) => !fileTests.has(test))
      .map((test) => ({ test, evidence: evidence(test) })),
    extra: filePlan.testFiles.filter((test) => !moduleTests.has(test)),
    unresolved: filePlan.unresolved
  }
}

// One HEAD snapshot for every commit: both planners see the same graph and registrations, so
// the difference isolates selection policy rather than repository drift. Inputs resolve as the
// PR Gate does, so an accepted derived index or registration-only diff is not a global input.
export function compareRecentCommits({ count = 30, ref = 'HEAD', cwd = process.cwd() } = {}) {
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const source = workingTreeSource(cwd)
  const runtime = Object.entries(
    JSON.parse(readFileSync(`${cwd}/scripts/ci/module-runtime-consumers.json`, 'utf8'))
  )
  const { reverse } = consumerDependencyGraph(source, runtime)
  const derivedConsumers = loadDerivedConsumers()
  const manifest = loadModuleImpactManifest()
  const noGraph = { status: 'not-used', testFiles: [] }
  return git('rev-list', '--first-parent', `--max-count=${count}`, ref)
    .trim()
    .split('\n')
    .map((commit) => {
      const raw = parseNameStatus(git('diff', '--name-status', '-z', `${commit}^`, commit))
      const inputs = resolveModuleImpactInputs(raw, {
        base: `${commit}^`,
        head: commit,
        cwd,
        manifest,
        derivedConsumers
      })
      const effective = inputs.manifest ?? withDerivedConsumers(manifest, derivedConsumers)
      const registration = {
        moduleManifest: effective,
        registrationModules: inputs.registrationModules,
        registrationOnly: inputs.registrationOnly
      }
      const modulePlan = createAffectedTestPlan(
        inputs.changes,
        noGraph,
        effective,
        inputs.registrationModules,
        inputs.registrationOnly
      )
      const filePlan = inputs.registrationOnly
        ? { mode: 'selective', testFiles: [], unresolved: [], reasonChains: [] }
        : createFileTestPlan(inputs.changes, {
            source,
            reverse,
            classify: (changes) => classifyChanges(changes, undefined, registration)
          })
      return {
        commit: commit.slice(0, 10),
        subject: git('log', '-1', '--format=%s', commit).trim(),
        ...(inputs.derivedIndexAccepted && { derivedIndexAccepted: true }),
        ...compareTestPlans(modulePlan, filePlan, effective)
      }
    })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const count = Number(process.argv[2] ?? 30)
  process.stdout.write(JSON.stringify(compareRecentCommits({ count }), null, 2) + '\n')
}
