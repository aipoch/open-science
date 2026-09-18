/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyChanges, parseNameStatus } from './classify-pr-changes.mjs'
import { loadModuleImpactManifest } from './load-module-impact.mjs'
import { validateModuleImpactManifest } from './validate-module-impact.mjs'

const defaultManifest = loadModuleImpactManifest()
const testKinds = ['owner', 'contract', 'consumer']

function sorted(values) {
  return [...new Set(values)].sort()
}

function declaredTests(module) {
  return testKinds.flatMap((kind) => module.testFiles[kind])
}

export function modulesForPath(manifest, path) {
  const owners = Object.entries(manifest.modules)
    .filter(([, module]) => module.ownerPaths.includes(path))
    .map(([moduleId]) => moduleId)
  if (owners.length > 0) return owners
  const explicit = Object.entries(manifest.modules)
    .filter(([, module]) =>
      [...module.ownerPaths, ...module.interfacePaths, ...declaredTests(module)].includes(path)
    )
    .map(([moduleId]) => moduleId)
  if (explicit.length > 0 || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) return explicit
  // A declared owner test also identifies its colocated implementation. Consumer tests
  // cannot establish ownership; unmatched implementations still fall back to full.
  const ownerTest = path.replace(/(\.[cm]?[jt]sx?)$/, '.test$1')
  return Object.entries(manifest.modules)
    .filter(([, module]) => module.testFiles.owner.includes(ownerTest))
    .map(([moduleId]) => moduleId)
}

function expandConsumers(manifest, seeds) {
  const selected = new Set()
  const visit = (moduleId) => {
    if (selected.has(moduleId)) return
    selected.add(moduleId)
    for (const consumer of manifest.modules[moduleId].consumerModules) visit(consumer)
  }
  for (const seed of seeds) visit(seed)
  return Object.keys(manifest.modules).filter((moduleId) => selected.has(moduleId))
}

function selectivePlan(manifest, moduleIds, reasonChains, graph) {
  const modules = Object.keys(manifest.modules).filter((moduleId) => moduleIds.includes(moduleId))
  return {
    mode: 'selective',
    modules,
    testFiles: sorted([
      ...modules.flatMap((moduleId) => declaredTests(manifest.modules[moduleId])),
      ...graph.testFiles
    ]),
    capabilityOverlays: sorted(
      modules.flatMap((moduleId) => manifest.modules[moduleId].capabilityOverlays)
    ),
    fallbackCapabilities: sorted(
      modules.map((moduleId) => manifest.modules[moduleId].fallbackCapability)
    ),
    graphStatus: graph.status,
    graphReason: graph.reason,
    reasonChains: sorted(reasonChains)
  }
}

function fullPlan(reason) {
  return {
    mode: 'full',
    modules: [],
    testFiles: [],
    capabilityOverlays: [],
    fallbackCapabilities: [],
    graphStatus: 'not-used',
    graphReason: undefined,
    reasonChains: [reason]
  }
}

export function createModuleTestPlan(moduleId, manifest = defaultManifest) {
  validateModuleImpactManifest(manifest)
  if (!manifest.modules[moduleId]) throw new Error(`Unknown module: ${moduleId}`)
  if (manifest.modules[moduleId].fullTestReason) {
    return fullPlan(`${moduleId} -> ${manifest.modules[moduleId].fullTestReason} -> full`)
  }
  return selectivePlan(manifest, [moduleId], [`module ${moduleId} -> declared tests`], {
    status: 'not-requested',
    testFiles: []
  })
}

export function createAffectedTestPlan(changes, graph, manifest = defaultManifest) {
  validateModuleImpactManifest(manifest)
  const changePlan = classifyChanges(changes)
  if (changePlan.mode === 'full') {
    const decisiveReasons = changePlan.reasonChains.filter((reason) => reason.endsWith('-> full'))
    return fullPlan(
      `change-impact classifier -> ${(decisiveReasons.length > 0 ? decisiveReasons : changePlan.reasonChains).join('; ')}`
    )
  }

  const seeds = new Set()
  const directTests = new Set()
  const testModules = new Set()
  const reasons = []
  for (const change of changes) {
    const pathPlan = classifyChanges([change])
    if (pathPlan.roots.includes('ci_workflow_contract_test')) {
      directTests.add(change.path)
      reasons.push(`${change.path} -> workflow contract -> direct execution`)
      continue
    }
    if (pathPlan.lanes.includes('docs') && !pathPlan.bundles.includes('unit')) {
      reasons.push(`${change.path} -> documentation lane -> no module tests`)
      continue
    }
    // Browser fixtures/specs execute in the complete browser lane, not Vitest. This explicit
    // owner must remain selected in mixed diffs; unknown E2E helpers still fall back to full.
    if (pathPlan.roots.includes('renderer_browser_e2e') && !pathPlan.bundles.includes('unit')) {
      reasons.push(`${change.path} -> renderer browser E2E lane -> no module tests`)
      continue
    }
    for (const path of [change.path, change.previousPath].filter(Boolean)) {
      const matchedModules = modulesForPath(manifest, path)
      if (matchedModules.length === 0) return fullPlan(`${path} -> unknown module owner -> full`)
      // Some test files also export shared certification helpers. Their explicit interface
      // registration keeps downstream test consumers in the plan.
      const sharedTest = matchedModules.some((moduleId) =>
        manifest.modules[moduleId].interfacePaths.includes(path)
      )
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path) && !sharedTest) {
        directTests.add(path)
        for (const moduleId of matchedModules) testModules.add(moduleId)
        reasons.push(`${path} -> registered test -> direct execution`)
        continue
      }
      for (const moduleId of matchedModules) {
        seeds.add(moduleId)
        reasons.push(`${path} -> ${moduleId}`)
      }
    }
  }

  const modules = expandConsumers(manifest, [...seeds])
  const fullModule = [...modules, ...testModules].find(
    (moduleId) => manifest.modules[moduleId].fullTestReason
  )
  if (fullModule) {
    return fullPlan(`${fullModule} -> ${manifest.modules[fullModule].fullTestReason} -> full`)
  }
  for (const moduleId of seeds) {
    const visit = (consumer, chain) => {
      reasons.push([...chain, consumer].join(' -> '))
      for (const next of manifest.modules[consumer].consumerModules) {
        visit(next, [...chain, consumer])
      }
    }
    for (const consumer of manifest.modules[moduleId].consumerModules) {
      visit(consumer, [moduleId])
    }
  }
  const plan = selectivePlan(manifest, [...modules, ...testModules], reasons, graph)
  // Editing a registered test runs that test; changing implementations or shared fixtures
  // still runs every declared owner, contract and transitive consumer test.
  plan.testFiles = sorted([
    ...modules.flatMap((moduleId) => declaredTests(manifest.modules[moduleId])),
    ...directTests,
    ...graph.testFiles
  ])
  return plan
}

function isCurrentGraph(status) {
  const pending = status.pendingChanges ?? {}
  return (
    status.initialized === true &&
    status.worktreeMismatch == null &&
    status.index?.state === 'complete' &&
    status.index?.reindexRecommended !== true &&
    ['added', 'modified', 'removed'].every((kind) => (pending[kind] ?? 0) === 0)
  )
}

function isPortableVitestFile(path) {
  return (
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !/^[A-Za-z]:/.test(path) &&
    !path.split('/').includes('..') &&
    !path.startsWith('e2e/') &&
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
  )
}

export function collectCodeGraphTests(
  paths,
  { cwd = process.cwd(), execute = execFileSync, pathExists = existsSync } = {}
) {
  try {
    const status = JSON.parse(
      execute('codegraph', ['status', '--json', cwd], { cwd, encoding: 'utf8' })
    )
    if (!isCurrentGraph(status)) {
      const reason = status.worktreeMismatch
        ? 'worktree index mismatch'
        : 'index is missing, stale, incomplete, or has pending changes'
      return { status: 'unavailable-manifest-only', reason, testFiles: [] }
    }
    if (paths.length === 0) return { status: 'current', testFiles: [] }

    const result = JSON.parse(
      execute('codegraph', ['affected', '--json', '--depth', '2', ...paths], {
        cwd,
        encoding: 'utf8'
      })
    )
    const testFiles = sorted(
      (result.affectedTests ?? []).filter(
        (path) => isPortableVitestFile(path) && pathExists(resolve(cwd, path))
      )
    )
    return { status: 'current', testFiles }
  } catch (error) {
    return {
      status: 'unavailable-manifest-only',
      reason: error instanceof Error ? error.message.split('\n', 1)[0] : String(error),
      testFiles: []
    }
  }
}

function changesFromGit(base, head, { cwd = process.cwd(), execute = execFileSync } = {}) {
  const mergeBase = execute('git', ['merge-base', base, head], { cwd, encoding: 'utf8' }).trim()
  const diff = execute('git', ['diff', '--name-status', '-z', mergeBase, head], { cwd })
  return parseNameStatus(diff.toString('utf8'))
}

export function formatModuleTestPlan(plan) {
  const list = (values) => (values.length === 0 ? '_none_' : values.join(', '))
  const tests =
    plan.mode === 'full'
      ? '- _complete Vitest suite (no path filter)_'
      : plan.testFiles.map((path) => `- ${path}`).join('\n')
  const reasons = plan.reasonChains.map((reason) => `- ${reason}`).join('\n')
  return `Module test-impact plan\n\nMode: ${plan.mode}\nModules: ${list(plan.modules)}\nCodeGraph: ${plan.graphStatus}${plan.graphReason ? ` (${plan.graphReason})` : ''}\nCapability overlays: ${list(plan.capabilityOverlays)}\nFallback capabilities: ${list(plan.fallbackCapabilities)}\n\nReason chains:\n${reasons}\n\nVitest files:\n${tests}\n`
}

export function executeModuleTestPlan(
  plan,
  {
    cwd = process.cwd(),
    spawn = spawnSync,
    environment = process.env,
    platform = process.platform,
    nodeExecutable = process.execPath,
    testArguments = []
  } = {}
) {
  process.stdout.write(formatModuleTestPlan(plan))
  const mergeReports = testArguments.some(
    (argument) => argument === '--merge-reports' || argument.startsWith('--merge-reports=')
  )
  const shard = testArguments.some(
    (argument) => argument === '--shard' || argument.startsWith('--shard=')
  )
  if (!mergeReports && !shard && plan.mode === 'selective' && plan.testFiles.length === 0) return 0
  // Report merging executes no tests and needs no generated Prisma client from npm's pretest.
  const npmArguments = mergeReports
    ? ['exec', '--', 'vitest', 'run', ...testArguments]
    : [
        'test',
        '--',
        ...testArguments,
        // An empty shard must emit its blob without falling back to unfiltered discovery.
        ...(plan.mode === 'full'
          ? []
          : plan.testFiles.length
            ? plan.testFiles
            : ['__no_selected_module_tests__'])
      ]
  const npmExecPath = environment.npm_execpath
  if (platform === 'win32' && !npmExecPath) {
    throw new Error(
      'npm_execpath is unavailable on Windows; run this command through npm run test:module or npm run test:affected'
    )
  }
  const command = npmExecPath ? nodeExecutable : 'npm'
  const arguments_ = npmExecPath ? [npmExecPath, ...npmArguments] : npmArguments
  const result = spawn(command, arguments_, { cwd, env: environment, stdio: 'inherit' })
  if (result.error) throw result.error
  return result.status ?? 1
}

function argumentValue(arguments_, name) {
  const index = arguments_.indexOf(name)
  return index === -1 ? undefined : arguments_[index + 1]
}

export function runModuleTestCli(arguments_ = process.argv.slice(2), options = {}) {
  const separator = arguments_.indexOf('--')
  const forwardedArguments = separator === -1 ? [] : arguments_.slice(separator + 1)
  if (separator !== -1) arguments_ = arguments_.slice(0, separator)
  const testArguments = [...(options.testArguments ?? []), ...forwardedArguments]
  const [command] = arguments_
  if (command === 'module') {
    const moduleId = arguments_[1]
    if (!moduleId || moduleId.startsWith('--')) throw new Error('Module id is required')
    const plan = createModuleTestPlan(moduleId)
    return executeModuleTestPlan(plan, { ...options, testArguments })
  }
  if (command !== 'affected') throw new Error(`Unknown module test-impact command: ${command}`)

  const base = argumentValue(arguments_, '--base')
  const head = argumentValue(arguments_, '--head')
  if (!base || !head) throw new Error('--base and --head are required')
  const coverageChanged = argumentValue(arguments_, '--coverage-changed')
  if (arguments_.includes('--coverage-changed') && !coverageChanged) {
    throw new Error('--coverage-changed requires a Git revision')
  }
  const changes = changesFromGit(base, head, options)
  const paths = sorted(
    changes.flatMap(({ path, previousPath }) => [path, previousPath].filter(Boolean))
  )
  const graph = collectCodeGraphTests(paths, options)
  const plan = createAffectedTestPlan(changes, graph)
  if (arguments_.includes('--explain')) {
    process.stdout.write(formatModuleTestPlan(plan))
    return 0
  }
  const environment = coverageChanged
    ? {
        ...(options.environment ?? process.env),
        VITEST_CHANGED_COVERAGE_THRESHOLDS: '1'
      }
    : options.environment
  // CI checks out a synthetic merge commit. Vitest's coverage.changed compares against
  // checkout HEAD, which also includes newer base-branch changes outside this PR's test plan.
  const coverageChanges = coverageChanged
    ? coverageChanged === base
      ? changes
      : changesFromGit(coverageChanged, head, options)
    : []
  const coveragePaths = sorted(
    coverageChanges
      .filter(({ path, status }) => status !== 'deleted' && /^src\/.*\.tsx?$/.test(path))
      .map(({ path }) => path)
  )
  return executeModuleTestPlan(plan, {
    ...options,
    environment,
    testArguments: coverageChanged
      ? [
          '--coverage',
          ...(coveragePaths.length > 0 ? coveragePaths : ['__no_changed_sources__']).map(
            (path) => `--coverage.include=${path}`
          ),
          ...testArguments
        ]
      : testArguments
  })
}

const isDirectExecution =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectExecution) {
  try {
    process.exitCode = runModuleTestCli()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
