/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Non-authoritative shadow planner: file-level runtime import DAG plus declared dynamic edges.
// Module ownership never selects tests here; it is compared against the registered planner.
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
      '**/*i18n*.test.ts',
      '**/*i18n*.test.tsx',
      '**/*locale*.test.ts',
      '**/*locale*.test.tsx'
    ]
  }
]

export function createDagTestPlan(
  changes,
  { source, reverse, classify = classifyChanges, boundaries = testBoundaries }
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

// Tests the registered planner selects but the DAG does not, labelled by the evidence that put
// them there. `explicit` entries are the candidates for declared dynamic edges.
export function compareTestPlans(legacy, dag, manifest) {
  if (legacy.mode !== 'selective' || dag.mode !== 'selective')
    return { status: 'not-comparable', legacy: legacy.mode, dag: dag.mode }
  const dagTests = new Set(dag.testFiles)
  const legacyTests = new Set(legacy.testFiles)
  const evidence = (test) => {
    const found = []
    for (const id of legacy.modules ?? []) {
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
    legacy: legacy.testFiles.length,
    dag: dag.testFiles.length,
    missing: legacy.testFiles
      .filter((test) => !dagTests.has(test))
      .map((test) => ({ test, evidence: evidence(test) })),
    extra: dag.testFiles.filter((test) => !legacyTests.has(test)),
    unresolved: dag.unresolved
  }
}

// One HEAD snapshot for every commit: both planners see the same graph and registrations, so
// the difference isolates selection policy rather than repository drift.
export function compareRecentCommits({ count = 30, ref = 'HEAD', cwd = process.cwd() } = {}) {
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const source = workingTreeSource(cwd)
  const runtime = Object.entries(
    JSON.parse(readFileSync(`${cwd}/scripts/ci/module-runtime-consumers.json`, 'utf8'))
  )
  const { reverse } = consumerDependencyGraph(source, runtime)
  const manifest = withDerivedConsumers(loadModuleImpactManifest(), loadDerivedConsumers())
  const noGraph = { status: 'not-used', testFiles: [] }
  return git('rev-list', '--first-parent', `--max-count=${count}`, ref)
    .trim()
    .split('\n')
    .map((commit) => {
      const changes = parseNameStatus(git('diff', '--name-status', '-z', `${commit}^`, commit))
      const legacy = createAffectedTestPlan(changes, noGraph, manifest)
      const dag = createDagTestPlan(changes, { source, reverse })
      return {
        commit: commit.slice(0, 10),
        subject: git('log', '-1', '--format=%s', commit).trim(),
        ...compareTestPlans(legacy, dag, manifest)
      }
    })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const count = Number(process.argv[2] ?? 30)
  process.stdout.write(JSON.stringify(compareRecentCommits({ count }), null, 2) + '\n')
}
