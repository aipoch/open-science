/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Non-authoritative shadow planner: tests reachable from each changed file through runtime
// imports plus declared dynamic edges. Module ownership never selects tests here; the plan is
// compared against the module planner in module-test-impact.mjs.
import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  classifyChanges,
  fixtureTestPatterns,
  matchesPath,
  playwrightReaderTests
} from './classify-pr-changes.mjs'
import { resolveAffectedTestPlan } from './module-test-impact.mjs'
import {
  consumerDependencyGraph,
  sourceSnapshot,
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

// Tests that reach files by value — fs reads or a computed import() path — instead of a static
// import. A change to any matching path runs every matching test, whatever the import graph says.
export const dynamicReaders = [
  {
    reason: 'scans production source with git ls-files and readFileSync',
    paths: ['src/main/**', 'src/renderer/**', 'src/shared/**'],
    exclude: ['**/*.test.*', '**/*.spec.*'],
    tests: ['src/main/host-layer-dependencies.architecture.test.ts']
  },
  {
    reason: 'loads extractor resources and JSONL fixtures through the resolve() test helper',
    paths: ['packages/pdf-structure/resources/**', 'packages/pdf-structure/test/fixtures/**'],
    tests: ['packages/pdf-structure/test/*.test.ts']
  },
  {
    reason: 'loads translation fixtures through new URL(filename, import.meta.url) + readFileSync',
    paths: ['packages/pdf-translation/test/fixtures/**'],
    tests: [
      'packages/pdf-translation/test/*.test.ts',
      'packages/pdf-translation/test/reader/*.test.ts'
    ]
  },
  {
    reason: 'loads the PDFium engine through the resolve() test helper',
    paths: ['packages/pdf-translation/resources/pdfium.mjs'],
    tests: [
      'packages/pdf-translation/test/*.test.ts',
      'packages/pdf-translation/test/reader/*.test.ts'
    ]
  },
  {
    reason: 'copies the locator into a temporary package root before importing it',
    paths: ['packages/open-science/locate-backend.mjs'],
    tests: ['packages/open-science/locate-backend.test.ts']
  }
]

export function createFileTestPlan(
  changes,
  {
    source,
    reverse,
    classify = classifyChanges,
    boundaries = testBoundaries,
    readers = dynamicReaders
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
    const playwright = playwrightReaderTests(change.path)
    if (playwright) {
      for (const test of playwright) selected.add(test)
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
      for (const reader of readers) {
        const matches = (patterns = []) => patterns.some((pattern) => matchesPath(path, pattern))
        if (!matches(reader.paths) || matches(reader.exclude)) continue
        const readerTests = tests.filter((test) => reader.tests.some((p) => matchesPath(test, p)))
        for (const test of readerTests) selected.add(test)
        reasons.push(`${path} -> ${reader.reason} -> ${readerTests.length} tests`)
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
  const summary = {
    module: { mode: modulePlan.mode, tests: modulePlan.testFiles.length },
    file: { mode: filePlan.mode, tests: filePlan.testFiles.length }
  }
  if (modulePlan.mode !== 'selective' || filePlan.mode !== 'selective')
    return { status: 'not-comparable', ...summary, missing: [], extra: [], unresolved: [] }
  const fileTests = new Set(filePlan.testFiles)
  const moduleTests = new Set(modulePlan.testFiles)
  const evidence = (test) => {
    const found = []
    for (const id of modulePlan.modules ?? []) {
      const module = manifest.modules[id]
      if ((module.derivedConsumerTests ?? []).includes(test)) found.push(`${id}:derived`)
      else
        for (const kind of ['owner', 'contract', 'consumer'])
          if ((module.testFiles[kind] ?? []).includes(test)) found.push(`${id}:${kind}`)
    }
    return found.length ? found : ['direct']
  }
  return {
    status: 'compared',
    ...summary,
    missing: modulePlan.testFiles
      .filter((test) => !fileTests.has(test))
      .map((test) => ({ test, evidence: evidence(test) })),
    extra: filePlan.testFiles.filter((test) => !moduleTests.has(test)),
    unresolved: filePlan.unresolved
  }
}

// Reverse runtime import graph built from the working tree — the same source the module planner
// sees when run in CI (the checked-out merge commit on pull_request, HEAD locally).
export function workingTreeGraph(cwd = process.cwd()) {
  const source = workingTreeSource(cwd)
  const runtime = Object.entries(
    JSON.parse(source.read('scripts/ci/module-runtime-consumers.json') ?? '{}')
  )
  return { source, reverse: consumerDependencyGraph(source, runtime).reverse }
}

// Reverse runtime import graph of a committed revision, read from Git objects.
// Use for iterating over historical commits; for live comparisons use workingTreeGraph().
export function revisionGraph(revision, cwd = process.cwd()) {
  const source = sourceSnapshot(revision, cwd)
  const runtime = Object.entries(
    JSON.parse(source.read('scripts/ci/module-runtime-consumers.json') ?? '{}')
  )
  return { source, reverse: consumerDependencyGraph(source, runtime).reverse }
}

// Both planners read the same resolved inputs and the same checkout: the module plan is exactly
// what `affected` executes. By default both see the working tree (merge checkout in CI, HEAD locally).
export async function compareRevisionRange(
  base,
  head,
  { cwd = process.cwd(), graph = workingTreeGraph(cwd), ...options } = {}
) {
  const resolved = await resolveAffectedTestPlan(base, head, { cwd, ...options })
  const registration = {
    moduleManifest: resolved.manifest,
    registrationModules: resolved.registrationModules,
    registrationOnly: resolved.registrationOnly
  }
  const filePlan = resolved.registrationOnly
    ? { mode: 'selective', testFiles: [], unresolved: [], reasonChains: [] }
    : createFileTestPlan(resolved.changes, {
        ...graph,
        classify: (changes) => classifyChanges(changes, undefined, registration)
      })
  return compareTestPlans(resolved.plan, filePlan, resolved.manifest)
}

// Local evidence over recent first-parent history. One HEAD graph for every commit keeps the
// file plan comparable; the module plan resolves each commit against its parent.
export async function compareRecentCommits({ count = 30, ref = 'HEAD', cwd = process.cwd() } = {}) {
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const graph = revisionGraph(ref, cwd)
  const results = []
  for (const commit of git('rev-list', '--first-parent', `--max-count=${count}`, ref)
    .trim()
    .split('\n')) {
    results.push({
      commit: commit.slice(0, 10),
      subject: git('log', '-1', '--format=%s', commit).trim(),
      ...(await compareRevisionRange(`${commit}^`, commit, { cwd, graph }))
    })
  }
  return results
}

const listLimit = 25

export function formatFileTestImpactReport(report) {
  const lines = [
    '## File-level test impact (advisory)',
    '',
    '| Planner | Mode | Tests |',
    '| --- | --- | --- |',
    `| Module (runs today) | ${report.module.mode} | ${report.module.tests} |`,
    `| File (shadow) | ${report.file.mode} | ${report.file.tests} |`,
    ''
  ]
  if (report.status !== 'compared') {
    lines.push('Not comparable: at least one planner runs the complete suite.', '')
    return lines.join('\n')
  }
  const section = (title, entries) => {
    lines.push(`### ${title} (${entries.length})`, '')
    if (!entries.length) lines.push('_none_')
    for (const entry of entries.slice(0, listLimit)) lines.push(`- ${entry}`)
    if (entries.length > listLimit)
      lines.push(`- … ${entries.length - listLimit} more in the artifact`)
    lines.push('')
  }
  section(
    'Selected only by the module planner',
    report.missing.map(({ test, evidence }) => `\`${test}\` — ${evidence.join(', ')}`)
  )
  section(
    'Selected only by the file planner',
    report.extra.map((test) => `\`${test}\``)
  )
  if (report.unresolved.length)
    section(
      'Changed paths absent from the head snapshot',
      report.unresolved.map((path) => `\`${path}\``)
    )
  return lines.join('\n')
}

function argumentValue(arguments_, name) {
  const index = arguments_.indexOf(name)
  return index === -1 ? undefined : arguments_[index + 1]
}

export async function runFileTestImpactCli(
  arguments_ = process.argv.slice(2),
  { cwd = process.cwd(), environment = process.env, stdout = process.stdout } = {}
) {
  const [command] = arguments_
  if (command === 'recent') {
    const count = Number(arguments_[1] ?? 30)
    stdout.write(JSON.stringify(await compareRecentCommits({ count, cwd }), null, 2) + '\n')
    return 0
  }
  if (command !== 'compare') throw new Error(`Unknown file test-impact command: ${command}`)
  const base = argumentValue(arguments_, '--base')
  const head = argumentValue(arguments_, '--head')
  if (!base || !head) throw new Error('--base and --head are required')
  const tier = argumentValue(arguments_, '--tier') ?? 'queue'
  if (!['pr', 'queue'].includes(tier)) throw new Error('--tier must be pr or queue')
  const report = { base, head, tier, ...(await compareRevisionRange(base, head, { cwd, tier })) }
  const output = argumentValue(arguments_, '--output')
  if (output) writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  const markdown = formatFileTestImpactReport(report)
  stdout.write(markdown + '\n')
  if (environment.GITHUB_STEP_SUMMARY)
    appendFileSync(environment.GITHUB_STEP_SUMMARY, markdown + '\n')
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runFileTestImpactCli()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
