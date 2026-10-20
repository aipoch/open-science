/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { appendFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const packageTestRegistryPath = 'scripts/ci/package-test-boundaries.json'
const rootPattern = /^packages\/[a-z0-9][a-z0-9-]*$/
// These inputs can change package compilation, discovery or the trusted package-test graph.
// Keep this list explicit: unrelated scripts and regression data must not fan out every package.
const packageGlobalInput =
  /^(?:package(?:-lock)?\.json$|\.npmrc$|\.nvmrc$|(?:vitest|vite|electron|tsconfig)[^/]*|test\/config\/|patches\/|build\/|resources\/|scripts\/(?:build-dev-packages|check-packages|check-package-isolation|check-(?:connector|diagnostics|environment|notebook)-packages|package-verification-plan)(?:\.[^/]+)?$|scripts\/ci\/(?:npm-ci|package-test-|module-test-impact\.)|\.github\/actions\/select-package-tests\/|\.github\/workflows\/(?:package-test-policy-dry-run|pr-gate)\.yml$)/

// Fixture records and unrelated scripts are test evidence for another lane. They do not alter
// the independently published package contracts, so changing them must not run every package.
const packageExemptInput = /^(?:test\/fixtures\/|scripts\/)/

// These packages run through module/host contracts and dedicated platform or CLI lanes.
// They are downstream of independent libraries, never inputs to those libraries' suites.
export const dedicatedPackageTestRoots = [
  'packages/notebook-network-sandbox',
  'packages/open-science',
  'packages/credential-identity-probe-native',
  'packages/process-tree-native',
  'packages/safe-file-publisher-native'
]

// These are consumer scenarios, not another dependency graph. Prerequisites come from the registry.
export const verificationFamilies = [
  { script: 'check:test-impact-package', packages: ['test-impact'] },
  { script: 'check:providers-package', packages: ['providers'] },
  { script: 'check:resilient-download-package', packages: ['resilient-download'] },
  { script: 'check:durable-files-package', packages: ['durable-files', 'skills', 'specialists'] },
  {
    script: 'check:connector-packages',
    packages: ['connector-core', 'connector-builtins', 'connector-mcp-client']
  },
  { script: 'check:diagnostics-package', packages: ['diagnostics'] },
  { script: 'check:environment-package', packages: ['environment'] },
  { script: 'check:compute-package', packages: ['compute'] },
  { script: 'check:reproducibility-package', packages: ['reproducibility'] },
  {
    script: 'check:notebook-packages',
    packages: ['notebook-syntax', 'notebook-code-risk', 'notebook-analysis']
  },
  {
    script: 'check:package-isolation',
    packages: [
      'pdf-structure',
      'pdf-translation',
      'literature-citations',
      'journal-catalog',
      'literature-discovery',
      'literature-screening',
      'literature-library',
      'literature-reading'
    ]
  }
]

// Installed consumers do not use host routing, Electron builds or browser/E2E configuration.
const verificationSharedInput =
  /^(?:package(?:-lock)?\.json$|\.npmrc$|\.nvmrc$|vitest[^/]*|tsconfig[^/]*|patches\/|scripts\/(?:(?:check-packages|package-verification-plan|build-dev-packages|build-packages)\.mjs$|ci\/(?:package-test-boundaries\.json$|(?:package-test-impact|npm-ci)\.mjs$))|\.github\/actions\/(?:select-package-tests|verify-packages)\/)/
const verificationUnrelatedInput =
  /^(?:src\/|docs\/|e2e\/|\.github\/|test\/(?:config|fixtures)\/|scripts\/runtime-archives\.mjs$|scripts\/ci\/windows-test-sequencer\.ts$|scripts\/ci\/(?:module-|classify-pr-|evaluate-pr-|check-module-|audit-module-|consumer-retirement)|(?:electron|vite\.)[^/]*|[^/]+\.md$)|\.test\.[cm]?[jt]sx?$/

function verificationPaths(paths, roots) {
  return paths.flatMap((path) => {
    const family = verificationFamilies.find(({ script }) =>
      [
        `scripts/${script.replace(':', '-')}.mjs`,
        `scripts/${script.replace(':', '-')}.test.ts`
      ].includes(path)
    )
    if (family) {
      // An older registry must not silently discard a newly registered verifier consumer.
      return family.packages.every((name) => roots.includes(`packages/${name}`))
        ? family.packages.map((name) => `packages/${name}/<installed-consumer-verifier>`)
        : [path]
    }
    if (path.startsWith('packages/') || verificationSharedInput.test(path)) return [path]
    return verificationUnrelatedInput.test(path) ? [] : [path]
  })
}

export function validatePackageTestRegistry(registry) {
  if (registry?.schemaVersion !== 1 || !Array.isArray(registry.packages))
    throw new Error('Invalid package test registry')
  const roots = new Set()
  for (const entry of registry.packages) {
    if (
      !rootPattern.test(entry.root) ||
      roots.has(entry.root) ||
      !Array.isArray(entry.dependencies)
    )
      throw new Error('Invalid or duplicate package test root')
    roots.add(entry.root)
  }
  for (const entry of registry.packages) {
    if (
      new Set(entry.dependencies).size !== entry.dependencies.length ||
      entry.dependencies.some((root) => !roots.has(root) || root === entry.root)
    )
      throw new Error(`Invalid package test dependencies: ${entry.root}`)
  }
  // Cycles violate the declared upstream/downstream package relationship.
  const active = new Set(),
    visited = new Set()
  const visit = (root) => {
    if (active.has(root)) throw new Error('Cyclic package test dependencies')
    if (visited.has(root)) return
    active.add(root)
    registry.packages.find((entry) => entry.root === root).dependencies.forEach(visit)
    active.delete(root)
    visited.add(root)
  }
  roots.forEach(visit)
  return registry
}

function validateVerificationRoots(selectedRoots, excludedRoots) {
  for (const roots of [selectedRoots, excludedRoots]) {
    if (
      roots !== undefined &&
      (!Array.isArray(roots) ||
        roots.some(
          (root) => typeof root !== 'string' || (root !== 'packages' && !rootPattern.test(root))
        ))
    )
      throw new Error('Invalid package verification roots')
  }
}

// Build upstream tarballs as prerequisites, but only run unit suites selected by trusted policy.
export function notebookPackageVerificationPlan(selectedRoots, excludedRoots) {
  const names = ['notebook-syntax', 'notebook-code-risk', 'notebook-analysis']
  validateVerificationRoots(selectedRoots, excludedRoots)
  const tests = names.filter(
    (name) =>
      selectedRoots === undefined ||
      selectedRoots.includes('packages') ||
      selectedRoots.includes(`packages/${name}`) ||
      // Newly introduced packages are absent from an older trusted registry. Silence is
      // not exclusion evidence: verify them until the approved registry covers them.
      (excludedRoots !== undefined && !excludedRoots.includes(`packages/${name}`))
  )
  const builds = names.filter(
    (name) => tests.includes(name) || (name === 'notebook-syntax' && tests.length > 0)
  )
  return { builds, tests }
}

// A new package is verified until the trusted registry explicitly excludes it.
export function environmentPackageVerificationPlan(selectedRoots, excludedRoots) {
  validateVerificationRoots(selectedRoots, excludedRoots)
  const excluded =
    selectedRoots !== undefined &&
    !selectedRoots.includes('packages') &&
    !selectedRoots.includes('packages/environment') &&
    excludedRoots?.includes('packages/environment')
  return excluded
    ? { builds: [], tests: [] }
    : { builds: ['diagnostics', 'environment'], tests: ['environment'] }
}

export function createPackageTestPlan(paths, registry, { verification = false } = {}) {
  const { packages } = validatePackageTestRegistry(registry)
  const roots = packages.map((entry) => entry.root)
  const reasons = []
  const changed = new Set()
  const inputs = verification ? verificationPaths(paths, roots) : paths
  for (const path of inputs) {
    const owner = roots.find((root) => path.startsWith(root + '/'))
    if (owner) {
      changed.add(owner)
      reasons.push(`${path} -> ${owner}`)
    } else if (packageGlobalInput.test(path)) {
      return {
        selected: roots,
        excluded: [],
        reasons: [`${path} -> package compilation, discovery or policy input -> all package tests`]
      }
    } else if (dedicatedPackageTestRoots.some((root) => path.startsWith(root + '/'))) {
      reasons.push(`${path} -> dedicated module/host lane -> independent package suites excluded`)
    } else if (!verification && packageExemptInput.test(path)) {
      reasons.push(`${path} -> non-package test or script input -> package unit tests excluded`)
    } else if (!/^(?:src\/|docs\/|[^/]+\.md$)/.test(path)) {
      return {
        selected: roots,
        excluded: [],
        reasons: [
          `${path} -> shared or unknown input -> all ${verification ? 'installed consumers' : 'package tests'}`
        ]
      }
    }
  }
  let expanded = true
  while (expanded) {
    expanded = false
    for (const entry of packages) {
      const upstream = entry.dependencies.find((root) => changed.has(root))
      if (!changed.has(entry.root) && upstream) {
        changed.add(entry.root)
        reasons.push(`${upstream} -> downstream package ${entry.root}`)
        expanded = true
      }
    }
  }
  if (verification && inputs.length === 0)
    reasons.push('no package or installed-consumer inputs changed')
  const excluded = roots.filter((root) => !changed.has(root))
  reasons.push(
    ...excluded.map(
      (root) =>
        `${root} -> unchanged upstream -> ${verification ? 'installed consumers' : 'package unit tests'} excluded`
    )
  )
  return { selected: roots.filter((root) => changed.has(root)), excluded, reasons }
}

// Only CI supplies this value. Local npm test keeps the complete portable suite.
function packageRootsFromEnvironment(key, env, allowAll = false) {
  if (env.VITEST_PORTABLE_CI !== '1' || !env[key]) return []
  const roots = JSON.parse(env[key])
  if (
    !Array.isArray(roots) ||
    roots.some(
      (root) =>
        typeof root !== 'string' || (!rootPattern.test(root) && !(allowAll && root === 'packages'))
    )
  )
    throw new Error('Invalid CI package test roots')
  return roots
}

export function packageTestExcludePatterns(env = process.env) {
  return packageRootsFromEnvironment('OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS', env).map(
    (root) => `${root}/**`
  )
}

export function packageTestSelectedRoots(env = process.env) {
  return packageRootsFromEnvironment('OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS', env, true)
}

export function packageTestPlanFromRevisions(
  base,
  head,
  trustedBase = base,
  { cwd = process.cwd(), execute = execFileSync, verification = false } = {}
) {
  const git = (...args) =>
    execute('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).toString()
  try {
    const registry = JSON.parse(git('show', `${trustedBase}:${packageTestRegistryPath}`))
    validatePackageTestRegistry(registry)
    const manifests = new Map(
      registry.packages.map((entry) => [
        entry.root,
        JSON.parse(git('show', `${trustedBase}:${entry.root}/package.json`))
      ])
    )
    for (const entry of registry.packages) {
      const manifest = manifests.get(entry.root)
      if (!manifest.name || !manifest.scripts?.test)
        throw new Error(`Package lacks an independent test command: ${entry.root}`)
      const dependencies = {
        ...manifest.dependencies,
        ...manifest.peerDependencies,
        ...manifest.devDependencies,
        ...manifest.optionalDependencies
      }
      for (const [root, upstream] of manifests) {
        if (
          root !== entry.root &&
          Object.hasOwn(dependencies, upstream.name) &&
          !entry.dependencies.includes(root)
        )
          throw new Error(`Missing upstream dependency: ${entry.root} -> ${root}`)
      }
    }
    // Compare merge-base through head, including both names of a rename/deletion.
    const mergeBase = git('merge-base', base, head).trim()
    const paths = git('diff', '--name-only', '--no-renames', '-z', mergeBase, head)
      .split('\0')
      .filter(Boolean)
    // A downstream source edit between the PR base and its merge checkout may affect an
    // upstream package too. Include that delta when testing the synthetic merge checkout.
    paths.push(
      ...git('diff', '--name-only', '--no-renames', '-z', head, 'HEAD').split('\0').filter(Boolean)
    )
    return createPackageTestPlan([...new Set(paths)], registry, { verification })
  } catch (error) {
    // Missing/invalid trusted policy or Git evidence may never skip tests.
    return {
      selected: ['packages'],
      excluded: [],
      reasons: [
        `package test evidence unavailable -> no exclusions: ${error.message.split('\n')[0]}`
      ]
    }
  }
}

export function runPackageTestCli(args = process.argv.slice(2), env = process.env) {
  const value = (flag) => args[args.indexOf(flag) + 1]
  if (!args.includes('--base') || !args.includes('--head'))
    throw new Error('--base and --head are required')
  const plan = packageTestPlanFromRevisions(
    value('--base'),
    value('--head'),
    args.includes('--trusted-base') ? value('--trusted-base') : value('--base'),
    { verification: args.includes('--verification') }
  )
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n')
  if (args.includes('--verification') && env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `## Installed package selection\n\nSelected: ${plan.selected.join(', ') || 'none'}\n\n${plan.reasons.map((reason) => `- ${reason}`).join('\n')}\n`
    )
  if (args.includes('--github-env')) {
    if (!env.GITHUB_ENV) throw new Error('GITHUB_ENV is required')
    appendFileSync(
      env.GITHUB_ENV,
      `OPEN_SCIENCE_CI_EXCLUDED_PACKAGE_ROOTS=${JSON.stringify(plan.excluded)}\n` +
        `OPEN_SCIENCE_CI_SELECTED_PACKAGE_ROOTS=${JSON.stringify(plan.selected)}\n`
    )
  }
  return plan
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  runPackageTestCli()
